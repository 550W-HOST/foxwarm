using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm;

internal sealed partial class McpClient
{
    private sealed class Connection(SdkClient client, IClientTransport transport) : IAsyncDisposable
    {
        internal SdkClient Client => client;
        private Task? disposal;

        public ValueTask DisposeAsync()
        {
            lock (this)
                return new(disposal ??= CloseAsync());
        }

        private async Task CloseAsync()
        {
            try
            {
                await client.DisposeAsync();
            }
            finally
            {
                if (transport is IAsyncDisposable disposable)
                    await disposable.DisposeAsync();
            }
        }
    }

    // Owner is a trusted in-process Session lifetime, never a supplied Session ID.
    private sealed record ConnectionKey(
        string Server,
        SessionOwner? Owner,
        long Generation,
        string? Process,
        McpExternalContext? External = null
    );

    private sealed class PoolEntry
    {
        internal readonly ConnectionKey Key;
        internal readonly JsonObject Config;
        internal readonly CancellationTokenSource Lifetime;
        internal readonly CancellationToken Token;

        internal PoolEntry(ConnectionKey key, JsonObject config, CancellationToken shutdown)
        {
            Key = key;
            Config = config;
            Lifetime = CancellationTokenSource.CreateLinkedTokenSource(shutdown);
            Token = Lifetime.Token;
        }

        internal readonly TaskCompletionSource<Connection> Connected = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly ReceiveTransport Receiver = new();
        internal Reception? Reception;
        internal int NotificationStarts;
        internal int Active;
        internal bool Invalid;
        internal bool Retiring;
        internal Task? Closed;
        internal CancellationTokenSource? Idle;
    }

    private readonly object poolGate = new();
    private readonly Dictionary<ConnectionKey, PoolEntry> pool = [];
    private readonly HashSet<Task> closing = [];
    private readonly HashSet<PoolEntry> retiringConnections = [];

    private static string ProcessSettings(JsonObject config)
    {
        var settings = new JsonObject();
        foreach (var key in new[] { "command", "args", "env", "cwd", "stderr" })
            settings[key] = config[key]?.DeepClone();
        return settings.ToJsonString();
    }

    private async Task<T> WithClientAsync<T>(
        string server,
        CancellationToken token,
        SessionOwner? owner,
        long? ownerGeneration,
        Func<SdkClient, JsonObject, CancellationToken, Task<T>> operation,
        McpExternalContext? external = null
    ) =>
        await OAuth.GuardAsync(
            configuration.Get(server),
            () => WithClientCoreAsync(server, token, owner, ownerGeneration, operation, external),
            external is null ? null : (value, secrets) => ValidateExternalResult(value, secrets)
        );

