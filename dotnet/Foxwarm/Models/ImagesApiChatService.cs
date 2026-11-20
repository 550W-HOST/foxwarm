using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// One separate image request sent to the OpenAI Images API instead of a Responses request.
// It is always plain HTTP, including for openai-ws providers: the Images API has no
// WebSocket form. The request owner supplies masking, redaction, journal and attempt policy.
internal sealed class ImagesApiChatService(HttpClient http, ResponsesClientOptions options)
    : IChatService
{
    // The b64_json response for the largest accepted images, with JSON overhead.
    private const int MaxResponseBodyBytes = 96 * 1024 * 1024;
    private const int MaxErrorBodyBytes = 64 * 1024;
    private const int ImageResponseFloorMs = 600000;

    internal static Uri Endpoint(Uri baseUri, bool edit)
    {
        var builder = new UriBuilder(baseUri);
        builder.Scheme = builder.Scheme switch
        {
            "ws" => "http",
            "wss" => "https",
            _ => builder.Scheme,
        };
        if (builder.Uri.IsDefaultPort)
            builder.Port = -1;
        builder.Path = builder.Path.TrimEnd('/') + (edit ? "/images/edits" : "/images/generations");
        return builder.Uri;
    }

    // Foxwarm image options that the Images API accepts. `action` has no Images API form:
    // the endpoint follows from whether reference images are present.
    internal static IEnumerable<(string Field, JsonNode Value)> Options(JsonObject configuration)
    {
        foreach (
            var (key, field) in new[]
            {
                ("size", "size"),
                ("quality", "quality"),
                ("background", "background"),
                ("outputFormat", "output_format"),
                ("outputCompression", "output_compression"),
            }
        )
            if (configuration[key] is JsonNode value)
                yield return (field, value.DeepClone());
    }

    private sealed record ReferenceImage(byte[] Bytes, string MimeType);

    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    )
    {
        var configuration =
            options.ImageGeneration
            ?? throw new ModelPreparationException(
                "A separate image request requires image generation."
            );
        var model =
            SessionWait.Text(configuration["model"])
            ?? throw new ModelPreparationException(
                "imageGeneration.model is required when imageGeneration.api is images."
            );
        var prompt = new List<string>();
        var references = new List<ReferenceImage>();
        foreach (
            var part in history
                .Where(message => SessionWait.Text(message["role"]) == "user")
                .SelectMany(message => (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        )
        {
            if (part["inlineData"] is JsonObject inline)
            {
                var mime = SessionWait.Text(inline["mimeType"]) ?? "";
                var data = SessionWait.Text(inline["data"]);
                if (!mime.StartsWith("image/", StringComparison.Ordinal) || data is null)
                    throw new ModelPreparationException(
                        "A reference image could not be prepared for the Images API."
                    );
                references.Add(new(Convert.FromBase64String(data), mime));
            }
            else if (part["inlineDataRef"] is not null)
                // Hydration leaves a reference without bytes when the leaf rejects image input;
                // sending only the prompt would silently turn an edit into a new generation.
                throw new ModelPreparationException(
                    "A reference image could not be sent to the Images API for this model."
                );
            else if (SessionWait.Text(part["text"]) is { Length: > 0 } text)
                prompt.Add(text);
        }
        var promptText = string.Join("\n\n", prompt);
        if (promptText.Trim().Length == 0)
            throw new ModelPreparationException("The image prompt is empty.");

        var edit = references.Count > 0;
        var fields = new JsonObject { ["model"] = model, ["prompt"] = promptText };
        foreach (var (field, value) in Options(configuration))
            fields[field] = value;
        // The journal and diagnostics receive the semantic request: form fields plus a
        // digest of each uploaded image, never the image bytes.
        var payload = (JsonObject)fields.DeepClone();
        if (edit)
            payload["image[]"] = new JsonArray(
                references
                    .Select(image =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["mimeType"] = image.MimeType,
                                ["byteLength"] = image.Bytes.Length,
                                ["sha256"] = Convert.ToHexStringLower(
                                    SHA256.HashData(image.Bytes)
                                ),
                            }
                    )
                    .ToArray()
            );
        if (options.AttemptPrepared is not null)
            await options.AttemptPrepared(payload).ConfigureAwait(false);

        using var request = edit
            ? MultipartRequest(Endpoint(options.BaseUri, true), fields, references)
            : ProviderHttpRequest.Create(
                Endpoint(options.BaseUri, false),
                fields,
                options with
                {
                    RequestCompression = null,
                },
                Headers()
            );
        if (edit)
            ProviderHttpRequest.ApplyHeaders(request, options, Headers());

        using var activity = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        // A non-streaming image response has no intermediate activity, so the attempt uses the
        // image-generation inactivity floor from its start. Stop and the hard deadline stay independent.
        using var watchdog = new StreamActivityWatchdog(
            activity,
            Math.Max(options.StreamInactivityTimeoutMs ?? 60000, ImageResponseFloorMs),
            options.Clock
        );
        watchdog.ExtendedActivity();
        var token = activity.Token;
        var started = Stopwatch.GetTimestamp();
        using var response = await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                token
            )
            .ConfigureAwait(false);
        var statusLine = $"{(int)response.StatusCode} {response.ReasonPhrase}";
        if (!response.IsSuccessStatusCode)
        {
            var error = await ReadAsync(response.Content, MaxErrorBodyBytes, false, token)
                .ConfigureAwait(false);
            watchdog.Finish();
            var diagnostic = ModelAttemptFailure.DiagnosticBody(error);
            options.Diagnostics?.Response(
                statusLine,
                ProviderHttpRequest.ResponseHeaders(response),
                JsonValue.Create(diagnostic.Body),
                diagnostic.Truncated
            );
            throw HttpFailure((int)response.StatusCode, error);
        }
        var body = await ReadAsync(response.Content, MaxResponseBodyBytes, true, token)
            .ConfigureAwait(false);
        watchdog.Finish();
        JsonObject result;
        try
        {
            result =
                JsonNode.Parse(body) as JsonObject
                ?? throw new InvalidDataException("not a JSON object");
        }
        catch (Exception error)
            when (error is System.Text.Json.JsonException or InvalidDataException)
        {
            throw new ModelAttemptFailure(
                "The Images API returned an unreadable response.",
                "response-error",
                false,
                false
            );
        }
        options.Diagnostics?.Response(
            statusLine,
            ProviderHttpRequest.ResponseHeaders(response),
            Foxwarm.Images.ImageTransport.DiagnosticBody(Omitted(result))
        );
        var duration = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        var parts = await ExternalizeAsync(result, cancellationToken).ConfigureAwait(false);
        var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var assistant = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = parts,
            ["__meta"] = new JsonObject
            {
                ["timestamp"] = completedAt,
                ["llmRequestTiming"] = new JsonObject
                {
                    ["startedAt"] = completedAt - duration,
                    ["completedAt"] = completedAt,
                    ["durationMs"] = duration,
                },
            },
        };
        var usage = ResponsesCanonicalConverter.BuildUsage(result["usage"] as JsonObject);
        // Image tokens are priced only by imageGeneration.pricing, never by the conversation
        // model's rates; without it, or when the counts do not fit it, the cost stays unrecorded.
        if (
            usage is not null
            && configuration["pricing"] is JsonObject prices
            && ModelUsageCost.ImageCost(result["usage"] as JsonObject, prices, edit)
                is double cost
        )
            usage["cost"] = cost;
        return new ChatResult(assistant, usage) { UsagePricedByService = true };
    }

    private Dictionary<string, string> Headers()
    {
        var headers = new Dictionary<string, string>();
        if (!string.IsNullOrEmpty(options.Token))
            headers["Authorization"] = "Bearer " + options.Token;
        return headers;
    }

    private static HttpRequestMessage MultipartRequest(
        Uri endpoint,
        JsonObject fields,
        IReadOnlyList<ReferenceImage> images
    )
    {
        var form = new MultipartFormDataContent();
        foreach (var (name, value) in fields)
            form.Add(
                new StringContent(
                    value is JsonValue scalar && scalar.TryGetValue<string>(out var text)
                        ? text
                        : value!.ToJsonString(),
                    Encoding.UTF8
                ),
                name
            );
        for (var index = 0; index < images.Count; index++)
        {
            var image = new ByteArrayContent(images[index].Bytes);
            image.Headers.ContentType = new MediaTypeHeaderValue(images[index].MimeType);
            form.Add(
                image,
                "image[]",
                $"image-{index + 1}.{Extension(images[index].MimeType)}"
            );
        }
        return new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = form };
    }

    private static string Extension(string mime) =>
        mime switch
        {
            "image/jpeg" => "jpg",
            "image/png" => "png",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "bin",
        };

    private async Task<JsonArray> ExternalizeAsync(JsonObject result, CancellationToken token)
    {
        var data = result["data"] as JsonArray ?? [];
        var declared = HostedResponsesTools.DeclaredMime(SessionWait.Text(result["output_format"]));
        var parts = new JsonArray();
        var failures = new List<string>();
        var usedBytes = 0L;
        var prefix = "ia_" + Guid.NewGuid().ToString("N")[..12];
        for (var index = 0; index < data.Count; index++)
        {
            if (data[index] is not JsonObject item)
                continue;
            if (SessionWait.Text(item["b64_json"]) is not { Length: > 0 } encoded)
            {
                failures.Add(
                    item["url"] is not null
                        ? "The Images API returned an image URL instead of image data (b64_json)."
                        : "The Images API returned an item without image data."
                );
                continue;
            }
            if (parts.Count >= HostedResponsesTools.MaxImages)
            {
                failures.Add("The response exceeded the image limit.");
                continue;
            }
            if (options.Images is null)
                throw new ModelPreparationException("Image storage is unavailable.");
            try
            {
                var bytes = HostedResponsesTools.DecodeBase64(
                    encoded,
                    HostedResponsesTools.MaxImageBytes
                );
                if (usedBytes + bytes.Length > HostedResponsesTools.MaxResponseBytes)
                    throw new InvalidDataException(
                        "response exceeded the generated image byte budget."
                    );
                var mime = Foxwarm.Images.RasterImageMime.Detect(bytes);
                if (mime is null or "image/bmp")
                    throw new InvalidDataException(
                        "image result bytes were not a supported raster image."
                    );
                if (declared is not null && declared != mime)
                    throw new InvalidDataException(
                        "image result MIME did not match output_format."
                    );
                var imageId = prefix + "_" + (index + 1);
                var reference = await options
                    .Images.PutAsync(bytes, mime, imageId, token)
                    .ConfigureAwait(false);
                parts.Add(
                    new JsonObject
                    {
                        ["inlineDataRef"] = reference,
                        ["imageMeta"] = new JsonObject
                        {
                            ["imageId"] = imageId,
                            ["origin"] = "generated",
                            ["mimeType"] = mime,
                            ["sizeBytes"] = bytes.Length,
                            ["sha256"] = reference["sha256"]?.DeepClone(),
                            ["width"] = reference["width"]?.DeepClone(),
                            ["height"] = reference["height"]?.DeepClone(),
                        },
                    }
                );
                usedBytes += bytes.Length;
            }
            catch (InvalidDataException error)
            {
                failures.Add("Image result rejected: " + error.Message);
            }
        }
        if (parts.Count == 0)
            throw ModelAttemptFailure.GeneratedImageFailure(
                failures.FirstOrDefault() ?? "The Images API returned no image."
            );
        return parts;
    }

    // Diagnostics keep the response shape without image bytes.
    private static string Omitted(JsonObject result)
    {
        var copy = (JsonObject)result.DeepClone();
        foreach (var item in (copy["data"] as JsonArray ?? []).OfType<JsonObject>())
            if (item["b64_json"] is JsonValue value && value.TryGetValue<string>(out var text))
                item["b64_json"] = $"[{text.Length} base64 characters omitted]";
        return copy.ToJsonString();
    }

    private static ModelAttemptFailure HttpFailure(int status, string body)
    {
        string? message = null;
        try
        {
            var error = JsonNode.Parse(body)?["error"];
            message = error is JsonObject value ? SessionWait.Text(value["message"])
                : SessionWait.Text(error);
        }
        catch (System.Text.Json.JsonException) { }
        message = string.IsNullOrWhiteSpace(message)
            ? body.Trim().Length == 0
                ? null
                : Foxwarm.Images.ImageTransport.DiagnosticBody(body)
            : message.Trim();
        // One attempt on a concrete leaf: this failure neither retries nor affects routing health.
        return new ModelAttemptFailure(
            "Images API HTTP " + status + (message is null ? "" : ": " + message),
            "http-error",
            false,
            false,
            status.ToString(System.Globalization.CultureInfo.InvariantCulture)
        );
    }

    private static async Task<string> ReadAsync(
        HttpContent content,
        int limit,
        bool strict,
        CancellationToken token
    )
    {
        await using var stream = await content.ReadAsStreamAsync(token).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, token).ConfigureAwait(false);
            if (read == 0)
                break;
            if (buffer.Length + read > limit)
            {
                if (strict)
                    throw new ModelAttemptFailure(
                        "The Images API response exceeded the size limit.",
                        "response-error",
                        false,
                        false
                    );
                buffer.Write(chunk, 0, (int)(limit - buffer.Length));
                break;
            }
            buffer.Write(chunk, 0, read);
        }
        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
}
