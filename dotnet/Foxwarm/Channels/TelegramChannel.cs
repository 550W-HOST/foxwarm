using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed class TelegramApiException(int code, string description, double? retryAfter = null)
    : IOException(description)
{
    internal int Code { get; } = code;
    internal double? RetryAfter { get; } = retryAfter;
    internal bool Payload =>
        Code == 400
        || Message.Contains("400: Bad Request", StringComparison.Ordinal)
        || Message.Contains("can't parse entities", StringComparison.Ordinal);
    internal bool PlainFallback =>
        Code == 400 || Message.Contains("can't parse entities", StringComparison.Ordinal);
}

internal sealed class TelegramChannel : IManagedChannel
{
    private static readonly HttpClient DefaultHttp = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly string id;
    private readonly SessionManager sessions;
    private readonly MessageRouter router;
    private readonly HttpClient http;
    private readonly TimeSpan apiTimeout;
    private readonly Uri api;
    private readonly Uri files;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly Action<Exception> log;
    private readonly CancellationTokenSource stopping = new();
    private Task? polling;
    private string username = "";
    private long offset;

    internal TelegramChannel(
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
        var token = SessionWait.Text(config["botToken"])?.Trim();
        if (string.IsNullOrEmpty(token))
            throw new InvalidDataException("Telegram botToken is missing for channel " + id);
        http = dependencies?.CreateHttp?.Invoke() ?? DefaultHttp;
        if (!ReferenceEquals(http, DefaultHttp))
            http.Timeout = Timeout.InfiniteTimeSpan;
        apiTimeout = dependencies?.TelegramApiTimeout ?? TimeSpan.FromSeconds(500);
        api =
            dependencies?.TelegramApi?.Invoke(token)
            ?? new Uri("https://api.telegram.org/bot" + token + "/");
        files =
            dependencies?.TelegramFiles?.Invoke(token)
            ?? new Uri("https://api.telegram.org/file/bot" + token + "/");
        delay = dependencies?.Delay ?? Task.Delay;
    }

    public RegisteredChannel Transport =>
        new(
            "telegram",
            (conversation, text, _, token) => SendAsync(conversation, text, token),
            SendFileAsync,
            TypingAsync
        );

    public async Task StartAsync()
    {
        var stage = "command registration";
        try
        {
            await ApiAsync(
                "setMyCommands",
                new JsonObject { ["commands"] = ExternalCommands.TelegramCommands() },
                stopping.Token
            );
            stage = "identity lookup";
            username =
                SessionWait.Text(
                    (await ApiAsync("getMe", new JsonObject(), stopping.Token))?["username"]
                ) ?? "";
            // Launch completion is transport initialization, not a completed first poll.
            stage = "webhook removal";
            await ApiAsync("deleteWebhook", new JsonObject(), stopping.Token);
            polling = PollAsync();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw new ChannelFailure(stage, error);
        }
    }

    public Task StopAsync()
    {
        // Telegraf stop aborts polling; it does not join handlers or the final offset sync.
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

    private async Task PollAsync()
    {
        var skipSync = false;
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                JsonArray updates;
                try
                {
                    updates =
                        (
                            await ApiAsync(
                                "getUpdates",
                                new JsonObject
                                {
                                    ["timeout"] = 50,
                                    ["offset"] = offset,
                                    ["allowed_updates"] = new JsonArray(),
                                },
                                stopping.Token
                            )
                        ) as JsonArray
                        ?? new JsonArray();
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception error)
                    when (error is HttpRequestException or OperationCanceledException
                        || error is TelegramApiException { Code: 429 or >= 500 }
                    )
                {
                    log(error);
                    await delay(
                        TimeSpan.FromSeconds((error as TelegramApiException)?.RetryAfter ?? 5),
                        stopping.Token
                    );
                    continue;
                }
                catch (TelegramApiException error) when (error.Code is 401 or 409)
                {
                    skipSync = true;
                    throw;
                }
                if (
                    updates.LastOrDefault() is JsonObject last
                    && SessionWait.Number(last["update_id"]) is { } updateId
                )
                    offset = checked((long)updateId + 1);
                await Task.WhenAll(updates.OfType<JsonObject>().Select(HandleUpdateSafeAsync));
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error)
        {
            log(error);
        }
        finally
        {
            if (!skipSync)
            {
                using var sync = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try
                {
                    await ApiAsync(
                        "getUpdates",
                        new JsonObject { ["offset"] = offset, ["limit"] = 1 },
                        sync.Token
                    );
                }
                catch { }
            }
        }
    }

