using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Vector;

internal sealed class VectorService : IAsyncDisposable
{
    private readonly string root;
    internal VectorConfiguration Configuration { get; }
    private readonly object lifecycle = new();
    private VectorRuntime? local;
    private Task? starting;
    private Process? child;
    private NamedPipeServerStream? pipe;
    private readonly SemaphoreSlim sending = new(1, 1);
    private sealed record Pending(Stream Transport, TaskCompletionSource<JsonNode?> Completion);
    private readonly ConcurrentDictionary<long, Pending> pending = new();
    private readonly ConcurrentDictionary<long, Task> localCalls = new();
    private long requestId;
    private volatile bool ready;
    private volatile bool stopping;
    private int restartDelay = 250;
    private CancellationTokenSource? restart;
    private readonly VectorLexicalRuntime preinitLexical;
    private bool started;
    internal int? ChildPid { get { lock (lifecycle) return child?.Id; } }
    internal bool Ready => ready;
    internal string Mode => !Configuration.Enabled ? "disabled" : Configuration.DbWorkers ? "worker" : "local";
    internal Action<string, string>? Diagnostic { get; set; }

    internal VectorService(string root, VectorConfiguration config)
    {
        this.root = Path.GetFullPath(root);
        Configuration = config;
        preinitLexical = new(Path.Combine(root, "state", "db"), Path.Combine(root, "state", "archive-store.sqlite"), config, TimeProvider.System);
    }
    internal Task StartAsync()
    {
        lock (lifecycle)
        {
            if (stopping)
                throw new VectorUnavailableException("VECTOR_SHUTTING_DOWN", "Vector service shutdown is still in progress.");
            if (!Configuration.Enabled)
                return Task.CompletedTask;
            started = true;
            return starting ??= StartCoreAsync();
        }
    }
    private async Task StartCoreAsync()
    {
        try
        {
            if (Configuration.DbWorkers)
                await StartChildAsync();
            else
            {
                var runtime = new VectorRuntime(root, Configuration) { Diagnostic = (code, session) => Diagnostic?.Invoke(code, session) };
                local = runtime;
                await runtime.StartAsync();
                ready = !stopping;
            }
        }
        catch
        {
            lock (lifecycle)
                starting = null;
            throw;
        }
    }
    internal static ProcessStartInfo ChildStart(string pipeName)
    {
        var process = Environment.ProcessPath ?? throw new InvalidOperationException("Main process path is unavailable.");
        var entry = Assembly.GetEntryAssembly();
        var isHostEntry = entry?.GetName().Name is "Foxwarm" or "Foxwarm.Desktop";
        var useCurrentApphost = isHostEntry && !Path.GetFileNameWithoutExtension(process).Equals("dotnet", StringComparison.OrdinalIgnoreCase);
        var start = new ProcessStartInfo(useCurrentApphost ? process : Path.GetFileNameWithoutExtension(process).Equals("dotnet", StringComparison.OrdinalIgnoreCase) ? process
            : Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT") ?? throw new InvalidOperationException("The .NET host path is unavailable."), OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (!useCurrentApphost)
            start.ArgumentList.Add(isHostEntry ? entry!.Location : typeof(VectorService).Assembly.Location);
        start.ArgumentList.Add("--foxwarm-vector-child");
        start.ArgumentList.Add(pipeName);
        return start;
    }
    private async Task StartChildAsync()
    {
        var name = "foxwarm-vector-" + Guid.NewGuid().ToString("N");
        var transport = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        Process process;
        lock (lifecycle)
        {
            if (child is not null)
                throw new VectorUnavailableException("VECTOR_UNAVAILABLE", "The previous Vector owner has not exited.");
            process = Process.Start(ChildStart(name)) ?? throw new IOException("Unable to start Vector owner.");
            child = process;
            pipe = transport;
        }
        _ = ObserveExitAsync(process, transport);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await transport.WaitForConnectionAsync(timeout.Token);
            _ = ReadResponsesAsync(process, transport);
            await ChildCallAsync("init", new() { ["root"] = root, ["configuration"] = JsonSerializer.SerializeToNode(Configuration, VectorWire.Json) }).WaitAsync(timeout.Token);
            lock (lifecycle)
            {
                if (stopping || child != process)
                    throw new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector owner startup was superseded.");
                ready = true;
                restartDelay = 250;
            }
        }
        catch
        {
            transport.Dispose();
            await TerminateAsync(process, TimeSpan.FromMilliseconds(666));
            throw;
        }
    }
    private async Task ReadResponsesAsync(Process process, Stream transport)
    {
        try
        {
            while (await VectorWire.ReadAsync(transport) is { } response)
            {
                var id = VectorRuntime.Integer(response["id"]);
                if (!pending.TryGetValue(id, out var request) || !ReferenceEquals(request.Transport, transport) || !pending.TryRemove(id, out _))
                    continue;
                var completion = request.Completion;
                if (response["error"] is JsonObject error)
                    completion.TrySetException(new VectorUnavailableException(VectorText.Text(error["code"]), VectorText.Text(error["message"])));
                else
                    completion.TrySetResult(response["value"]?.DeepClone());
            }
        }
        catch { }
        finally
        {
            lock (lifecycle)
                if (child == process)
                    ready = false;
            transport.Dispose();
            foreach (var (id, request) in pending)
                if (ReferenceEquals(request.Transport, transport) && pending.TryRemove(id, out _))
                    request.Completion.TrySetException(new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector owner transport disconnected."));
            // Disconnect does not release ownership; only actual process exit permits replacement.
        }
    }
    private async Task ObserveExitAsync(Process process, NamedPipeServerStream transport)
    {
        await process.WaitForExitAsync();
        transport.Dispose();
        lock (lifecycle)
        {
            if (child != process)
                return;
            ready = false;
            child = null;
            pipe = null;
            starting = null;
            if (!stopping)
                ScheduleRestart();
        }
        process.Dispose();
    }
    private void ScheduleRestart()
    {
        if (stopping || restart is not null)
            return;
        var cancellation = restart = new();
        var delay = restartDelay;
        restartDelay = Math.Min(5000, Math.Max(250, delay * 2));
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay, cancellation.Token);
                Task start;
                lock (lifecycle)
                {
                    if (stopping)
                        return;
                    restart = null;
                    start = starting ??= StartCoreAsync();
                }
                await start;
            }
            catch (OperationCanceledException) { }
            catch
            {
                lock (lifecycle)
                {
                    starting = null;
                    restart = null;
                    ScheduleRestart();
                }
            }
            finally { cancellation.Dispose(); }
        });
    }
    private async Task<JsonNode?> ChildCallAsync(string method, JsonObject input)
    {
        Stream transport;
        long id;
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (lifecycle)
        {
            transport = pipe ?? throw new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector owner is not ready.");
            if (pending.Count >= 256 && method != "drain")
                throw new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector owner request capacity is full.");
            id = Interlocked.Increment(ref requestId);
            pending[id] = new(transport, completion);
        }
        try
        {
            await VectorWire.WriteAsync(transport, sending, new() { ["version"] = 1, ["id"] = id, ["method"] = method, ["input"] = input });
            return await completion.Task;
        }
        catch
        {
            pending.TryRemove(id, out _);
            throw;
        }
    }
    private Task<JsonNode?> CallAsync(string method, JsonObject input)
    {
        lock (lifecycle)
        {
            if (!Configuration.Enabled)
                throw new VectorUnavailableException("VECTOR_DISABLED", "Vector search is disabled by configuration.");
            if (stopping || !ready)
                throw new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector service is not ready.");
            if (Configuration.DbWorkers)
                return ChildCallAsync(method, input);
            if (localCalls.Count >= 256)
                throw new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector owner request capacity is full.");
            var id = Interlocked.Increment(ref requestId);
            var call = VectorWire.DispatchAsync(local!, method, input);
            localCalls[id] = call;
            _ = RemoveLocalAsync(id, call);
            return call;
        }
    }
    private async Task RemoveLocalAsync(long id, Task call)
    {
        try { await call; } catch { }
        finally { localCalls.TryRemove(id, out _); }
    }
    internal async Task<VectorSearchResult> SearchAsync(string query, int limit, VectorSearchOptions? options = null) => (await CallAsync("search", new()
    {
        ["query"] = query, ["limit"] = limit, ["options"] = JsonSerializer.SerializeToNode(options, VectorWire.Json),
    }))!.Deserialize<VectorSearchResult>(VectorWire.Json)!;
    internal async Task<JsonObject> StatusAsync(string id) => (await CallAsync("status", new() { ["sessionId"] = id }))!.AsObject();
    internal async Task WaitForStartupAsync() => await CallAsync("startup", new());
    internal async Task ScheduleAsync(string id, long seq, int tokens, long block)
    {
        if (!Configuration.Enabled)
            return;
        await CallAsync("schedule", new() { ["sessionId"] = id, ["seq"] = seq, ["tokens"] = tokens, ["block"] = block });
    }
    internal async Task<long> ForceAsync(string id, long seq, long block) => VectorRuntime.Integer(await CallAsync("force", new() { ["sessionId"] = id, ["seq"] = seq, ["block"] = block }));
    internal async Task FactsAsync(ArchiveBlockRecord block)
    {
        if (!Configuration.Enabled)
            return;
        await CallAsync("facts", new() { ["record"] = JsonSerializer.SerializeToNode(block, VectorWire.Json) });
    }
    internal async Task RenameAsync(string oldId, string newId)
    {
        if (!Configuration.Enabled)
            return;
        if (!started)
        {
            await preinitLexical.RenameAsync(oldId, newId);
            var old = Archive(oldId).VectorCheckpoint();
            var target = Archive(newId).VectorCheckpoint();
            if (old.UpdatedAt > 0 || target.UpdatedAt > 0)
                Archive(newId).SetVectorCheckpoint(Math.Max(old.RawLastIndexedSeq, target.RawLastIndexedSeq), old.RawLastIndexedSeq > target.RawLastIndexedSeq ? old.RawTailStartSeq : target.RawTailStartSeq, Math.Max(old.LastIndexedBlockId, target.LastIndexedBlockId));
            return;
        }
        await CallAsync("rename", new() { ["oldId"] = oldId, ["newId"] = newId });
    }
    internal async Task ForkAsync(string id)
    {
        if (!Configuration.Enabled)
            return;
        if (!started)
        {
            await preinitLexical.ForkAsync(id);
            if (Archive(id).ReadBranch() is { ParentSessionId: not null } branch)
                Archive(id).SetVectorCheckpoint(branch.MessageCap, branch.MessageCap > 0 ? branch.MessageCap + 1 : 0, branch.BlockCap);
            return;
        }
        await CallAsync("fork", new() { ["sessionId"] = id });
    }
    internal async Task ResetAsync(string id)
    {
        if (!Configuration.Enabled)
            return;
        if (!started)
        {
            await preinitLexical.ResetAsync(id);
            Archive(id).SetVectorCheckpoint(0, 0, 0);
            return;
        }
        await CallAsync("reset", new() { ["sessionId"] = id });
    }
    private SqliteArchiveMessageStore Archive(string id) => new(Path.Combine(root, "state", "archive-store.sqlite"), id);
    private static async Task<bool> ExitedAsync(Process process, TimeSpan timeout)
    {
        try { await process.WaitForExitAsync().WaitAsync(timeout); return true; }
        catch (TimeoutException) { return false; }
        catch (InvalidOperationException) { return true; }
    }
    private static async Task TerminateAsync(Process process, TimeSpan phase)
    {
        if (await ExitedAsync(process, phase))
            return;
        try
        {
            if (OperatingSystem.IsWindows())
                process.Kill();
            else
                _ = kill(process.Id, 15);
        }
        catch (InvalidOperationException) { }
        if (await ExitedAsync(process, phase))
            return;
        try { process.Kill(); } catch (InvalidOperationException) { }
        if (!await ExitedAsync(process, phase))
            throw new VectorUnavailableException("VECTOR_WORKER_EXIT_UNCONFIRMED", "Vector owner did not confirm exit after bounded termination.");
    }
    [System.Runtime.InteropServices.DllImport("libc", SetLastError = true)]
    private static extern int kill(int pid, int signal);
    public async ValueTask DisposeAsync()
    {
        Task? pendingStart;
        lock (lifecycle)
        {
            stopping = true;
            ready = false;
            restart?.Cancel();
            pendingStart = starting;
        }
        if (pendingStart is not null)
            try { await pendingStart; } catch { }
        Process? process;
        lock (lifecycle)
            process = child;
        if (local is not null)
        {
            await Task.WhenAll(localCalls.Values.Select(async task => { try { await task; } catch { } }));
            await local.DisposeAsync();
            local = null;
        }
        if (process is not null)
        {
            try { await ChildCallAsync("drain", new()).WaitAsync(TimeSpan.FromMilliseconds(2500)); }
            catch { }
            pipe?.Dispose();
            await TerminateAsync(process, TimeSpan.FromMilliseconds(2500));
            lock (lifecycle)
                if (child == process)
                {
                    child = null;
                    pipe = null;
                    starting = null;
                }
        }
        await preinitLexical.DisposeAsync();
    }
}
