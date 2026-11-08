using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.CliNode;

// Serves only the fixed Code/Terminal service frames over a pipe that the caller already owns
// (for example `docker exec -i` or `ssh` carried by a Node Provider). Whoever can start this
// process and hold its pipe is the administrator's own channel, so there is no pairing, token,
// model-tool or exec surface here. The first stdout line is a readiness line that states the
// services this process serves; after it, both directions carry NDJSON `node_service_*` frames.
internal sealed class NodeStdioHost(Stream input, Stream output)
{
    internal const int FrameLimit = 72 * 1024 * 1024;
    private static readonly string[] ServiceNames = ["vscode-fs", "vscode-git", "vscode-pty"];
    private readonly SemaphoreSlim writeGate = new(1, 1);
    private readonly object owner = new();
    private NodePtyService? pty;

    internal static async Task<int> Run(CancellationToken stop)
    {
        var state = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-node-stdio-" + Environment.ProcessId + "-" + Guid.NewGuid().ToString("N")[..8]
        );
        try
        {
            return await new NodeStdioHost(
                Console.OpenStandardInput(),
                Console.OpenStandardOutput()
            ).Serve(state, stop);
        }
        finally
        {
            try
            {
                if (Directory.Exists(state))
                    Directory.Delete(state, recursive: true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    internal static JsonObject Services()
    {
        var declared = NodeClient.Capabilities()["services"] as JsonObject ?? new();
        var services = new JsonObject();
        foreach (var name in ServiceNames)
            if (declared[name] is JsonNode version)
                services[name] = version.DeepClone();
        return services;
    }

    internal async Task<int> Serve(string stateDirectory, CancellationToken stop)
    {
        if (NodePtyService.IsSupported)
        {
            Directory.CreateDirectory(stateDirectory);
            pty = new NodePtyService(stateDirectory);
        }
        var dispatches = new List<Task>();
        var previousPty = Task.CompletedTask;
        try
        {
            if (pty is not null)
                pty.Connect(owner, detail => Send(Event("vscode-pty", detail)));
            await Send(new JsonObject { ["type"] = "node_stdio_ready", ["services"] = Services() });
            var reader = new NdjsonLineReader(input, FrameLimit);
            while (!stop.IsCancellationRequested)
            {
                var line = await reader.ReadAsync(stop);
                if (line is null)
                    return 0;
                var frame = JsonNode.Parse(line) as JsonObject;
                var type = NodeServiceDispatch.Text(frame ?? new(), "type");
                var service = NodeServiceDispatch.Text(frame ?? new(), "service");
                if (
                    frame is null
                    || type is not ("node_service_request" or "node_service_command")
                    || service is null
                    || !ServiceNames.Contains(service)
                )
                {
                    Console.Error.WriteLine("Unsupported frame on the stdio service channel.");
                    return 2;
                }
                // Terminal commands for one Node run in arrival order; everything else is concurrent.
                var previous = service == "vscode-pty" ? previousPty : Task.CompletedTask;
                var task = Task.Run(async () =>
                {
                    try
                    {
                        await previous;
                    }
                    catch (Exception) { }
                    await NodeServiceDispatch.Dispatch(frame, pty, owner, Send);
                });
                if (service == "vscode-pty")
                    previousPty = task;
                lock (dispatches)
                {
                    dispatches.RemoveAll(item => item.IsCompleted);
                    dispatches.Add(task);
                }
            }
            return 0;
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or System.Text.Json.JsonException
                        or IOException
                        or OperationCanceledException
            )
        {
            Console.Error.WriteLine("Stdio service channel ended: " + error.GetType().Name);
            return error is OperationCanceledException ? 0 : 1;
        }
        finally
        {
            pty?.Disconnect(owner);
            Task[] pending;
            lock (dispatches)
                pending = dispatches.ToArray();
            try
            {
                await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch (Exception) { }
            // Terminals end with this process; the Provider decides whether to start another.
            if (pty is not null)
                await pty.DisposeAsync();
        }
    }

    private static JsonObject Event(string service, JsonObject detail) =>
        new()
        {
            ["type"] = "node_service_event",
            ["service"] = service,
            ["event"] = detail,
        };

    private async Task Send(JsonObject frame)
    {
        var bytes = Encoding.UTF8.GetBytes(frame.ToJsonString());
        await writeGate.WaitAsync();
        try
        {
            await output.WriteAsync(bytes);
            await output.WriteAsync(new byte[] { (byte)'\n' });
            await output.FlushAsync();
        }
        catch (IOException) { }
        finally
        {
            writeGate.Release();
        }
    }
}