    private async Task HandleUpdateSafeAsync(JsonObject update)
    {
        try
        {
            await HandleUpdateAsync(update);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error)
        {
            log(error);
        }
    }

    private async Task HandleUpdateAsync(JsonObject update)
    {
        if (
            update["message"] is not JsonObject message
            || message["chat"]?["id"] is not JsonValue chatId
        )
            return;
        var chat = Identity(chatId);
        var from = message["from"] as JsonObject;
        var sender = from?["id"] is JsonValue senderId ? Identity(senderId) : null;
        var context = new ExternalChannelContext(
            id,
            "telegram",
            chat,
            sender,
            SessionWait.Text(from?["username"]),
            text =>
            {
                // Source request-context replies schedule work. Explicit tools instead await SendAsync.
                _ = ObserveAsync(SendAsync(chat, text, CancellationToken.None));
                return Task.CompletedTask;
            }
        );
        var bot = SessionCatalog.Flag(from?["is_bot"]);
        if (SessionWait.Text(message["text"]) is { } text)
        {
            if (bot)
                return;
            if (text.StartsWith('/'))
            {
                var commandToken = text.Split(' ')[0];
                var at = commandToken.IndexOf('@');
                if (
                    at >= 0
                    && username.Length > 0
                    && commandToken[(at + 1)..].Equals(username, StringComparison.OrdinalIgnoreCase)
                )
                    text = commandToken[..at] + text[commandToken.Length..];
                var command = Regex.Match(text, @"^(\S+)(?:\s+([\s\S]*))?$");
                if (
                    command.Success
                    && await router.HandleExternalCommandAsync(
                        context,
                        command.Groups[1].Value,
                        command.Groups[2].Success ? command.Groups[2].Value : null
                    )
                )
                    return;
            }
            _ = ObserveAsync(
                router.HandleExternalMessageAsync(
                    context,
                    new([new JsonObject { ["text"] = text }])
                )
            );
            return;
        }
        var photo = (message["photo"] as JsonArray)?.LastOrDefault() as JsonObject;
        var document = message["document"] as JsonObject;
        if (photo is null && document is null || photo is not null && bot)
            return;
        var media = photo ?? document!;
        var fileId =
            SessionWait.Text(media["file_id"])
            ?? throw new InvalidDataException("Telegram media has no file_id.");
        var file = await ApiAsync(
            "getFile",
            new JsonObject { ["file_id"] = fileId },
            stopping.Token
        );
        var filePath =
            SessionWait.Text(file?["file_path"])
            ?? throw new InvalidDataException("Telegram file has no download path.");
        var bytes = await http.GetByteArrayAsync(new Uri(files, filePath), stopping.Token);
        var unique = SessionWait.Text(media["file_unique_id"]) ?? fileId;
        var name = photo is not null
            ? "telegram-photo-" + unique + ".jpg"
            : SessionWait.Text(media["file_name"]) ?? "telegram-document-" + unique;
        var mime = photo is not null
            ? "image/jpeg"
            : SessionWait.Text(media["mime_type"]) ?? "application/octet-stream";
        // Deliberately preserve Source eager storage before Router authorization, using the adapter TYPE.
        // Named instances therefore retain Source's type-keyed helper limitation in this phase.
        var parts = await sessions.SaveInboundChannelFileAsync(
            "telegram",
            chat,
            bytes,
            name,
            mime,
            SessionWait.Text(message["caption"]) ?? "",
            stopping.Token
        );
        _ = ObserveAsync(router.HandleExternalMessageAsync(context, new(parts)));
    }

