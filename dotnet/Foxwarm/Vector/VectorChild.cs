using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Vector;

internal static class VectorChild
{
    internal static bool IsRequested(string[] args) => args.Length > 0 && args[0] == "--foxwarm-vector-child";
    internal static async Task<bool> TryRunAsync(string[] args)
    {
        if (!IsRequested(args))
            return false;
        if (args.Length != 2)
            throw new InvalidDataException("Vector child requires its local pipe name.");
        using var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await pipe.ConnectAsync(timeout.Token);
        using var sending = new SemaphoreSlim(1, 1);
        var first = await VectorWire.ReadAsync(pipe, timeout.Token) ?? throw new EndOfStreamException();
        if (VectorRuntime.Integer(first["version"]) != 1 || VectorText.Text(first["method"]) != "init" || first["input"] is not JsonObject init)
            throw new InvalidDataException("Invalid Vector owner initialization.");
        var root = VectorText.Text(init["root"]);
        var config = init["configuration"]!.Deserialize<VectorConfiguration>(VectorWire.Json)!;
        if (!Path.IsPathFullyQualified(root) || !config.Enabled)
            throw new InvalidDataException("Invalid enabled Vector owner configuration.");
        var runtime = new VectorRuntime(root, config);
        runtime.Diagnostic = (code, session) => Console.Error.WriteLine("Vector " + code + (session.Length == 0 ? "" : " session=" + session));
        var active = new ConcurrentDictionary<long, Task>();
        var drained = false;
        try
        {
            await runtime.StartAsync();
            await ReplyAsync(pipe, sending, VectorRuntime.Integer(first["id"]), JsonValue.Create(true), null);
            while (await VectorWire.ReadAsync(pipe) is { } request)
            {
                if (VectorRuntime.Integer(request["version"]) != 1)
                    throw new InvalidDataException("Unsupported Vector owner protocol.");
                var id = VectorRuntime.Integer(request["id"]);
                var method = VectorText.Text(request["method"]);
                if (method == "drain")
                {
                    await Task.WhenAll(active.Values);
                    await runtime.DisposeAsync();
                    drained = true;
                    await ReplyAsync(pipe, sending, id, null, null);
                    return true;
                }
                if (active.Count >= 256)
                {
                    await ReplyAsync(pipe, sending, id, null, new VectorUnavailableException("VECTOR_UNAVAILABLE", "Vector owner request capacity is full."));
                    continue;
                }
                var call = ExecuteAsync(pipe, sending, runtime, id, method, request["input"]?.AsObject() ?? new());
                active[id] = call;
                _ = RemoveAsync(active, id, call);
            }
        }
        finally
        {
            if (!drained)
            {
                // Like Source parent-disconnect cleanup, this is bounded derived work, not durable fencing.
                var cleanup = Task.Run(async () =>
                {
                    await Task.WhenAll(active.Values);
                    await runtime.DisposeAsync();
                });
                try { await cleanup.WaitAsync(TimeSpan.FromSeconds(2)); }
                catch { Environment.Exit(0); }
            }
        }
        return true;
    }
    private static async Task ExecuteAsync(Stream pipe, SemaphoreSlim sending, VectorRuntime runtime, long id, string method, JsonObject input)
    {
        JsonNode? value = null;
        Exception? failure = null;
        try { value = await VectorWire.DispatchAsync(runtime, method, input); }
        catch (Exception error) { failure = error; }
        try { await ReplyAsync(pipe, sending, id, value, failure); }
        catch { }
    }
    private static async Task RemoveAsync(ConcurrentDictionary<long, Task> active, long id, Task task)
    {
        try { await task; }
        finally { active.TryRemove(id, out _); }
    }
    private static Task ReplyAsync(Stream pipe, SemaphoreSlim sending, long id, JsonNode? value, Exception? error) => VectorWire.WriteAsync(pipe, sending, new()
    {
        ["version"] = 1, ["id"] = id, ["value"] = value,
        ["error"] = error is null ? null : new JsonObject { ["code"] = error is VectorUnavailableException unavailable ? unavailable.Code : "VECTOR_OPERATION_FAILED", ["message"] = error.Message },
    });
}
