using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class SetupProviderRequestException(
    string code,
    string message,
    int statusCode,
    int? upstreamStatus = null
) : Exception(message)
{
    internal string Code { get; } = code;
    internal int StatusCode { get; } = statusCode;
    internal int? UpstreamStatus { get; } = upstreamStatus;
}

internal static class SetupProviderRequests
{
    internal const int ListTimeoutMs = 10_000;
    internal const int ListMaxResponseBytes = 1024 * 1024;
    internal const int ListMaxModels = 1000;
    private const int MaxProviderTypeLength = 128;
    private const int MaxBaseUrlLength = 4096;
    private const int MaxApiKeyLength = 16_384;
    private const int MaxHeaderCount = 64;
    private const int MaxHeaderNameLength = 256;
    private const int MaxHeaderValueLength = 8192;
    private const int MaxModelIdLength = 512;

    private static readonly HashSet<string> OpenAiProviderTypes = new(StringComparer.Ordinal)
    {
        "openai",
        "openai-responses",
        "openai-ws",
        "openai-completions",
    };

    internal static bool IsSupportedProviderType(string providerType) =>
        OpenAiProviderTypes.Contains(providerType) || providerType == "anthropic";

    internal static JsonObject ParseListRequest(JsonObject? input)
    {
        if (input is null)
            throw Invalid("Provider connection must be an object.");
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "providerType",
            "baseUrl",
            "apiKey",
            "extraHeaders",
        };
        if (input.Any(pair => !allowed.Contains(pair.Key)))
            throw Invalid("Provider connection contains an unknown field.");
        var providerType = RequiredString(
            input["providerType"],
            "providerType",
            MaxProviderTypeLength
        );
        var result = new JsonObject { ["providerType"] = providerType };
        AddOptionalString(result, input, "baseUrl", MaxBaseUrlLength);
        AddOptionalString(result, input, "apiKey", MaxApiKeyLength);
        if (input.ContainsKey("extraHeaders"))
            result["extraHeaders"] = ParseHeaders(input["extraHeaders"]);
        return result;
    }

    internal static ConcreteHostModel ResolveTransientModel(
        JsonObject provider,
        JsonObject app,
        string providerKey,
        string modelId
    )
    {
        var providerType = HostModels.Text(provider, "providerType") ?? "openai-completions";
        if (!IsSupportedProviderType(providerType))
            throw new SetupProviderRequestException(
                "unsupported-provider",
                "Model testing is not supported for this provider type.",
                400
            );
        var root = new JsonObject
        {
            ["default"] = providerKey.Length == 0 ? "setup" : providerKey,
            ["providers"] = new JsonObject { [providerKey] = provider },
        };
        var catalog = HostModels.Parse(root, app);
        var key =
            provider["models"] is JsonArray models && models.Count > 1
                ? providerKey + "/" + modelId
                : providerKey;
        return catalog.Resolve(key);
    }

    internal static Uri ResolveListEndpoint(ConcreteHostModel model)
    {
        if (!IsSupportedProviderType(model.ProviderType))
            throw new SetupProviderRequestException(
                "unsupported-provider",
                "Model listing is not supported for this provider type.",
                400
            );
        Uri baseUri;
        try
        {
            baseUri = new Uri(model.BaseUrl ?? throw new UriFormatException(), UriKind.Absolute);
        }
        catch
        {
            throw Invalid("baseUrl must be an absolute HTTP(S) URL.");
        }
        if (
            baseUri.Scheme is not ("http" or "https")
            || !string.IsNullOrEmpty(baseUri.UserInfo)
            || !string.IsNullOrEmpty(baseUri.Query)
            || !string.IsNullOrEmpty(baseUri.Fragment)
        )
            throw Invalid(
                "baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment."
            );
        var root = baseUri.ToString().TrimEnd('/');
        return new Uri(
            OpenAiProviderTypes.Contains(model.ProviderType)
                ? root + "/models"
                : root + "/v1/models?limit=" + ListMaxModels,
            UriKind.Absolute
        );
    }

    internal static async Task<string[]> ListAsync(
        HttpClient http,
        ConcreteHostModel model,
        CancellationToken cancellationToken
    )
    {
        var endpoint = ResolveListEndpoint(model);
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.UserAgent.ParseAdd("foxwarm/" + ProductVersion.Value);
        if (OpenAiProviderTypes.Contains(model.ProviderType))
        {
            if (model.Token.Length > 0)
                SetHeader(request, "Authorization", "Bearer " + model.Token);
        }
        else
        {
            if (model.Token.Length > 0)
                SetHeader(request, "x-api-key", model.Token);
            SetHeader(request, "anthropic-version", "2023-06-01");
        }
        AddHeaders(request, model.Configuration["extraHeaders"] as JsonObject);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ListTimeoutMs);
        HttpResponseMessage response;
        try
        {
            response = await http.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    timeout.Token
                )
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SetupProviderRequestException(
                "timeout",
                "Provider model list request timed out.",
                504
            );
        }
        catch
        {
            throw new SetupProviderRequestException(
                "upstream",
                "Provider model list request failed.",
                502
            );
        }
        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                throw new SetupProviderRequestException(
                    "upstream",
                    $"Provider model list request failed ({(int)response.StatusCode}).",
                    502,
                    (int)response.StatusCode
                );
            }
            JsonNode? payload;
            try
            {
                payload = await ReadBoundedJsonAsync(response, timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new SetupProviderRequestException(
                    "timeout",
                    "Provider model list request timed out.",
                    504
                );
            }
            catch (SetupProviderRequestException)
            {
                throw;
            }
            catch
            {
                throw new SetupProviderRequestException(
                    "invalid-response",
                    "Provider returned an invalid model list response.",
                    502
                );
            }
            if (payload is not JsonObject root || root["data"] is not JsonArray data)
                throw new SetupProviderRequestException(
                    "invalid-response",
                    "Provider returned an invalid model list response.",
                    502
                );
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<string>();
            foreach (var item in data)
            {
                var id =
                    item is JsonObject obj
                    && obj["id"] is JsonValue value
                    && value.TryGetValue<string>(out var raw)
                        ? raw.Trim()
                        : "";
                if (id.Length == 0 || id.Length > MaxModelIdLength || !seen.Add(id))
                    continue;
                result.Add(id);
                if (result.Count >= ListMaxModels)
                    break;
            }
            return result.ToArray();
        }
    }

    private static async Task<JsonNode?> ReadBoundedJsonAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken
    )
    {
        if (response.Content.Headers.ContentLength is long length && length > ListMaxResponseBytes)
            throw new SetupProviderRequestException(
                "invalid-response",
                "Provider model list response is too large.",
                502
            );
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var buffer = new byte[8192];
        using var output = new MemoryStream();
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0)
                break;
            if (output.Length + read > ListMaxResponseBytes)
                throw new SetupProviderRequestException(
                    "invalid-response",
                    "Provider model list response is too large.",
                    502
                );
            output.Write(buffer, 0, read);
        }
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(output.ToArray());
        }
        catch (DecoderFallbackException)
        {
            throw new SetupProviderRequestException(
                "invalid-response",
                "Provider returned an invalid model list response.",
                502
            );
        }
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            throw new SetupProviderRequestException(
                "invalid-response",
                "Provider returned an invalid model list response.",
                502
            );
        }
    }

    private static void AddHeaders(HttpRequestMessage request, JsonObject? headers)
    {
        if (headers is null)
            return;
        foreach (var (name, value) in headers)
            SetHeader(request, name, SessionWait.Text(value) ?? "");
    }

    private static void SetHeader(HttpRequestMessage request, string name, string value)
    {
        if (request.Headers.TryAddWithoutValidation(name, value))
        {
            request.Headers.Remove(name);
            request.Headers.TryAddWithoutValidation(name, value);
            return;
        }
        request.Content ??= new ByteArrayContent([]);
        request.Content.Headers.Remove(name);
        request.Content.Headers.TryAddWithoutValidation(name, value);
    }

    private static void AddOptionalString(
        JsonObject result,
        JsonObject input,
        string key,
        int maxLength
    )
    {
        if (input[key] is null)
            return;
        if (input[key] is not JsonValue value || !value.TryGetValue<string>(out var raw))
            throw Invalid(key + " must be a string.");
        if (raw.Length > maxLength)
            throw Invalid(key + " is too long.");
        var trimmed = raw.Trim();
        if (trimmed.Length > 0)
            result[key] = trimmed;
    }

    private static JsonObject ParseHeaders(JsonNode? value)
    {
        if (value is not JsonObject headers)
            throw Invalid("extraHeaders must be an object.");
        if (headers.Count > MaxHeaderCount)
            throw Invalid("extraHeaders contains too many entries.");
        var result = new JsonObject();
        foreach (var (name, raw) in headers)
        {
            if (name.Trim().Length == 0 || name.Length > MaxHeaderNameLength)
                throw Invalid("extraHeaders contains an invalid header name.");
            if (
                raw is not JsonValue scalar
                || !scalar.TryGetValue<string>(out var text)
                    && !scalar.TryGetValue<bool>(out _)
                    && !scalar.TryGetValue<double>(out _)
            )
                throw Invalid("extraHeaders values must be scalar.");
            var valueText = SessionWait.Text(raw) ?? raw!.ToJsonString().Trim('"');
            if (valueText.Length > MaxHeaderValueLength)
                throw Invalid("extraHeaders contains a value that is too long.");
            result[name] = valueText;
        }
        return result;
    }

    private static string RequiredString(JsonNode? node, string label, int maxLength)
    {
        if (node is not JsonValue value || !value.TryGetValue<string>(out var raw))
            throw Invalid(label + " must be a string.");
        if (raw.Length > maxLength || raw.Trim().Length == 0)
            throw Invalid(label + " is required.");
        return raw.Trim();
    }

    private static SetupProviderRequestException Invalid(string message) =>
        new("invalid-request", message, 400);
}
