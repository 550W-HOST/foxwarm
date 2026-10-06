using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ModelContextProtocol.Client;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm;

internal sealed partial class McpClient
{
    private sealed record Connection(SdkClient Client, IClientTransport Transport)
        : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            try
            {
                await Client.DisposeAsync();
            }
            finally
            {
                if (Transport is IAsyncDisposable disposable)
                    await disposable.DisposeAsync();
            }
        }
    }

    private sealed class PoolEntry(string key)
    {
        internal readonly string Key = key;
        internal readonly TaskCompletionSource<Connection> Connected = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal int Active;
        internal bool Invalid;
        internal CancellationTokenSource? Idle;
        internal Task? IdleTask;
    }

    private readonly object poolGate = new();
    private readonly Dictionary<string, PoolEntry> pool = new(StringComparer.Ordinal);
    private readonly HashSet<Task> closing = [];

    private async Task<T> WithClientAsync<T>(
        string server,
        JsonObject config,
        CancellationToken token,
        Func<SdkClient, Task<T>> operation
    )
    {
        if (SessionWait.Text(config["transport"]) != "stdio")
        {
            await using var connection = await ConnectAsync(server, config, token);
            try
            {
                return await operation(connection.Client);
            }
            catch (OperationCanceledException)
            {
                await Task.Delay(100);
                throw;
            }
        }
        var connectionSettings = new JsonObject();
        foreach (var key in new[] { "command", "args", "env", "cwd", "stderr" })
            connectionSettings[key] = config[key]?.DeepClone();
        var poolKey = server + ":" + connectionSettings.ToJsonString();
        PoolEntry entry;
        var create = false;
        lock (poolGate)
        {
            if (shutdown.IsCancellationRequested)
                throw new OperationCanceledException(token);
            if (!pool.TryGetValue(poolKey, out entry!) || entry.Invalid)
            {
                entry = new(poolKey);
                pool[poolKey] = entry;
                create = true;
            }
            entry.Active++;
            entry.Idle?.Cancel();
            entry.Idle = null;
        }
        if (create)
            _ = ConnectEntryAsync(entry, server, config);
        try
        {
            var connection = await entry.Connected.Task.WaitAsync(token);
            return await operation(connection.Client);
        }
        finally
        {
            lock (poolGate)
            {
                entry.Active--;
                if (entry.Active == 0 && !entry.Invalid && !shutdown.IsCancellationRequested)
                {
                    var idle = new CancellationTokenSource();
                    entry.Idle = idle;
                    entry.IdleTask = IdleCloseAsync(entry, idle);
                    TrackClosing(entry.IdleTask);
                }
            }
        }
    }

    private async Task ConnectEntryAsync(PoolEntry entry, string server, JsonObject config)
    {
        try
        {
            var connection = await ConnectAsync(server, config, shutdown.Token);
            entry.Connected.TrySetResult(connection);
            _ = ObserveDisconnectAsync(entry, connection);
        }
        catch (Exception error)
        {
            lock (poolGate)
            {
                entry.Invalid = true;
                if (pool.GetValueOrDefault(entry.Key) == entry)
                    pool.Remove(entry.Key);
            }
            entry.Connected.TrySetException(error);
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
        {
            if (entry.Invalid)
                return;
            entry.Invalid = true;
            entry.Idle?.Cancel();
            if (pool.GetValueOrDefault(entry.Key) == entry)
                pool.Remove(entry.Key);
            TrackClosing(connection.DisposeAsync().AsTask());
        }
    }

    private async Task IdleCloseAsync(PoolEntry entry, CancellationTokenSource idle)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(60), idle.Token);
            lock (poolGate)
            {
                if (entry.Active != 0 || entry.Idle != idle || entry.Invalid)
                    return;
                entry.Invalid = true;
                if (pool.GetValueOrDefault(entry.Key) == entry)
                    pool.Remove(entry.Key);
            }
            var connection = await entry.Connected.Task;
            await connection.DisposeAsync();
        }
        catch (OperationCanceledException) { }
        catch { }
        finally
        {
            idle.Dispose();
        }
    }

    private async Task<Connection> ConnectAsync(
        string server,
        JsonObject config,
        CancellationToken token
    )
    {
        IClientTransport transport;
        if (SessionWait.Text(config["transport"]) == "stdio")
        {
            var environment = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var key in new[] { "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER" })
                if (
                    Environment.GetEnvironmentVariable(key) is string value
                    && !value.StartsWith("()", StringComparison.Ordinal)
                )
                    environment[key] = value;
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
            transport = new HttpClientTransport(
                new HttpClientTransportOptions
                {
                    Name = server,
                    Endpoint = new Uri(
                        SessionWait.Text(config["url"])
                            ?? throw new InvalidDataException("MCP HTTP requires url.")
                    ),
                    AdditionalHeaders = headers,
                    TransportMode = SessionWait.Text(config["transport"]) switch
                    {
                        "streamable-http" => HttpTransportMode.StreamableHttp,
                        "sse" => HttpTransportMode.Sse,
                        _ => HttpTransportMode.AutoDetect,
                    },
                }
            );
        }
        try
        {
            var client = await SdkClient.CreateAsync(
                transport,
                new McpClientOptions { InitializationTimeout = TimeSpan.FromSeconds(60) },
                cancellationToken: token
            );
            return new(client, transport);
        }
        catch
        {
            if (transport is IAsyncDisposable disposable)
                await disposable.DisposeAsync();
            throw;
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
        PoolEntry[] entries;
        lock (poolGate)
        {
            entries = pool.Values.ToArray();
            pool.Clear();
            foreach (var entry in entries)
            {
                entry.Invalid = true;
                entry.Idle?.Cancel();
            }
        }
        foreach (var entry in entries)
            try
            {
                var connection = await entry.Connected.Task;
                await connection.DisposeAsync();
            }
            catch { }
        Task[] pending;
        lock (poolGate)
            pending = closing.ToArray();
        try
        {
            await Task.WhenAll(pending);
        }
        catch { }
    }
}