    private async Task<T> WithClientCoreAsync<T>(
        string server,
        CancellationToken token,
        SessionOwner? owner,
        long? ownerGeneration,
        Func<SdkClient, JsonObject, CancellationToken, Task<T>> operation,
        McpExternalContext? external = null
    )
    {
        if (owner is null && external is null)
            throw new ArgumentException("MCP calls require a Session owner or external context.");
        PoolEntry entry;
        JsonObject config;
        var create = false;
        lock (poolGate)
        {
            token.ThrowIfCancellationRequested();
            shutdown.Token.ThrowIfCancellationRequested();
            external?.Require();
            using var admission = owner?.Entry.AdmitMutation();
            if (owner is not null)
            {
                owner.Entry.RequireIdentityAuthority();
                if (owner.Entry.Retired || owner.McpGeneration != ownerGeneration)
                    throw new InvalidOperationException(
                        "MCP caller lifetime changed before execution."
                    );
            }
            config = configuration.Get(server);
            var stdio = SessionWait.Text(config["transport"]) == "stdio";
            var key = new ConnectionKey(
                server,
                stdio ? null : owner,
                stdio ? 0 : ownerGeneration ?? 0,
                stdio ? ProcessSettings(config) : null,
                stdio ? null : external
            );
            if (pool.TryGetValue(key, out entry!) && !MatchesConfiguration(entry, config))
                InvalidateEntry(entry, preserveActiveStdio: true);
            if (entry is null || entry.Invalid)
            {
                entry = new(key, config, shutdown.Token);
                pool[key] = entry;
                create = true;
            }
            entry.Active++;
            entry.Idle?.Cancel();
            entry.Idle = null;
        }
        if (create)
            TrackClosing(ConnectEntryAsync(entry));
        async Task<T> InvokeAsync(SdkClient client, CancellationToken requestToken)
        {
            try
            {
                var value = await operation(client, config, requestToken);
                return external is null
                    ? value
                    : ValidateExternalResult(value, OAuth.Credentials(), config);
            }
            catch (OperationCanceledException) when (requestToken.IsCancellationRequested)
            {
                throw;
            }
            catch (McpInboundSafeException)
            {
                throw;
            }
            catch (Exception error)
            {
                // Use the exact configuration which supplied this connection's credentials,
                // even if a concurrent mutation has already published another configuration.
                throw new InvalidOperationException(SafeError(error.Message, config));
            }
        }
        var cancelled = false;
        try
        {
            using var request = CancellationTokenSource.CreateLinkedTokenSource(token, entry.Token);
            var connection = await entry.Connected.Task.WaitAsync(request.Token);
            // Lifecycle invalidation can cancel a lease; ordinary Stop only cancels this request.
            request.Token.ThrowIfCancellationRequested();
            external?.Require();
            return await InvokeAsync(connection.Client, request.Token);
        }
        catch (OperationCanceledException)
        {
            cancelled = true;
            if (entry.Token.IsCancellationRequested && !token.IsCancellationRequested)
                throw new InvalidOperationException(
                    "MCP connection was invalidated; started effects may have occurred and were not reversed."
                );
            throw;
        }
        finally
        {
            lock (poolGate)
            {
                entry.Active--;
                if (entry.Active == 0 && entry.Retiring)
                {
                    entry.Retiring = false;
                    CloseEntry(entry);
                }
                if (entry.Active == 0 && !entry.Invalid && !shutdown.IsCancellationRequested)
                {
                    if (cancelled && entry.Key.Process is null)
                        InvalidateEntry(entry);
                    else if (entry.Reception is null)
                    {
                        var idle = new CancellationTokenSource();
                        entry.Idle = idle;
                        TrackClosing(IdleCloseAsync(entry, idle));
                    }
                }
            }
        }
    }

    private async Task ConnectEntryAsync(PoolEntry entry)
    {
        try
        {
            // Shared initialization can outlive its initiating waiter. Keep its selected
            // credentials until ConnectAsync has produced a safe error, before publishing
            // that error to any waiter; GuardAsync then clears this bounded inventory.
            var connection = await OAuth.GuardAsync(
                entry.Config,
                () => ConnectAsync(entry.Key.Server, entry.Config, entry.Token, entry)
            );
            lock (poolGate)
            {
                if (
                    !entry.Invalid
                    && !entry.Lifetime.IsCancellationRequested
                    && MatchesConfiguration(entry, CurrentConfiguration(entry.Key.Server))
                )
                {
                    entry.Connected.TrySetResult(connection);
                    TrackClosing(ObserveDisconnectAsync(entry, connection));
                    return;
                }
                InvalidateEntry(entry);
            }
            await connection.DisposeAsync();
            entry.Connected.TrySetCanceled();
        }
        catch (Exception error)
        {
            entry.Connected.TrySetException(error);
            lock (poolGate)
                InvalidateEntry(entry);
        }
    }

    private async Task ObserveDisconnectAsync(PoolEntry entry, Connection connection)
    {
        try
        {
            await connection.Client.Completion;
        }
        catch { }
        lock (poolGate)
            InvalidateEntry(entry);
    }

    // Called under poolGate. Cancellation fences initialization and removes the binding
    // before a subsequent acquisition; SDK disposal owns any HTTP DELETE.
    private void InvalidateEntry(
        PoolEntry entry,
        bool preserveActiveStdio = false,
        bool drainActive = false
    )
    {
        if (entry.Invalid)
            return;
        entry.Invalid = true;
        entry.Reception = null;
        entry.Idle?.Cancel();
        if (pool.GetValueOrDefault(entry.Key) == entry)
            pool.Remove(entry.Key);
        // Process-key changes preserve admitted stdio work. Terminal notification
        // fencing also lets already-admitted ordinary leases settle before close.
        // Neither binding can be acquired again or published from late initialization.
        if (
            (drainActive || preserveActiveStdio && entry.Key.Process is not null)
            && entry.Active > 0
            && entry.Connected.Task.IsCompletedSuccessfully
        )
        {
            entry.Retiring = true;
            return;
        }
        CloseEntry(entry);
    }

