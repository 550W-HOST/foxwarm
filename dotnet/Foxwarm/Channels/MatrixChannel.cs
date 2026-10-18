using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed class MatrixApiException(int status, JsonObject? body, TimeSpan? retryAfter)
    : IOException("Matrix request failed (" + status + ").")
{
    internal int Status { get; } = status;
    internal string? Code { get; } = SessionWait.Text(body?["errcode"]);
    internal TimeSpan? RetryAfter { get; } = retryAfter;
}

// The unencrypted subset used by MatrixChannel with matrix-js-sdk 41.0.0-rc.0.
internal sealed partial class MatrixChannel : IManagedChannel
{
    private static readonly HttpClient DefaultHttp = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly string id;
    private readonly Uri homeserver;
    private readonly string accessToken;
    private readonly string user;
    private readonly SessionManager sessions;
    private readonly MessageRouter router;
    private readonly HttpClient http;
    private readonly Action<Exception> log;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly CancellationTokenSource stopping = new();
    private readonly long startTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly HashSet<string> processed = new(StringComparer.Ordinal);
    private readonly Queue<string> processedOrder = new();
    private readonly object sendGate = new();
    private Task sendTail = Task.CompletedTask;
    private long transaction;
    private Task? polling;

    internal MatrixChannel(
        string id,
        JsonObject config,
        SessionManager sessions,
        MessageRouter router,
        ChannelTransportDependencies? dependencies,
        Action<Exception> log
    )
    {
        this.id = id;
        this.sessions = sessions;
        this.router = router;
        this.log = log;
        var server = SessionWait.Text(config["homeserver"])?.Trim();
        accessToken = SessionWait.Text(config["accessToken"])?.Trim() ?? "";
        user = SessionWait.Text(config["botUserId"])?.Trim() ?? "";
        if (string.IsNullOrEmpty(server) || accessToken.Length == 0 || user.Length == 0)
            throw new InvalidDataException(
                "Matrix homeserver/accessToken/botUserId are required for channel " + id
            );
        homeserver = new Uri(server.TrimEnd('/') + "/");
        http = dependencies?.CreateHttp?.Invoke() ?? DefaultHttp;
        delay = dependencies?.Delay ?? Task.Delay;
    }

    public RegisteredChannel Transport =>
        new(
            "matrix",
            (room, text, options, token) =>
                SendTextAsync(room, text, options.ParseMode == "Markdown", token),
            SendFileAsync,
            TypingAsync
        );

    public async Task StartAsync()
    {
        JsonObject? versions = null;
        try
        {
            versions = await RequestAsync(
                HttpMethod.Get,
                "_matrix/client/versions",
                null,
                stopping.Token
            );
        }
        catch (Exception error) when (!stopping.IsCancellationRequested)
        {
            log(error);
        }
        var threadNotifications =
            versions is null
            || (versions?["versions"] as JsonArray ?? []).Any(version =>
                SessionWait.Text(version) == "v1.4"
            )
            || SessionCatalog.Flag(versions?["unstable_features"]?["org.matrix.msc3771"])
                && SessionCatalog.Flag(versions?["unstable_features"]?["org.matrix.msc3773"]);
        polling = PollAsync(threadNotifications);
        _ = ObserveAsync(
            RequestAsync(HttpMethod.Get, "_matrix/client/v3/capabilities", null, stopping.Token)
        );
    }

    public Task StopAsync()
    {
        stopping.Cancel();
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        if (polling is { IsCompleted: false } active)
            _ = active.ContinueWith(_ => stopping.Dispose(), TaskScheduler.Default);
        else
            stopping.Dispose();
    }

