using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

internal sealed partial class NodeExecManager
{
    // Stops a tracked Session command on Main's request. Main checked the caller's ownership;
    // the Node additionally requires the exact Session and completion grant it persisted. The
    // completion is still delivered once by reconciliation and carries the stopped line.
    // Outcomes: stopped, killed, ended (Windows tree), finished, already-requested, not-found.
    internal async Task<string> Stop(string sessionId, string execId, string grant)
    {
        if (
            !entries.TryGetValue(execId, out var entry)
            || entry.ContainsKey("externalOwner")
            || Text(entry, "sessionId") != sessionId
            || Text(entry, "completionCapability") != grant
            || !NodeFileTools.Flag(entry, "notifyOnCompletion")
        )
            return "not-found";
        if (entry["stopRequestedAt"] is not null)
            return "already-requested";
        var pid = checked((int)Number(entry["pid"]));
        if (await Status(entry) is not null || !ExecStop.Running(pid, null))
            return "finished";
        var marked = false;
        await Mutate(() =>
        {
            if (!entries.TryGetValue(execId, out var current) || !ReferenceEquals(current, entry))
                return;
            var clone = (JsonObject)entry.DeepClone();
            clone["stopRequestedAt"] = Now();
            entries[execId] = clone;
            marked = true;
        });
        if (!marked)
            return entries.TryGetValue(execId, out var current)
                && current["stopRequestedAt"] is not null
                ? "already-requested"
                : "finished";
        var outcome = await ExecStop.StopAsync(pid, null);
        if (outcome != ExecStop.Outcome.NotRunning)
            return outcome switch
            {
                ExecStop.Outcome.Exited => "stopped",
                ExecStop.Outcome.TreeEnded => "ended",
                _ => "killed",
            };
        // It had already ended before any signal: its completion is not a stopped one.
        await Mutate(() =>
        {
            if (entries.TryGetValue(execId, out var current))
                current.Remove("stopRequestedAt");
        });
        return "finished";
    }
}