    private void CloseEntry(PoolEntry entry)
    {
        entry.Lifetime.Cancel();
        retiringConnections.Add(entry);
        TrackClosing(entry.Closed = CloseEntryAsync(entry));
        _ = entry.Closed.ContinueWith(
            _ =>
            {
                lock (poolGate)
                    retiringConnections.Remove(entry);
            },
            CancellationToken.None,
            TaskContinuationOptions.None,
            TaskScheduler.Default
        );
    }

    private static async Task CloseEntryAsync(PoolEntry entry)
    {
        try
        {
            var connection = await entry.Connected.Task;
            await connection.DisposeAsync();
        }
        catch { }
        finally
        {
            entry.Lifetime.Dispose();
        }
    }

    internal void InvalidateOwner(SessionOwner owner)
    {
        lock (poolGate)
        {
            owner.AdvanceMcpGeneration();
            foreach (
                var entry in pool
                    .Values.Where(entry => ReferenceEquals(entry.Key.Owner, owner))
                    .ToArray()
            )
                InvalidateEntry(entry);
        }
    }

    internal async Task ReleaseExternalAsync(McpExternalContext context)
    {
        Task[] pending;
        lock (poolGate)
        {
            var entries = pool
                .Values.Concat(retiringConnections)
                .Distinct()
                .Where(entry => ReferenceEquals(entry.Key.External, context))
                .ToArray();
            foreach (var entry in entries)
                InvalidateEntry(entry);
            pending = entries.Select(entry => entry.Closed ?? Task.CompletedTask).ToArray();
        }
        await Task.WhenAll(pending);
    }

