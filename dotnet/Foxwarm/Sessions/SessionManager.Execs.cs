using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// `exec list` / `exec stop` and the WebUI's running-command list. Ownership follows
// waitExecIds: native and Provider commands tracked for this exact Session lifetime, and
// background commands on authenticated CLI Nodes whose start-time claim this Main holds.
internal sealed partial class SessionManager
{
    internal sealed record SessionExec(
        string Id,
        string NodeId,
        string? Command,
        long StartedAt,
        string? Cwd,
        string? LogPath,
        bool StopRequested
    );

    internal enum ExecStopResult
    {
        NotOwned,
        Unavailable,
        Unsupported,
        AlreadyRequested,
        Finished,
        Stopped,
        Killed,
        Ended,
        Unknown,
    }

    internal SessionExec[] RunningExecs(SessionOwner owner) =>
        executor
            .Running(owner.Id)
            .Select(exec => new SessionExec(
                exec.Id,
                exec.NodeId,
                exec.Command,
                exec.StartedAt,
                exec.Cwd,
                exec.LogPath,
                exec.StopRequested
            ))
            .Concat(
                Nodes
                    .ExecClaims.Active(owner)
                    .Select(claim => new SessionExec(
                        claim.ExecId,
                        claim.Node,
                        claim.Command,
                        claim.DispatchedAt,
                        claim.Cwd,
                        claim.LogPath,
                        claim.StopRequested
                    ))
            )
            .OrderBy(exec => exec.StartedAt)
            .ThenBy(exec => exec.Id, StringComparer.Ordinal)
            .ToArray();

    internal async Task<(ExecStopResult Result, string? NodeId, bool Resident)> StopExecAsync(
        SessionOwner owner,
        string execId,
        CancellationToken token
    )
    {
        if (executor.IsOwnedActive(owner.Id, execId))
        {
            var node = executor.Running(owner.Id).FirstOrDefault(exec => exec.Id == execId)?.NodeId;
            var (outcome, _) = await executor.StopAsync(owner.Id, execId, token);
            return (
                outcome switch
                {
                    LocalExecManager.StopOutcome.AlreadyRequested => ExecStopResult.AlreadyRequested,
                    LocalExecManager.StopOutcome.Finished => ExecStopResult.Finished,
                    LocalExecManager.StopOutcome.Unsupported => ExecStopResult.Unsupported,
                    LocalExecManager.StopOutcome.Stopped => ExecStopResult.Stopped,
                    LocalExecManager.StopOutcome.Killed => ExecStopResult.Killed,
                    LocalExecManager.StopOutcome.Ended => ExecStopResult.Ended,
                    LocalExecManager.StopOutcome.Unknown => ExecStopResult.Unknown,
                    _ => QueuedCompletion(owner, execId)
                        ? ExecStopResult.Finished
                        : ExecStopResult.NotOwned,
                },
                node,
                false
            );
        }
        var claim = Nodes.ExecClaims.Active(owner, execId);
        if (claim is not null)
        {
            var outcome = await Nodes.StopRemoteExecAsync(owner, execId, token);
            return (
                outcome switch
                {
                    NodeConnectionHub.RemoteStop.Unavailable => ExecStopResult.Unavailable,
                    NodeConnectionHub.RemoteStop.Unsupported => ExecStopResult.Unsupported,
                    NodeConnectionHub.RemoteStop.AlreadyRequested => ExecStopResult.AlreadyRequested,
                    NodeConnectionHub.RemoteStop.Finished => ExecStopResult.Finished,
                    NodeConnectionHub.RemoteStop.Stopped => ExecStopResult.Stopped,
                    NodeConnectionHub.RemoteStop.Killed => ExecStopResult.Killed,
                    NodeConnectionHub.RemoteStop.Ended => ExecStopResult.Ended,
                    NodeConnectionHub.RemoteStop.Unknown => ExecStopResult.Unknown,
                    _ => QueuedCompletion(owner, execId)
                        ? ExecStopResult.Finished
                        : ExecStopResult.NotOwned,
                },
                claim.Node,
                true
            );
        }
        return (
            QueuedCompletion(owner, execId) ? ExecStopResult.Finished : ExecStopResult.NotOwned,
            null,
            false
        );
    }

    // The command's completion was delivered to this Session: it is queued, or its receipt is
    // among the Session's recent accepted completion receipts.
    private static bool QueuedCompletion(SessionOwner owner, string execId) =>
        owner.Entry.WithState(state =>
            state.Queue.Any(item => SessionWait.Text(item.OpenFields?["execId"]) == execId)
            || SessionWait
                .Strings(state.Meta["acceptedExternalEventIds"])
                .Any(receipt =>
                    receipt == "exec-completion:" + execId
                    || receipt == "remote-exec-completion:" + execId
                )
        );

