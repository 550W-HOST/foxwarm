using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal sealed partial class NodeClient
{
    private readonly ConcurrentDictionary<string, NodeExecManager> execManagers = new(
        StringComparer.Ordinal
    );
    private readonly ConcurrentDictionary<
        string,
        (Connection Connection, CancellationTokenSource Stop)
    > foreground = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<long, (Task Task, bool Drain)> dispatches = new();
    private long dispatchSequence;
    private Connection? registeredConnection;
    private Task? recovery;

    private NodeExecManager Manager(string agent)
    {
        var registry = Path.Combine(
            paths.AgentDirectory(agent),
            ".temp",
            "exec",
            "running-exec.json"
        );
        return execManagers.GetOrAdd(
            registry,
            path => new NodeExecManager(paths, path, SendCompletion)
        );
    }

    private async Task Recover()
    {
        foreach (var directory in paths.RecoveryDirectories())
        {
            var registry = Path.Combine(directory, ".temp", "exec", "running-exec.json");
            if (!File.Exists(registry))
                continue;
            // The registry owns each record's original Session, Agent, Node, paths and grant.
            var manager = execManagers.GetOrAdd(
                registry,
                path => new NodeExecManager(paths, path, SendCompletion)
            );
            await manager.Initialize();
        }
    }

    private async Task SendCompletion(JsonObject entry, JsonObject status, string message)
    {
        var session = NodeExecManager.Text(entry, "sessionId");
        if (string.IsNullOrEmpty(session))
            return;
        var connection =
            registeredConnection ?? throw new IOException("Remote node is not connected to master");
        var frame = new JsonObject
        {
            ["type"] = "session_event",
            ["sessionId"] = session,
            ["eventType"] = "background",
            ["message"] = message,
        };
        if (NodeExecManager.Text(entry, "completionCapability") is { Length: > 0 } capability)
        {
            frame["eventId"] = "remote-exec-completion:" + NodeExecManager.Text(entry, "id");
            frame["execId"] = NodeExecManager.Text(entry, "id");
            frame["completionCapability"] = capability;
            frame["eventTimestamp"] = DateTimeOffset.TryParse(
                NodeExecManager.Text(status, "finishedAt"),
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal,
                out var finished
            )
                ? finished.ToUnixTimeMilliseconds()
                : NodeExecManager.Number(entry["startedAt"]);
        }
        await connection.Request(frame);
    }

    private void ScheduleDispatch(Connection connection, JsonObject frame)
    {
        var call = Text(frame, "callId") ?? "";
        CancellationTokenSource? cancellation = null;
        if (
            Text(frame, "type") == "tool_call"
            && Text(frame, "tool") == "exec"
            && !frame.ContainsKey("owner")
        )
        {
            cancellation = new();
            foreground[call] = (connection, cancellation);
        }
        var sequence = Interlocked.Increment(ref dispatchSequence);
        // Register cancellation before queueing so a back-to-back Stop cannot miss prelaunch.
        var ptyFrame =
            Text(frame, "service") == "vscode-pty"
            && Text(frame, "type") is "node_service_request" or "node_service_command";
        var previous = ptyFrame ? connection.PtyDispatch : Task.CompletedTask;
        var task = Task.Run(async () =>
        {
            try
            {
                await previous;
            }
            catch { }
            try
            {
                await Dispatch(connection, frame, cancellation);
            }
            finally
            {
                if (cancellation is not null)
                {
                    foreground.TryRemove(
                        new KeyValuePair<string, (Connection, CancellationTokenSource)>(
                            call,
                            (connection, cancellation)
                        )
                    );
                    cancellation.Dispose();
                }
            }
        });
        if (ptyFrame)
            connection.PtyDispatch = task;
        // Source external shutdown drains manager observers/persistence, not a foreground call's wait.
        dispatches[sequence] = (task, !frame.ContainsKey("owner") || Text(frame, "tool") != "exec");
        _ = task.ContinueWith(
            _ =>
            {
                dispatches.TryRemove(sequence, out var removed);
            },
            TaskScheduler.Default
        );
    }

    private async Task<JsonObject> ExecuteCommand(
        Connection connection,
        JsonObject frame,
        string agent,
        CancellationToken stop,
        Action started
    )
    {
        if (!ExecNative.Supported)
            throw new InvalidDataException("exec is unavailable on this platform");
        var args = frame["args"] as JsonObject ?? new JsonObject();
        var timeout = NodeExecManager.Timeout(args["timeout"]);
        var manager = Manager(agent);
        var entry = await manager.Start(frame, agent, nodeId ?? requestedName, stop, started);
        var status = await manager.Wait(entry, timeout.Seconds, stop);
        if (status is not null)
        {
            try
            {
                return await NodeExecManager.Result(
                    entry,
                    status,
                    await NodeExecManager.Foreground(entry, status, timeout.Warning),
                    NodeFileTools.Flag(frame, "programmatic")
                );
            }
            finally
            {
                await manager.Remove(entry);
            }
        }
        if (NodeExecManager.Text(entry, "completionCapability") is { Length: > 0 } capability)
            await connection.Send(
                new JsonObject
                {
                    ["type"] = "remote_exec_background",
                    ["sessionId"] = NodeExecManager.Text(entry, "sessionId"),
                    ["execId"] = NodeExecManager.Text(entry, "id"),
                    ["completionCapability"] = capability,
                }
            );
        await manager.Background(entry);
        var output = await manager.BackgroundOutput(
            entry,
            timeout.Seconds,
            timeout.Warning,
            stop.IsCancellationRequested
        );
        return await NodeExecManager.Result(
            entry,
            null,
            output,
            NodeFileTools.Flag(frame, "programmatic")
        );
    }

    private static void CancelWait(CancellationTokenSource cancellation)
    {
        try
        {
            cancellation.Cancel();
        }
        catch (ObjectDisposedException) { } // A completed call may retire concurrently with a late Stop.
    }

    private async Task DrainExec()
    {
        registeredConnection = null;
        foreach (var call in foreground.Values)
            CancelWait(call.Stop);
        await Task.WhenAll(dispatches.Values.Where(call => call.Drain).Select(call => call.Task));
        if (recovery is not null)
            await recovery;
        foreach (var manager in execManagers.Values)
            await manager.DisposeAsync();
        ExternalRuntime[] external;
        lock (externalGate)
            external = externalExecRuntimes.Values.ToArray();
        foreach (var runtime in external)
            await runtime.Manager.DisposeAsync();
        lock (externalGate)
        {
            foreach (var timer in releasedExternalOwners.Values)
                timer.Dispose();
            releasedExternalOwners.Clear();
        }
    }
}