    private JsonObject? CurrentConfiguration(string server)
    {
        try
        {
            return configuration.Get(server);
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }

    private static bool MatchesConfiguration(PoolEntry entry, JsonObject? current) =>
        current is not null
        && (
            entry.Key.Process is null
                ? JsonNode.DeepEquals(entry.Config, current)
                : SessionWait.Text(current["transport"]) == "stdio"
                    && entry.Key.Process == ProcessSettings(current)
        );

    private void InvalidateServer(string server)
    {
        lock (poolGate)
        {
            var current = CurrentConfiguration(server);
            foreach (var entry in pool.Values.Where(entry => entry.Key.Server == server).ToArray())
                if (!MatchesConfiguration(entry, current))
                    InvalidateEntry(entry, preserveActiveStdio: true);
        }
    }

    private void FenceServer(string server)
    {
        lock (poolGate)
            foreach (var entry in pool.Values.Where(entry => entry.Key.Server == server).ToArray())
                InvalidateEntry(entry);
    }

    private async Task IdleCloseAsync(PoolEntry entry, CancellationTokenSource idle)
    {
        try
        {
            await Task.Delay(
                entry.Key.Process is not null ? TimeSpan.FromSeconds(60) : TimeSpan.FromMinutes(15),
                idle.Token
            );
            lock (poolGate)
                if (
                    entry.Active == 0
                    && entry.Reception is null
                    && entry.Idle == idle
                    && !entry.Invalid
                )
                    InvalidateEntry(entry);
        }
        catch (OperationCanceledException) { }
        finally
        {
            idle.Dispose();
        }
    }

    private async Task<Connection> ConnectAsync(
        string server,
        JsonObject config,
        CancellationToken token,
        PoolEntry entry
    )
    {
        IClientTransport transport;
        if (SessionWait.Text(config["transport"]) == "stdio")
        {
            var environment = StdioClientTransportOptions.GetDefaultEnvironmentVariables();
            if (config["env"] is JsonObject additions)
                foreach (var (key, value) in additions)
                    environment[key] = SessionWait.Text(value);
            transport = new StdioClientTransport(
                new StdioClientTransportOptions
                {
                    Name = server,
                    Command =
                        SessionWait.Text(config["command"])
                        ?? throw new InvalidDataException("MCP stdio requires command."),
                    Arguments = (config["args"] as JsonArray ?? new JsonArray())
                        .Select(value => SessionWait.Text(value)!)
                        .ToArray(),
                    WorkingDirectory = SessionWait.Text(config["cwd"]),
                    InheritEnvironmentVariables = false,
                    EnvironmentVariables = environment,
                    StandardErrorLines = line =>
                    {
                        if (SessionWait.Text(config["stderr"]) is null or "inherit")
                            Console.Error.WriteLine(SafeError(line, config));
                    },
                }
            );
        }
        else
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (SessionWait.Text(config["token"]) is string bearer)
                headers["Authorization"] = "Bearer " + bearer;
            if (config["headers"] is JsonObject additional)
                foreach (var (key, value) in additional)
                    headers[key] = SessionWait.Text(value)!;
            var options = new HttpClientTransportOptions
            {
                Name = server,
                Endpoint = new Uri(
                    SessionWait.Text(config["url"])
                        ?? throw new InvalidDataException("MCP HTTP requires url.")
                ),
                AdditionalHeaders = headers,
                OwnsSession = true,
                TransportMode = SessionWait.Text(config["transport"]) switch
                {
                    "streamable-http" => HttpTransportMode.StreamableHttp,
                    "sse" => HttpTransportMode.Sse,
                    _ => HttpTransportMode.AutoDetect,
                },
            };
            HttpMessageHandler Observe(HttpMessageHandler inner) =>
                new ReceiveTransport.Handler(
                    entry.Receiver,
                    () =>
                    {
                        lock (poolGate)
                            InvalidateEntry(entry);
                    },
                    inner,
                    config["oauth"] is not null,
                    OAuth.Credentials
                );
            var http = config["oauth"] is not null
                ? OAuth.ResourceClient(server, config, Observe)
                : new HttpClient(Observe(new HttpClientHandler()))
                {
                    Timeout = Timeout.InfiniteTimeSpan,
                };
            transport = new HttpClientTransport(options, http, ownsHttpClient: true);
        }
        try
        {
            var client = await SdkClient.CreateAsync(
                transport,
                new McpClientOptions
                {
                    InitializationTimeout = TimeSpan.FromSeconds(60),
                    Capabilities = new()
                    {
                        Experimental = entry.Key.Owner is not null
                            ? NotificationCapability()
                            : null,
                    },
                    Handlers = new()
                    {
                        NotificationHandlers = entry.Key.Owner is not null
                            ?
                            [
                                new KeyValuePair<
                                    string,
                                    Func<JsonRpcNotification, CancellationToken, ValueTask>
                                >(
                                    SessionMessageMethod,
                                    (message, notificationToken) =>
                                        ReceiveNotificationAsync(entry, message, notificationToken)
                                ),
                            ]
                            : [],
                    },
                },
                cancellationToken: token
            );
            return new(client, transport);
        }
        catch (Exception error)
        {
            if (transport is IAsyncDisposable disposable)
                await disposable.DisposeAsync();
            if (error is OperationCanceledException && token.IsCancellationRequested)
                throw;
            throw new InvalidOperationException(SafeError(error.Message, config));
        }
    }

    private void TrackClosing(Task task)
    {
        lock (poolGate)
            if (!task.IsCompleted)
                closing.Add(task);
        _ = task.ContinueWith(
            completed =>
            {
                _ = completed.Exception;
                lock (poolGate)
                    closing.Remove(completed);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default
        );
    }

    private async Task CloseConnectionsAsync()
    {
        lock (poolGate)
            foreach (var entry in pool.Values.ToArray())
                InvalidateEntry(entry);
        // Disconnect observers complete as the SDK clients are disposed. Initializers are
        // included so an invalidated late connection cannot outlive host shutdown.
        while (true)
        {
            Task[] pending;
            lock (poolGate)
                pending = closing.ToArray();
            if (pending.Length == 0)
                return;
            try
            {
                await Task.WhenAll(pending);
            }
            catch { }
        }
    }
}
