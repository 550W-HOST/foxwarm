using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

// A dependency seam for the ordinary HTTP transport; not a production endpoint configuration.
internal sealed record ChannelTransportDependencies(
    Func<HttpClient>? CreateHttp = null,
    Func<string, Uri>? TelegramApi = null,
    Func<string, Uri>? TelegramFiles = null,
    Func<TimeSpan, CancellationToken, Task>? Delay = null,
    Func<DateTimeOffset>? Now = null,
    System.Net.IPAddress? CallbackAddress = null,
    Func<HttpClient>? CreateQQBotHttp = null,
    TimeSpan? QQBotMediaTimeout = null,
    TimeSpan? QQBotPartTimeout = null
);

internal sealed class ManagedChannels(
    SessionManager sessions,
    MessageRouter router,
    ModelConfiguration configuration,
    ChannelTransportDependencies? dependencies = null
) : IAsyncDisposable
{
    internal WeixinApi Weixin { get; } = new(dependencies);

    private static bool Implemented(string type) =>
        type is "telegram" or "matrix" or "weixin" or "wework" or "qqbot";

    private readonly Dictionary<string, IManagedChannel> running = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> errors = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private bool closed;

    internal static string Type(string id, JsonObject config) =>
        SessionWait.Text(config["type"])?.Trim() is { Length: > 0 } type ? type : id;

    private JsonObject Config(string id) =>
        configuration.CurrentChannels()[id] as JsonObject
        ?? throw new InvalidDataException("Channel is not configured: " + id);

    internal JsonArray Statuses(bool webUiRunning = false)
    {
        var entries = configuration.CurrentChannels();
        var ids = entries
            .Select(pair => pair.Key)
            .Concat(sessions.ChannelRegistry.Ids())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal);
        var result = new JsonArray();
        lock (gate)
            foreach (var id in ids)
            {
                var config = entries[id] as JsonObject ?? new JsonObject();
                var registered = sessions.ChannelRegistry.Get(id);
                var type = registered?.Type ?? Type(id, config);
                var implemented = Implemented(type) && id is not ("webui" or "tui");
                var enabled = config["enabled"]?.GetValue<bool>() != false;
                var configured =
                    registered is not null || ModelConfiguration.IsConfigured(type, config);
                result.Add(
                    new JsonObject
                    {
                        ["channelId"] = id,
                        ["type"] = type,
                        ["managed"] = implemented,
                        ["running"] = registered is not null || id == "webui" && webUiRunning,
                        ["configured"] = configured,
                        ["enabled"] = enabled,
                        ["details"] = new JsonArray(
                            implemented
                                ? type == "qqbot"
                                    ? "QQ Bot gateway"
                                    : type == "wework"
                                        ? "WeWork callback/webhook/WebSocket"
                                        : type + " polling"
                                : registered is not null
                                    ? "Registered transport"
                                    : "Adapter is not implemented on this server."
                        ),
                        ["lastError"] =
                            errors.GetValueOrDefault(id)
                            ?? (
                                !implemented && registered is null && enabled
                                    ? "Adapter is not implemented on this server."
                                    : null
                            ),
                    }
                );
            }
        return result;
    }

    internal async Task<JsonObject> ReloadAsync()
    {
        if (closed)
            throw new InvalidOperationException("Channel runtime is shutting down.");
        sessions.ChannelProgress.Reset();
        string[] previous;
        lock (gate)
            previous = running.Keys.Order(StringComparer.Ordinal).ToArray();
        var stopped = new JsonArray();
        foreach (var id in previous)
            try
            {
                if (await StopCoreAsync(id))
                    stopped.Add(id);
            }
            catch (Exception error)
            {
                RecordError(id, error);
            }
        var started = new JsonArray();
        foreach (
            var (id, raw) in configuration
                .CurrentChannels()
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
        )
        {
            var config = raw as JsonObject ?? new JsonObject();
            if (
                id is "webui" or "tui"
                || !Implemented(Type(id, config))
                || config["enabled"]?.GetValue<bool>() == false
                || !ModelConfiguration.IsConfigured(Type(id, config), config)
            )
                continue;
            try
            {
                if (await StartCoreAsync(id))
                    started.Add(id);
            }
            catch (Exception error)
            {
                RecordError(id, error);
            }
        }
        return new JsonObject
        {
            ["started"] = started,
            ["stopped"] = stopped,
            ["statuses"] = Statuses(),
            ["available"] = true,
        };
    }

    internal async Task ChangeAsync(string action, string id)
    {
        try
        {
            if (closed)
                throw new InvalidOperationException("Channel runtime is shutting down.");
            if (!Implemented(Type(id, Config(id))) || id is "webui" or "tui")
                throw new InvalidOperationException(
                    "Adapter is not implemented on this server: " + id
                );
            if (action is "stop" or "restart")
                await StopCoreAsync(id);
            if (action is "start" or "restart")
                await StartCoreAsync(id);
        }
        catch (Exception error)
        {
            RecordError(id, error);
            throw;
        }
    }

    private async Task<bool> StartCoreAsync(string id)
    {
        lock (gate)
            if (running.ContainsKey(id))
                return false;
        if (sessions.ChannelRegistry.Get(id) is not null)
            throw new InvalidOperationException("Channel ID is already registered: " + id);
        var config = Config(id);
        IManagedChannel channel = Type(id, config) switch
        {
            "telegram" => new TelegramChannel(
                id,
                config,
                sessions,
                router,
                dependencies,
                error => RecordError(id, error)
            ),
            "matrix" => new MatrixChannel(
                id,
                config,
                sessions,
                router,
                dependencies,
                error => RecordError(id, error)
            ),
            "qqbot" => new QQBotChannel(
                id,
                config,
                sessions,
                router,
                dependencies,
                error => RecordError(id, error)
            ),
            "wework" => new WeWorkChannel(
                id,
                config,
                sessions,
                router,
                dependencies,
                error => RecordError(id, error)
            ),
            "weixin" => new WeixinChannel(
                id,
                config,
                router,
                Weixin,
                error => RecordError(id, error)
            ),
            _ => throw new InvalidOperationException(
                "Adapter is not implemented on this server: " + id
            ),
        };
        try
        {
            await channel.StartAsync();
            sessions.ChannelRegistry.Register(id, channel.Transport);
            lock (gate)
            {
                running.Add(id, channel);
                errors.Remove(id);
            }
            if (
                SessionWait.Text(
                    config[Type(id, config) == "matrix" ? "botUserId" : "mainAttachUser"]
                )
                    is { Length: > 0 } conversation
                && sessions.ChannelBinding(id + ":" + conversation) is null
            )
                sessions.AttachConfiguredChannel(id + ":" + conversation, "main");
            return true;
        }
        catch
        {
            await channel.DisposeAsync();
            throw;
        }
    }

    private async Task<bool> StopCoreAsync(string id)
    {
        IManagedChannel? channel;
        lock (gate)
            channel = running.GetValueOrDefault(id);
        if (channel is null)
            return false;
        await channel.DisposeAsync();
        sessions.ChannelRegistry.Unregister(id);
        lock (gate)
            running.Remove(id);
        return true;
    }

    private void RecordError(string id, Exception error)
    {
        var safe = error is TelegramApiException telegram
            ? $"Telegram API request failed ({telegram.Code})."
            : configuration.SafeAppError(error);
        lock (gate)
            errors[id] = safe;
        Console.Error.WriteLine("Channel " + id + ": " + safe);
    }

    internal async Task StopIngressAsync()
    {
        closed = true;
        IManagedChannel[] current;
        lock (gate)
            current = running.Values.ToArray();
        await Task.WhenAll(current.Select(channel => channel.StopAsync()));
    }

    public async ValueTask DisposeAsync()
    {
        await StopIngressAsync();
        string[] ids;
        lock (gate)
            ids = running.Keys.ToArray();
        foreach (var id in ids)
            await StopCoreAsync(id);
        sessions.ChannelProgress.Reset();
    }
}