    private async Task ObserveAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error)
        {
            log(error);
        }
    }

    internal static string MarkdownToHtml(string text) =>
        Regex
            .Replace(
                Regex.Replace(
                    Regex.Replace(text, @"\*\*([^\r\n\u2028\u2029]+?)\*\*", "<strong>$1</strong>"),
                    @"\*([^\r\n\u2028\u2029]+?)\*",
                    "<em>$1</em>"
                ),
                @"`([^\r\n\u2028\u2029]+?)`",
                "<code>$1</code>"
            )
            .Replace("\n", "<br/>");

    private Task SendTextAsync(string room, string text, bool markdown, CancellationToken token)
    {
        var content = new JsonObject { ["msgtype"] = "m.text", ["body"] = text };
        if (markdown)
        {
            content["format"] = "org.matrix.custom.html";
            content["formatted_body"] = MarkdownToHtml(text);
        }
        return SendEventAsync(room, content, token);
    }

    private Task SendEventAsync(string room, JsonObject content, CancellationToken token)
    {
        var completion = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Task previous;
        lock (sendGate)
        {
            previous = sendTail;
            sendTail = completion.Task;
        }
        _ = CompleteSendAsync(previous, completion, room, content, token);
        return completion.Task;
    }

    private async Task CompleteSendAsync(
        Task previous,
        TaskCompletionSource completion,
        string room,
        JsonObject content,
        CancellationToken token
    )
    {
        try
        {
            // The SDK queues m.room.message events and fails already queued successors on an exhausted send.
            await previous;
            var txn =
                "m"
                + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                + "."
                + (Interlocked.Increment(ref transaction) - 1);
            for (var attempts = 1; ; attempts++)
            {
                try
                {
                    await RequestAsync(
                        HttpMethod.Put,
                        "_matrix/client/v3/rooms/" + Encode(room) + "/send/m.room.message/" + txn,
                        content,
                        token
                    );
                    break;
                }
                catch (MatrixApiException error)
                    when (attempts <= 4
                        && error.Status is not (>= 400 and < 500 and not 429)
                        && error.Code != "M_TOO_LARGE"
                    )
                {
                    await delay(
                        error.RetryAfter ?? TimeSpan.FromSeconds(Math.Pow(2, attempts)),
                        token
                    );
                }
            }
            completion.TrySetResult();
        }
        catch (OperationCanceledException error)
        {
            completion.TrySetCanceled(error.CancellationToken);
        }
        catch (Exception error)
        {
            completion.TrySetException(error);
        }
        finally
        {
            lock (sendGate)
                if (sendTail == completion.Task)
                    sendTail = Task.CompletedTask;
        }
    }

    private async Task SendFileAsync(
        string room,
        ChannelFile file,
        string? caption,
        CancellationToken token
    )
    {
        if (!string.IsNullOrEmpty(caption))
            await SendTextAsync(room, caption, false, token);
        var bytes = await File.ReadAllBytesAsync(file.Path, token);
        using var upload = new ByteArrayContent(bytes);
        upload.Headers.ContentType = new MediaTypeHeaderValue(
            file.MimeType ?? "application/octet-stream"
        );
        var result = await RequestContentAsync(
            HttpMethod.Post,
            "_matrix/media/v3/upload?filename=" + Uri.EscapeDataString(file.Name),
            upload,
            token
        );
        var uri = SessionWait.Text(result["content_uri"]) ?? SessionWait.Text(result["contentUri"]);
        if (string.IsNullOrEmpty(uri))
            throw new InvalidDataException("Matrix upload did not return content_uri");
        await SendEventAsync(
            room,
            new JsonObject
            {
                ["msgtype"] = file.IsImage ? "m.image" : "m.file",
                ["body"] = file.Name,
                ["filename"] = file.Name,
                ["url"] = uri,
                ["info"] = new JsonObject
                {
                    ["mimetype"] = file.MimeType,
                    ["size"] = bytes.LongLength,
                },
            },
            token
        );
    }

    private async Task TypingAsync(string room, CancellationToken token)
    {
        try
        {
            await RequestAsync(
                HttpMethod.Put,
                "_matrix/client/v3/rooms/" + Encode(room) + "/typing/" + Encode(user),
                new JsonObject { ["typing"] = true, ["timeout"] = 3000 },
                token
            );
        }
        catch
        { /* Source typing is best-effort. */
        }
    }

    // encodeURIComponent preserves these punctuation characters in the pinned SDK path.
    private static string Encode(string value) =>
        Uri.EscapeDataString(value)
            .Replace("%21", "!")
            .Replace("%27", "'")
            .Replace("%28", "(")
            .Replace("%29", ")")
            .Replace("%2A", "*");

    internal Uri? MediaUri(string? mxc)
    {
        if (mxc is null || !mxc.StartsWith("mxc://", StringComparison.Ordinal))
            return null;
        var segments = mxc[6..].Split('/');
        if (
            segments.Length != 2
            || !Regex.IsMatch(
                segments[0],
                @"^(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}|\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9\-.]{1,255})(?::[0-9]{1,5})?\z"
            )
            || !Regex.IsMatch(segments[1], @"^[A-Za-z0-9_\-]+\z")
        )
            return null;
        // mxcUrlToHttp(mxc) defaults to the unauthenticated media/v3 endpoint, even on v1.11 servers.
        return new Uri(homeserver, "/_matrix/media/v3/download/" + segments[0] + "/" + segments[1]);
    }

    private async Task<JsonObject> RequestAsync(
        HttpMethod method,
        string path,
        JsonObject? body,
        CancellationToken token
    )
    {
        using var content = body is null
            ? null
            : new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return await RequestContentAsync(method, path, content, token);
    }

    private async Task<JsonObject> RequestContentAsync(
        HttpMethod method,
        string path,
        HttpContent? content,
        CancellationToken token
    )
    {
        using var request = new HttpRequestMessage(
            method,
            new Uri(homeserver.ToString().TrimEnd('/') + "/" + path)
        )
        {
            Content = content,
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(
            TimeSpan.FromSeconds(path.Contains("/sync?", StringComparison.Ordinal) ? 110 : 100)
        );
        using var response = await http.SendAsync(request, timeout.Token);
        var raw = await response.Content.ReadAsStringAsync(timeout.Token);
        JsonObject? result = null;
        try
        {
            result = JsonNode.Parse(raw) as JsonObject;
        }
        catch (System.Text.Json.JsonException) { }
        if (!response.IsSuccessStatusCode)
        {
            var retry =
                response.Headers.RetryAfter?.Delta
                ?? (
                    response.Headers.RetryAfter?.Date is { } date
                        ? date - DateTimeOffset.UtcNow
                        : null
                );
            retry ??= SessionWait.Number(result?["retry_after_ms"]) is { } ms
                ? TimeSpan.FromMilliseconds(ms)
                : null;
            throw new MatrixApiException((int)response.StatusCode, result, retry);
        }
        return result ?? throw new InvalidDataException("Matrix response is not a JSON object.");
    }
}
