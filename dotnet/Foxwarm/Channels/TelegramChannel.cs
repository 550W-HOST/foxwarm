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
    private readonly string id;
    private readonly SessionManager sessions;
    private readonly MessageRouter router;
    private readonly HttpClient http;
    private readonly Foxwarm.Net.EgressPolicy egress;
    private readonly TimeSpan apiTimeout;
    private readonly Uri api;
    private readonly Uri files;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly ChannelHealth health;
    private const string PollingPath = "Telegram polling";
    private const string SendingPath = "Telegram sending";
    private readonly CancellationTokenSource stopping;
    private Task? polling;
    private string username = "";
    private long offset;
    private readonly ChannelCursors? cursors;
    private string account = "";

    private readonly Func<IDisposable>? holdTransport;

    internal TelegramChannel(
        string id,
        JsonObject config,
        SessionManager sessions,
        MessageRouter router,
        ChannelTransportDependencies? dependencies,
        ChannelHealth health,
        // The runtime's shared client of this channel type (ManagedChannels).
        HttpClient? shared = null,
        // Keeps that client valid for the polling loop, its closing offset sync included.
        Func<IDisposable>? holdTransport = null, ChannelCursors? cursors = null
    )
    {
        this.holdTransport = holdTransport;
        this.cursors = cursors;
        stopping = CancellationTokenSource.CreateLinkedTokenSource(cursors?.StopPolling ?? default);
        this.id = id;
        this.sessions = sessions;
        this.router = router;
        this.health = health;
        var token = SessionWait.Text(config["botToken"])?.Trim();
        if (string.IsNullOrEmpty(token))
            throw new InvalidDataException("Telegram botToken is missing for channel " + id);
        // Adapter tests may build an adapter without a runtime.
        egress = sessions?.Capabilities.Egress ?? Foxwarm.Net.EgressPolicy.Unguarded;
        http = dependencies?.CreateHttp?.Invoke() ?? (shared ??= ChannelHttpClients.Single(egress));
        if (!ReferenceEquals(http, shared))
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
            TypingAsync,
            Conversation: (conversation, _) => Chat(conversation).ToJsonText()
        );

    public async Task StartAsync()
    {
        var stage = "Telegram command registration";
        try
        {
            await ApiAsync(
                "setMyCommands",
                new JsonObject { ["commands"] = UserCommands.TelegramCommands() },
                stopping.Token
            );
            stage = "Telegram identity lookup";
            var me = await ApiAsync("getMe", new JsonObject(), stopping.Token);
            username = SessionWait.Text(me?["username"]) ?? "";
            account = "telegram:" + (me?["id"]?.ToString() ?? username);
            // Launch completion is transport initialization, not a completed first poll.
            stage = "Telegram webhook removal";
            await ApiAsync("deleteWebhook", new JsonObject(), stopping.Token);
            polling = cursors?.PollAsync(id, PollAsync) ?? PollAsync();
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
        // Held from the first poll, so the closing sync is admitted on a valid transport even
        // when the runtime disposes its clients before the loop ends.
        using var transport = holdTransport?.Invoke();
        var skipSync = false;
        try
        {
            if (cursors is not null)
                offset = (await cursors.ReadAsync(id, account))?["offset"]?.GetValue<long>() ?? 0;
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
                    when (
                        (
                            error is HttpRequestException or OperationCanceledException
                            || error is TelegramApiException { Code: 429 or >= 500 }
                        ) && !ChannelFailure.Refused(error)
                    )
                {
                    health.Fail(PollingPath, error);
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
                catch (Exception error) when (ChannelFailure.Refused(error))
                {
                    // The closing sync would be refused as well.
                    skipSync = true;
                    throw;
                }
                health.Recover(PollingPath);
                foreach (var update in updates.OfType<JsonObject>())
                {
                    var next = SessionWait.Number(update["update_id"]) is { } updateId ? checked((long)updateId + 1) : offset;
                    if (next < offset) continue; // A repeated response must not rewind the Bot API offset.
                    var gate = sessions?.ScheduledProducers;
                    using var admission = gate?.TryEnterProducer();
                    if (gate is not null && admission is null) return;
                    try
                    {
                        await HandleUpdateAsync(update);
                        if (next != offset && cursors is not null)
                            await cursors.SaveAsync(id, account, new JsonObject { ["offset"] = next });
                        offset = next;
                    }
                    catch (OperationCanceledException) when (stopping.IsCancellationRequested) { return; }
                    catch (Exception error)
                    {
                        health.Log(error);
                        await delay(TimeSpan.FromSeconds(2), stopping.Token);
                        break; // Retry from the last durably handled update.
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error)
        {
            // The loop has ended: polling stays failed until the channel restarts.
            health.Fail(PollingPath, error);
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
        ) { Polled = true, Receipt = update["update_id"] is { } identity
            ? ChannelCursors.Receipt("telegram", id, account, identity.ToString()) : null };
        var bot = SessionCatalog.Flag(from?["is_bot"]);
        if (SessionWait.Text(message["text"]) is { } text)
        {
            if (bot)
                return;
            if (text.StartsWith('/'))
            {
                var commandText = text;
                var commandToken = Regex.Match(text, @"^\S+").Value;
                var at = commandToken.IndexOf('@');
                if (
                    at >= 0
                    && username.Length > 0
                    && commandToken[(at + 1)..].Equals(username, StringComparison.OrdinalIgnoreCase)
                )
                    commandText = commandToken[..at] + text[commandToken.Length..];
                if (
                    MessageRouter.TryReadCommand(commandText, out var command, out var rawArgs)
                    && await router.HandleExternalCommandAsync(context, command, rawArgs)
                )
                    return;
            }
            await router.HandleExternalMessageAsync(context, new([new JsonObject { ["text"] = text }]));
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
        var deliveryToken = sessions.ScheduledProducers is null ? stopping.Token : cursors?.Closing ?? default;
        var file = await ApiAsync(
            "getFile",
            new JsonObject { ["file_id"] = fileId },
            deliveryToken
        );
        var filePath =
            SessionWait.Text(file?["file_path"])
            ?? throw new InvalidDataException("Telegram file has no download path.");
        async Task<byte[]> Download()
        {
            using var response = await http.GetAsync(new Uri(files, filePath), HttpCompletionOption.ResponseHeadersRead, deliveryToken);
            response.EnsureSuccessStatusCode();
            return await sessions.ReadChannelBodyAsync(response.Content, deliveryToken);
        }
        var unique = SessionWait.Text(media["file_unique_id"]) ?? fileId;
        var name = photo is not null
            ? "telegram-photo-" + unique + ".jpg"
            : SessionWait.Text(media["file_name"]) ?? "telegram-document-" + unique;
        var mime = photo is not null
            ? "image/jpeg"
            : SessionWait.Text(media["mime_type"]) ?? "application/octet-stream";
        var incoming = await sessions.ReceiveRemoteChannelFileAsync(
            "telegram",
            chat,
            Download,
            name,
            mime,
            SessionWait.Text(message["caption"]) ?? "",
            deliveryToken
        );
        await router.HandleExternalMessageAsync(context, incoming);
    }

    private async Task ObserveAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception error)
        {
            health.Log(error);
        }
    }

    private static string Identity(JsonValue value) =>
        SessionWait.Text(value) ?? value.ToJsonText();

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

    // The chat a conversation delivers to: its leading integer. Every send path and the
    // transport's canonical conversation use it.
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
                    body.Add(new StringContent(Chat(conversation).ToJsonText()), "chat_id");
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
                var result = await send();
                health.Recover(SendingPath);
                return result;
            }
            catch (Exception error)
                when (error is not OperationCanceledException
                    && error is not TelegramApiException { Payload: true }
                )
            {
                if (attempt >= 3)
                {
                    if (ChannelFailure.ChannelLevel(error, token))
                        health.Fail(SendingPath, error);
                    throw;
                }
                health.Log(error);
                await delay(TimeSpan.FromSeconds(attempt == 0 ? 5 : 10), token);
            }
        }
    }

    private async Task<JsonNode?> ApiAsync(string method, JsonObject body, CancellationToken token)
    {
        using var content = new StringContent(
            body.ToJsonText(),
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
