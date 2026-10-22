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
    private readonly Dictionary<
        string,
        (IManagedChannel Channel, TaskCompletionSource Settled)
    > starting = new(StringComparer.Ordinal);

    // Only initial-start intent: reload and successful explicit stop take over this policy.
    private readonly HashSet<string> initialStarts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> errors = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private volatile bool closed;
    private Task? ingressStop;
    private Task? initialStartup;
    private readonly CancellationTokenSource initialStop = new();

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

    // Normal startup is independent per adapter; configuration reload deliberately stays sequential.
    internal Task StartInitialAsync()
    {
        lock (gate)
            return initialStartup ??= StartInitialCoreAsync();
    }

    private async Task StartInitialCoreAsync()
    {
        try
        {
            var entries = configuration.CurrentChannels().ToArray();
            var eligible = new List<(string Id, string Type)>();
            foreach (var (id, raw) in entries)
            {
                var config = raw as JsonObject ?? new JsonObject();
                if (Eligible(id, config))
                    eligible.Add((id, Type(id, config)));
                else
                {
                    var reason =
                        id is "webui" or "tui" ? "reserved transport"
                        : !Implemented(Type(id, config)) ? "adapter unavailable"
                        : config["enabled"]?.GetValue<bool>() == false ? "disabled"
                        : "missing required credentials";
                    Console.WriteLine($"Channel {id} startup skipped: {reason}.");
                }
            }
            lock (gate)
                foreach (var entry in eligible)
                    initialStarts.Add(entry.Id);
            var outcomes = await Task.WhenAll(
                eligible.Select(entry => StartWithRetryAsync(entry.Id, entry.Type))
            );
            Console.WriteLine(
                $"Channel startup settled: registered={outcomes.Count(value => value)}, unavailable={outcomes.Count(value => !value)}, skipped={entries.Length - eligible.Count}, stopping={closed}."
            );
        }
        catch (Exception error)
        {
            // This is retained background startup, not a detached unobserved exception.
            Console.Error.WriteLine(
                "Channel initial startup failed: " + MainLog.SafeFailure(error)
            );
        }
    }

    private static bool Eligible(string id, JsonObject config) =>
        id is not ("webui" or "tui")
        && Implemented(Type(id, config))
        && config["enabled"]?.GetValue<bool>() != false
        && ModelConfiguration.IsConfigured(Type(id, config), config);

    private async Task<bool> StartWithRetryAsync(string id, string type)
    {
        try
        {
            var attempts = type == "telegram" ? 4 : 2;
            var pause = TimeSpan.FromSeconds(type == "telegram" ? 5 : 3);
            for (var attempt = 1; attempt <= attempts && !closed; attempt++)
            {
                Console.WriteLine($"Channel {id} ({type}) startup attempt {attempt}/{attempts}.");
                try
                {
                    return await StartCoreAsync(id, initial: true);
                }
                catch (OperationCanceledException) when (closed)
                {
                    return false;
                }
                catch (Exception error)
                {
                    if (closed)
                        return false;
                    RecordError(id, error);
                    if (attempt == attempts)
                        break;
                    try
                    {
                        await (dependencies?.Delay ?? Task.Delay)(pause, initialStop.Token);
                    }
                    catch (OperationCanceledException) when (closed)
                    {
                        return false;
                    }
                }
            }
            if (!closed)
                Console.Error.WriteLine(
                    $"Channel {id} ({type}) initial startup attempts exhausted."
                );
            return false;
        }
        finally
        {
            lock (gate)
                initialStarts.Remove(id);
        }
    }

    internal async Task<JsonObject> ReloadAsync()
    {
        if (closed)
            throw new InvalidOperationException("Channel runtime is shutting down.");
        sessions.ChannelProgress.Reset();
        string[] previous;
        lock (gate)
        {
            initialStarts.Clear();
            previous = running.Keys.Order(StringComparer.Ordinal).ToArray();
        }
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
            if (!Eligible(id, config))
                continue;
            try
            {
                if (await StartCoreAsync(id))
                    started.Add(id);
            }
            catch (OperationCanceledException) when (closed)
            {
                break;
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
            {
                await StopCoreAsync(id);
                lock (gate)
                    initialStarts.Remove(id);
            }
            if (action is "start" or "restart")
                await StartCoreAsync(id);
        }
        catch (Exception error)
        {
            RecordError(id, error);
            throw;
        }
    }

    private async Task<bool> StartCoreAsync(string id, bool initial = false)
    {
        lock (gate)
            if (
                closed
                || running.ContainsKey(id)
                || starting.ContainsKey(id)
                || initial && !initialStarts.Contains(id)
            )
                return false;
        if (sessions.ChannelRegistry.Get(id) is not null)
            throw new InvalidOperationException("Channel ID is already registered: " + id);
        var config = configuration.CurrentChannels()[id] as JsonObject;
        if (initial && (config is null || !Eligible(id, config)))
            return false;
        config ??= Config(id);
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
        var settled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var published = false;
        var initializing = false;
        try
        {
            Task startup;
            lock (gate)
            {
                if (
                    closed
                    || running.ContainsKey(id)
                    || starting.ContainsKey(id)
                    || initial && !initialStarts.Contains(id)
                )
                    return false;
                errors.Remove(id);
                starting.Add(id, (channel, settled));
                initializing = true;
                // Stop cannot precede an adapter's synchronous start admission.
                startup = channel.StartAsync();
            }
            await startup;
            lock (gate)
            {
                if (closed)
                    return false;
                sessions.ChannelRegistry.Register(id, channel.Transport);
                running.Add(id, channel);
                if (
                    SessionWait.Text(
                        config[Type(id, config) == "matrix" ? "botUserId" : "mainAttachUser"]
                    )
                        is { Length: > 0 } conversation
                    && sessions.ChannelBinding(id + ":" + conversation) is null
                )
                    sessions.AttachConfiguredChannel(id + ":" + conversation, "main");
                published = true;
            }
            Console.WriteLine($"Channel {id} ({Type(id, config)}) transport registered.");
            return true;
        }
        finally
        {
            try
            {
                if (!published)
                    await channel.DisposeAsync();
            }
            finally
            {
                lock (gate)
                    if (initializing)
                        starting.Remove(id);
                settled.TrySetResult();
            }
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
        var safe = ChannelFailure.Describe(error);
        lock (gate)
            errors[id] = safe;
        Console.Error.WriteLine("Channel " + id + ": " + safe);
    }

    internal Task StopIngressAsync()
    {
        lock (gate)
            return ingressStop ??= StopIngressCoreAsync();
    }

    private async Task StopIngressCoreAsync()
    {
        IManagedChannel[] current;
        Task[] initializers;
        lock (gate)
        {
            closed = true;
            initialStop.Cancel();
            current = running
                .Values.Concat(starting.Values.Select(value => value.Channel))
                .Distinct()
                .ToArray();
            initializers = starting
                .Values.Select(value => value.Settled.Task)
                .Concat(initialStartup is null ? [] : new[] { initialStartup })
                .ToArray();
        }
        await Task.WhenAll(current.Select(channel => channel.StopAsync()));
        await Task.WhenAll(initializers);
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