    private async Task ObserveAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception error)
        {
            log(error);
        }
    }

    private static string Identity(JsonValue value) =>
        SessionWait.Text(value) ?? value.ToJsonString();

    internal async Task SendAsync(string conversation, string text, CancellationToken token)
    {
        var body = new JsonObject
        {
            ["chat_id"] = Chat(conversation),
            ["text"] = text,
            ["parse_mode"] = "Markdown",
        };
        try
        {
            await RetryAsync(() => ApiAsync("sendMessage", body, token), token);
        }
        catch (TelegramApiException error) when (error.PlainFallback)
        {
            body.Remove("parse_mode");
            await RetryAsync(() => ApiAsync("sendMessage", body, token), token);
        }
    }

    private static JsonNode Chat(string conversation)
    {
        var match = Regex.Match(conversation.TrimStart(), @"^[+-]?\d+");
        return match.Success && long.TryParse(match.Value, out var value)
            ? JsonValue.Create(value)!
            : throw new InvalidDataException("Telegram target is not a numeric chat ID.");
    }

    internal async Task SendFileAsync(
        string conversation,
        ChannelFile file,
        string? caption,
        CancellationToken token
    )
    {
        caption = string.IsNullOrWhiteSpace(caption) ? null : caption;
        async Task Send(string? parseMode)
        {
            await RetryAsync(
                async () =>
                {
                    using var body = new MultipartFormDataContent();
                    body.Add(new StringContent(Chat(conversation).ToJsonString()), "chat_id");
                    if (caption is not null)
                        body.Add(new StringContent(caption), "caption");
                    if (parseMode is not null)
                        body.Add(new StringContent(parseMode), "parse_mode");
                    var stream = new StreamContent(File.OpenRead(file.Path));
                    stream.Headers.ContentType = new MediaTypeHeaderValue(
                        file.MimeType ?? "application/octet-stream"
                    );
                    body.Add(stream, file.IsImage ? "photo" : "document", file.Name);
                    return await ApiContentAsync(
                        file.IsImage ? "sendPhoto" : "sendDocument",
                        body,
                        token
                    );
                },
                token
            );
        }
        try
        {
            await Send(caption is null ? null : "Markdown");
        }
        catch (TelegramApiException error) when (caption is not null && error.PlainFallback)
        {
            await Send(null);
        }
    }

    internal async Task TypingAsync(string conversation, CancellationToken token) =>
        await ApiAsync(
            "sendChatAction",
            new JsonObject { ["chat_id"] = Chat(conversation), ["action"] = "typing" },
            token
        );

    private async Task<JsonNode?> RetryAsync(Func<Task<JsonNode?>> send, CancellationToken token)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return await send();
            }
            catch (Exception error)
                when (error is not OperationCanceledException
                    && error is not TelegramApiException { Payload: true }
                )
            {
                if (attempt >= 3)
                    throw;
                log(error);
                await delay(TimeSpan.FromSeconds(attempt == 0 ? 5 : 10), token);
            }
        }
    }

    private async Task<JsonNode?> ApiAsync(string method, JsonObject body, CancellationToken token)
    {
        using var content = new StringContent(
            body.ToJsonString(),
            Encoding.UTF8,
            "application/json"
        );
        return await ApiContentAsync(method, content, token);
    }

    private async Task<JsonNode?> ApiContentAsync(
        string method,
        HttpContent content,
        CancellationToken token
    )
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(apiTimeout);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(api, method))
            {
                Content = content,
            };
            using var response = await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token
            );
            // The pinned client classifies gateway/server failures before reading a JSON API payload.
            if ((int)response.StatusCode >= 500)
                throw new TelegramApiException(
                    (int)response.StatusCode,
                    response.ReasonPhrase ?? "Telegram API call failed."
                );
            // Telegraf's node-fetch gives headers and body consumption separate 500s budgets.
            // Downloads use the independent Axios path, with no application timeout.
            timeout.CancelAfter(apiTimeout);
            var body =
                await JsonNode.ParseAsync(
                    await response.Content.ReadAsStreamAsync(timeout.Token),
                    cancellationToken: timeout.Token
                ) as JsonObject
                ?? throw new IOException("Telegram returned an invalid response.");
            if (!response.IsSuccessStatusCode || !SessionCatalog.Flag(body["ok"]))
                throw new TelegramApiException(
                    (int)(SessionWait.Number(body["error_code"]) ?? (int)response.StatusCode),
                    SessionWait.Text(body["description"]) ?? "Telegram API call failed.",
                    SessionWait.Number(body["parameters"]?["retry_after"])
                );
            return body["result"]?.DeepClone();
        }
        catch (OperationCanceledException error) when (!token.IsCancellationRequested)
        {
            // A transport deadline is a retryable network error; caller cancellation is not.
            throw new HttpRequestException("Telegram API request timed out.", error);
        }
    }
}