    // Model-facing builtins reached through `ctl exec list` and `ctl exec stop`.
    internal Task<JsonObject> ListExecsToolAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, []);
        token.ThrowIfCancellationRequested();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var rows = new JsonArray();
        foreach (var exec in RunningExecs(owner))
            rows.Add(ExecRow(exec, now));
        return Task.FromResult(new JsonObject { ["execs"] = rows });
    }

    // The text of `/exec list`: the running commands of a Session, as listed by exec list.
    internal static string ExecListText(JsonArray execs, long now)
    {
        var lines = new List<string>
        {
            execs.Count switch
            {
                0 => "No commands of this Session are running in the background.",
                1 => "1 running command:",
                _ => $"{execs.Count} running commands:",
            },
        };
        foreach (var exec in execs.OfType<JsonObject>())
        {
            var startedAt = (long)(SessionWait.Number(exec["startedAt"]) ?? now);
            var nodeId = SessionWait.Text(exec["nodeId"]) ?? "master";
            var heading = "- " + SessionWait.Text(exec["execId"]);
            if (nodeId != "master")
                heading += $" · Node `{nodeId}`";
            heading += $" · started {StartedText(startedAt, now)} ({ExecDuration.Format(now - startedAt) ?? "unknown"} ago)";
            if (SessionCatalog.Flag(exec["stopRequested"]))
                heading += " · stop requested";
            lines.Add(heading);
            lines.Add($"  command: `{ExecOutput.CommandPreview(SessionWait.Text(exec["command"]) ?? "")}`");
            lines.Add("  cwd: " + (SessionWait.Text(exec["cwd"]) ?? "unknown"));
            lines.Add("  log: " + (SessionWait.Text(exec["logPath"]) ?? "unknown"));
        }
        return string.Join('\n', lines);
    }

    internal static JsonObject ExecRow(SessionExec exec, long now) =>
        new()
        {
            ["execId"] = exec.Id,
            ["nodeId"] = exec.NodeId,
            ["command"] = exec.Command,
            ["startedAt"] = exec.StartedAt,
            ["elapsedMs"] = Math.Max(0, now - exec.StartedAt),
            ["cwd"] = exec.Cwd,
            ["logPath"] = exec.LogPath,
            ["stopRequested"] = exec.StopRequested,
        };

    private static string StartedText(long startedAt, long now)
    {
        var started = DateTimeOffset.FromUnixTimeMilliseconds(startedAt).ToLocalTime();
        var current = DateTimeOffset.FromUnixTimeMilliseconds(now).ToLocalTime();
        return started.ToString(
            started.Date == current.Date ? "HH:mm:ss" : "yyyy-MM-dd HH:mm:ss",
            CultureInfo.InvariantCulture
        );
    }

    internal async Task<JsonObject> StopExecToolAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["execId"]);
        var id = ToolRegistry.Text(args, "execId");
        if (string.IsNullOrWhiteSpace(id))
            throw new InvalidDataException("exec stop requires an execId.");
        var (result, node, resident) = await StopExecAsync(owner, id, token);
        var note = result switch
        {
            ExecStopResult.Stopped =>
                $"Stopped `{id}`; it exited after the termination signal. Its completion will be reported separately.",
            ExecStopResult.Killed =>
                $"`{id}` was still running {ExecStop.Grace.TotalSeconds:0} seconds after the termination signal and was killed. Its completion will be reported separately.",
            ExecStopResult.Ended =>
                $"Ended `{id}` and its child processes. Its completion will be reported separately.",
            ExecStopResult.Finished =>
                $"`{id}` had already finished; nothing was stopped. Its completion is queued or already reported.",
            ExecStopResult.AlreadyRequested => $"A stop for `{id}` was already requested.",
            ExecStopResult.Unsupported => throw new InvalidOperationException(
                $"Node `{node}` cannot stop commands."
                    + (resident ? " Its Foxwarm CLI is too old for this." : "")
            ),
            ExecStopResult.Unavailable => throw new InvalidOperationException(
                $"Node `{node}` is not connected, so `{id}` could not be stopped."
            ),
            ExecStopResult.Unknown => throw new IOException(
                $"The stop request for `{id}` did not return a result; the command may or may not have been stopped. It was not retried."
            ),
            _ => throw new InvalidDataException(
                $"`{id}` is not a running command of this Session. Use the exact execId returned by exec, not a PID or log path."
            ),
        };
        return new JsonObject
        {
            ["execId"] = id,
            ["outcome"] = result switch
            {
                ExecStopResult.Stopped => "stopped",
                ExecStopResult.Killed => "killed",
                ExecStopResult.Ended => "ended",
                ExecStopResult.Finished => "finished",
                _ => "already-requested",
            },
            ["note"] = note,
        };
    }
}
