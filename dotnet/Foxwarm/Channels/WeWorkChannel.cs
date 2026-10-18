using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class WeWorkChannel : IManagedChannel
{
    private static readonly HttpClient DefaultHttp = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly string id;
    private readonly JsonObject config;
    private readonly SessionManager sessions;
    private readonly MessageRouter router;
    private readonly HttpClient http;
    private readonly Action<Exception> log;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly Func<DateTimeOffset> now;
    private readonly IPAddress callbackAddress;
    private readonly string webhook;
    private readonly WeWorkCrypto? crypto;
    private readonly bool streamEnabled;
    private readonly JsonObject websocketConfig;
    private bool WebSocketEnabled => SessionCatalog.Flag(websocketConfig["enabled"]);
    private readonly WeWorkStreamAggregator streams;
    private readonly object contextGate = new();
    private readonly Dictionary<string, (long At, JsonObject? Response)> processed = new(StringComparer.Ordinal);
    private readonly OrderedDictionary<string, string> responseUrls = new(StringComparer.Ordinal);
    private WebApplication? listener;
    private volatile bool stopped;
    private readonly CancellationTokenSource lifetime = new();

    internal WeWorkChannel(string id, JsonObject config, SessionManager sessions, MessageRouter router,
        ChannelTransportDependencies? dependencies, Action<Exception> log)
    {
        this.id = id;
        this.config = (JsonObject)config.DeepClone();
        this.sessions = sessions;
        this.router = router;
        this.log = log;
        http = dependencies?.CreateHttp?.Invoke() ?? DefaultHttp;
        delay = dependencies?.Delay ?? Task.Delay;
        now = dependencies?.Now ?? (() => DateTimeOffset.UtcNow);
        callbackAddress = dependencies?.CallbackAddress ?? IPAddress.IPv6Any;
        webhook = Text(config["webhookUrl"]);
        if (Text(config["token"]).Length > 0 && Text(config["encodingAESKey"]).Length > 0)
            crypto = new(Text(config["token"]), Text(config["encodingAESKey"]));
        streamEnabled = SessionCatalog.Flag(config["aibot"]?["stream"]);
        var requestedBytes = SessionWait.Number(config["aibot"]?["streamMaxContentBytes"]) ?? 20000;
        streams = new((int)Math.Clamp(requestedBytes == 0 ? 20000 : requestedBytes, 1, 20480), now);
        websocketConfig = config["aibot"]?["websocket"] as JsonObject ?? new();
    }

    private static string Text(JsonNode? node) => SessionWait.Text(node) ?? "";
    private static bool Nonempty(string? text) => !string.IsNullOrWhiteSpace(text);
    private static JsonObject Markdown(string text) => new()
    {
        ["msgtype"] = "markdown", ["markdown"] = new JsonObject { ["content"] = text },
    };

    public RegisteredChannel Transport => new("wework", SendTextAsync,
        (conversation, file, caption, token) => SendFileAsync(conversation, file, caption, new(), token),
        Finalize: (conversation, options, token) => LifecycleAsync(conversation, "", options, null, token),
        IsLifecycleActive: conversation => streams.Get(conversation) is { Finish: false },
        Progress: (conversation, progress, token) => LifecycleAsync(conversation, "", new(), progress, token));

    public async Task StartAsync()
    {
        stopped = false;
        if (SessionWait.Number(config["listenPort"]) is { } port && port != 0 && Nonempty(Text(config["listenPath"])))
            await StartListenerAsync((int)port, Text(config["listenPath"]));
        if (WebSocketEnabled)
            _ = ObserveAsync(ConnectionLoopAsync());
    }

    public Task StopAsync()
    {
        stopped = true;
        // Complete pending ACKs before receive cancellation can race its close-finally path.
        RejectPending(new IOException("WeWork AIBot WebSocket stopped"));
        lifetime.Cancel();
        CloseSocket();
        lock (contextGate)
            responseUrls.Clear();
        // Like the Source listener.close, stop admission without joining Router/send handlers.
        if (listener is { } active)
        {
            listener = null;
            _ = ObserveAsync(CloseListenerAsync(active));
        }
        return Task.CompletedTask;
    }

    private static async Task CloseListenerAsync(WebApplication app)
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }

    public async ValueTask DisposeAsync() => await StopAsync();

    private async Task ObserveAsync(Task task)
    {
        try { await task; }
        catch (OperationCanceledException) when (stopped) { }
        catch (Exception error) { log(error); }
    }

    private Task LifecycleAsync(string conversation, string text, ChannelSendOptions options, ChannelTurnProgress? progress, CancellationToken token)
    {
        if (streams.Get(conversation) is not { Finish: false } active)
            return Task.CompletedTask;
        return AggregateAsync(conversation, text, options with { StreamId = active.Id }, progress, token);
    }

    private async Task<bool> AggregateAsync(string conversation, string text, ChannelSendOptions options, ChannelTurnProgress? progress, CancellationToken token)
    {
        if (!streamEnabled)
            return false;
        var (handled, changed) = streams.Apply(conversation, text, options, progress);
        if (changed?.Delivery.Mode == "websocket")
            await PushStreamAsync(changed, token);
        return handled;
    }

    internal async Task SendTextAsync(string conversation, string text, ChannelSendOptions options, CancellationToken token)
    {
        try
        {
            if (options.StreamId is not null && !streamEnabled)
                return;
            if (await AggregateAsync(conversation, text, options, null, token) || options.StreamId is not null)
                return;
            var explicitWebhook = Nonempty(options.WebhookUrl) ? options.WebhookUrl : null;
            if (explicitWebhook is null && options.TurnFinal)
            {
                string? response;
                lock (contextGate)
                {
                    response = responseUrls.GetValueOrDefault(conversation);
                    if (response is not null)
                        responseUrls.Remove(conversation);
                }
                if (response is not null)
                {
                    await SendResponseAsync(response, text, token);
                    return;
                }
            }
            if (explicitWebhook is null && WebSocketEnabled)
            {
                await SendProactiveAsync(conversation, Markdown(text), options, token);
                return;
            }
            var url = explicitWebhook ?? webhook;
            if (!Nonempty(url))
                throw new InvalidOperationException("WeWork webhookUrl is not configured for proactive sendMessage");
            JsonObject payload;
            if (options.MessageType is null or "markdown")
                payload = Markdown(text);
            else
                payload = new()
                {
                    ["msgtype"] = "text",
                    ["text"] = new JsonObject
                    {
                        ["content"] = text,
                        ["mentioned_list"] = new JsonArray((options.MentionedList ?? []).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
                        ["mentioned_mobile_list"] = new JsonArray((options.MentionedMobileList ?? []).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
                    },
                };
            if (EffectiveChat(conversation, options) is { } chat)
                payload["chatid"] = chat;
            await PostWebhookAsync(url, payload, token);
        }
        catch (Exception error)
        {
            throw new IOException("Failed to send WeWork message: " + error.Message, error);
        }
    }

    private static string? EffectiveChat(string conversation, ChannelSendOptions options) =>
        Nonempty(options.ChatId) ? options.ChatId : conversation.StartsWith("wok", StringComparison.Ordinal) || conversation.StartsWith("wrk", StringComparison.Ordinal) ? conversation : null;

    private async Task<JsonObject> PostAsync(string url, HttpContent content, int timeoutMs, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(timeoutMs);
        using var response = await http.PostAsync(url, content, timeout.Token);
        response.EnsureSuccessStatusCode();
        var bytes = await response.Content.ReadAsByteArrayAsync(timeout.Token);
        // Axios leaves non-JSON successful bodies as strings. Missing errcode is accepted only on response_url.
        try { return JsonNode.Parse(bytes) as JsonObject ?? new(); }
        catch (System.Text.Json.JsonException) { return new(); }
    }

    private async Task SendResponseAsync(string url, string text, CancellationToken token)
    {
        var result = await PostAsync(url, JsonContent.Create(Markdown(text)), 10000, token);
        if (result.ContainsKey("errcode") && !Zero(result["errcode"]))
            throw new IOException($"WeWork aibot response failed: {Text(result["errmsg"])} (code: {result["errcode"]})");
    }

    private static bool Zero(JsonNode? code) => SessionWait.Number(code) == 0;

    private async Task PostWebhookAsync(string url, JsonObject payload, CancellationToken token)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                var result = await PostAsync(url, JsonContent.Create(payload), 10000, token);
                if (!Zero(result["errcode"]))
                    throw new IOException($"WeWork API error: {Text(result["errmsg"])} (code: {result["errcode"]})");
                return;
            }
            catch (Exception error) when (attempt < 3 && !token.IsCancellationRequested && (error is not HttpRequestException request || request.StatusCode is null || (int)request.StatusCode >= 500))
            {
                await delay(TimeSpan.FromSeconds(attempt), token);
            }
        }
    }

    private Task SendProactiveAsync(string conversation, JsonObject payload, ChannelSendOptions options, CancellationToken token)
    {
        var body = new JsonObject { ["chatid"] = Nonempty(options.ChatId) ? options.ChatId : conversation };
        int? type = options.NativeChatType ?? (options.ChatType switch { "single" => 1, "group" => 2, _ => (int?)null });
        if (type is not null)
            body["chat_type"] = type;
        foreach (var (key, value) in payload)
            body[key] = value?.DeepClone();
        return SendCommandAsync("aibot_send_msg", body, null, token);
    }

    private Task PushStreamAsync(WeWorkStreamSnapshot snapshot, CancellationToken token) =>
        snapshot.Delivery.Mode == "websocket" && Nonempty(snapshot.Delivery.ReqId)
            ? SendCommandAsync("aibot_respond_msg", snapshot.Payload(), snapshot.Delivery.ReqId, token)
            : Task.CompletedTask;
}
