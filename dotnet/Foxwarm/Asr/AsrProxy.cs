using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Asr;

internal sealed partial class AsrProxy : IDisposable
{
    internal const long AudioLimit = 25L * 1024 * 1024;
    internal const int ControlLimit = 16 * 1024;
    internal const int FrameLimit = 256 * 1024;
    internal const int OutputLimit = 1024 * 1024;
    private const string ServiceError =
        "Speech service is unavailable. Check the service and try again.";
    private readonly Uri? service;
    private readonly string? key;
    private readonly string? configurationError;
    private readonly HttpClient http = new(
        new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }
    )
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };
    private readonly CancellationToken stopped;
    internal bool Configured => service is not null;

    internal AsrProxy(ModelConfiguration? configuration, CancellationToken stopped)
    {
        this.stopped = stopped;
        try
        {
            var raw = configuration?.AppConfiguration["asrService"];
            if (raw is null)
                return;
            if (raw is not JsonObject block)
                throw new FormatException();
            if (
                block["enabled"] is { } enabled
                && (enabled is not JsonValue value || !value.TryGetValue<bool>(out _))
            )
                throw new FormatException();
            if (block["enabled"]?.GetValue<bool>() == false)
                return;
            var url = Text(block["url"]);
            key = Text(block["key"])?.Trim();
            if (string.IsNullOrWhiteSpace(url))
                return;
            if (
                !Uri.TryCreate(url.Trim().TrimEnd('/'), UriKind.Absolute, out var parsed)
                || parsed.Scheme is not ("http" or "https")
                || parsed.UserInfo.Length > 0
                || parsed.Query.Length > 0
                || parsed.Fragment.Length > 0
            )
                throw new FormatException();
            if (!string.IsNullOrEmpty(key))
            {
                if (key.Any(char.IsControl))
                    throw new FormatException();
                _ = new AuthenticationHeaderValue("Bearer", key);
            }
            service = parsed;
        }
        catch (Exception error)
            when (error is FormatException or InvalidOperationException or ArgumentException)
        {
            configurationError =
                "Speech input configuration is invalid. Check asrService and restart.";
        }
    }

    private static string? Text(JsonNode? value) =>
        value is null ? null
        : value is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text
        : throw new FormatException();

    private Uri Endpoint(string path) => new(service!.AbsoluteUri.TrimEnd('/') + path);

    private void Authorize(HttpRequestMessage request)
    {
        if (!string.IsNullOrEmpty(key))
            request.Headers.Authorization = new("Bearer", key);
    }

    private string SafeText(string text) =>
        string.IsNullOrEmpty(key)
            ? text
            : text.Replace(key, "[redacted]", StringComparison.Ordinal);

    private CancellationTokenSource Lifetime(CancellationToken request, TimeSpan timeout)
    {
        var source = CancellationTokenSource.CreateLinkedTokenSource(request, stopped);
        source.CancelAfter(timeout);
        return source;
    }

    internal async Task<JsonObject> StatusAsync(CancellationToken request)
    {
        var status = new JsonObject
        {
            ["configured"] = Configured,
            ["available"] = false,
            ["streamingSupported"] = false,
        };
        if (!Configured)
        {
            if (configurationError is not null)
                status["error"] = configurationError;
            return status;
        }
        try
        {
            using var lifetime = Lifetime(request, TimeSpan.FromSeconds(3));
            using var message = new HttpRequestMessage(HttpMethod.Get, Endpoint("/health"));
            Authorize(message);
            using var response = await http.SendAsync(
                message,
                HttpCompletionOption.ResponseHeadersRead,
                lifetime.Token
            );
            var body = await ReadJsonAsync(response.Content, ControlLimit, lifetime.Token);
            if (
                !response.IsSuccessStatusCode
                || body["ok"] is { } health
                    && (
                        health is not JsonValue ok
                        || !ok.TryGetValue<bool>(out var healthy)
                        || !healthy
                    )
                || body["qwenAsrBinExists"]?.ToJsonString() == "false"
                || body["modelDirExists"]?.ToJsonString() == "false"
            )
                throw new FormatException();
            status["available"] = true;
            status["streamingSupported"] =
                body["streamingSupported"] is null
                || body["streamingSupported"] is JsonValue stream
                    && stream.TryGetValue<bool>(out var supported)
                    && supported;
        }
        catch (Exception error)
            when (error
                    is HttpRequestException
                        or IOException
                        or FormatException
                        or System.Text.Json.JsonException
                        or OperationCanceledException
                        or ArgumentException
            )
        {
            if (request.IsCancellationRequested || stopped.IsCancellationRequested)
                throw;
            status["error"] = ServiceError;
        }
        return status;
    }

    internal void Register(WebApplication app)
    {
        app.MapGet(
            "/api/asr/status",
            (Func<HttpContext, Task<JsonObject>>)(context => StatusAsync(context.RequestAborted))
        );
        app.MapPost("/api/asr/transcribe", (Func<HttpContext, Task<IResult>>)TranscribeAsync);
        app.Map("/api/asr/stream", StreamAsync);
        app.Lifetime.ApplicationStopped.Register(Dispose);
    }

    private async Task<IResult> TranscribeAsync(HttpContext context)
    {
        if (!Configured)
            return Results.Json(
                new { error = configurationError ?? "Speech service is not configured." },
                statusCode: 503
            );
        if (
            context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>() is
            { IsReadOnly: false } limit
        )
            limit.MaxRequestBodySize = AudioLimit + ControlLimit + 65536;
        if (!context.Request.HasFormContentType)
            return Results.BadRequest(new { error = "One multipart audio file is required." });
        try
        {
            using var lifetime = Lifetime(context.RequestAborted, TimeSpan.FromMinutes(10));
            var form = await context.Request.ReadFormAsync(
                new Microsoft.AspNetCore.Http.Features.FormOptions
                {
                    MultipartBodyLengthLimit = AudioLimit + ControlLimit + 65536,
                    ValueLengthLimit = ControlLimit,
                    ValueCountLimit = 16,
                },
                lifetime.Token
            );
            if (form.Files.Count != 1 || form.Files[0].Name != "audio")
                return Results.BadRequest(new { error = "One audio file is required." });
            var file = form.Files[0];
            if (file.Length == 0)
                return Results.BadRequest(new { error = "Audio is empty." });
            if (file.Length > AudioLimit)
                return Results.Json(
                    new { error = "Audio exceeds the 25 MiB limit." },
                    statusCode: 413
                );
            if (
                form.Sum(pair =>
                    Encoding.UTF8.GetByteCount(pair.Key)
                    + Encoding.UTF8.GetByteCount(pair.Value.ToString())
                ) > ControlLimit
            )
                return Results.BadRequest(new { error = "Audio metadata is too large." });
            using var multipart = new MultipartFormDataContent();
            await using var input = file.OpenReadStream();
            using var audio = new StreamContent(input);
            audio.Headers.ContentType = MediaTypeHeaderValue.TryParse(
                file.ContentType,
                out var mime
            )
                ? mime
                : new("application/octet-stream");
            multipart.Add(
                audio,
                "audio",
                Path.GetFileName(file.FileName.Replace('\\', '/')) is { Length: > 0 } name
                    ? name
                    : "audio.wav"
            );
            foreach (var field in new[] { "context", "language", "segmentSeconds" })
            {
                var text = form[field].Count == 1 ? form[field].ToString().Trim() : "";
                if (text.Length > 0)
                    multipart.Add(new StringContent(text), field);
            }
            using var message = new HttpRequestMessage(HttpMethod.Post, Endpoint("/transcribe"))
            {
                Content = multipart,
            };
            Authorize(message);
            using var response = await http.SendAsync(
                message,
                HttpCompletionOption.ResponseHeadersRead,
                lifetime.Token
            );
            var body = await ReadJsonAsync(response.Content, OutputLimit, lifetime.Token);
            if (!response.IsSuccessStatusCode)
                return Results.Json(
                    new { error = ServiceError },
                    statusCode: (int)response.StatusCode is >= 400 and <= 599
                        ? (int)response.StatusCode
                        : 502
                );
            if (
                body["text"] is not JsonValue value
                || !value.TryGetValue<string>(out var textResult)
            )
                throw new FormatException();
            return Results.Json(Transcript(body, SafeText(textResult)));
        }
        catch (OperationCanceledException)
            when (context.RequestAborted.IsCancellationRequested || stopped.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return Results.Json(
                new { error = "Transcription timed out. Try a shorter recording." },
                statusCode: 504
            );
        }
        catch (Exception error) when (error is InvalidDataException or BadHttpRequestException)
        {
            return Results.Json(
                new { error = "Audio upload is invalid or exceeds the 25 MiB limit." },
                statusCode: error is BadHttpRequestException bad ? bad.StatusCode : 400
            );
        }
        catch (Exception error)
            when (error
                    is HttpRequestException
                        or IOException
                        or FormatException
                        or System.Text.Json.JsonException
                        or ArgumentException
            )
        {
            return Results.Json(new { error = ServiceError }, statusCode: 502);
        }
    }

    private JsonObject Transcript(JsonObject body, string text)
    {
        var result = new JsonObject { ["text"] = text };
        if (
            body["language"] is JsonValue language
            && language.TryGetValue<string>(out var languageText)
            && languageText.Length <= 256
        )
            result["language"] = SafeText(languageText);
        if (
            body["elapsedMs"] is JsonValue elapsed
            && elapsed.TryGetValue<double>(out var number)
            && double.IsFinite(number)
            && number >= 0
        )
            result["elapsedMs"] = number;
        return result;
    }

    private static async Task<JsonObject> ReadJsonAsync(
        HttpContent content,
        int limit,
        CancellationToken token
    )
    {
        await using var input = await content.ReadAsStreamAsync(token);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await input.ReadAsync(buffer, token)) > 0)
        {
            if (output.Length + count > limit)
                throw new FormatException();
            output.Write(buffer, 0, count);
        }
        return JsonNode.Parse(new UTF8Encoding(false, true).GetString(output.ToArray()))
                as JsonObject
            ?? throw new FormatException();
    }

    public void Dispose() => http.Dispose();
}
