using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.ToolScript;

internal sealed record ToolScriptContext(
    SessionOwner Owner,
    string LiteralOwner,
    Func<JsonObject, ToolScriptDataBudget, CancellationToken, Task<JsonNode?>> CallTool,
    Func<string, string?, ToolScriptDataBudget, CancellationToken, Task<JsonObject>> RequestModel,
    Func<
        string,
        ToolScriptDataBudget,
        CancellationToken,
        Task<(string Path, string Code)>
    > ReadSource,
    Action<JsonArray>? Progress = null,
    string? SourceNode = null
)
{
    internal string? ToolScriptRunId { get; set; }
    internal ToolScriptWaitScope WaitScope { get; init; } = new();

    // Present only for an attended top-level run_script/continue_script call, whose background
    // run may outlast the call's wait and continue on its own.
    internal ToolScriptDetach? Detach { get; init; }

    // Started by a call of a running script: it runs within its root run's ToolScript slot,
    // which that run holds while it waits for this call.
    internal bool Nested { get; init; }

    // The runnable skill whose entry this run starts (`ctl skill run`); its record keeps the
    // provenance. Continuations resume the snapshot and never reread the entry.
    internal SkillEntry? SourceSkill { get; init; }
    internal Action<JsonObject>? SessionMessageDelivered { get; set; }
    internal Action<JsonObject>? ExecPlacementObserved { get; set; }
    internal Action<JsonObject>? TargetObserved { get; set; }

    // Receives the stored blob of each image result a nested call produced that the run may
    // return (see MainToolScript.Images).
    internal Action<string>? ImageProduced { get; set; }

    // 1-based position of the current call_tool host call within this run slice.
    internal int? SubCallOrdinal { get; set; }

    // 1-based position of the current call_tool host call across all slices of this run.
    internal int? RunSubCallOrdinal { get; set; }
}

internal sealed class ToolScriptWaitScope
{
    internal JsonObject? Pending { get; set; }
}

/// <summary>
/// The hand-off state of one background run segment. The calling tool waits for the segment
/// up to its time limit; after that the run continues detached and reports its outcome through
/// <see cref="Finished"/> instead of the tool result.
/// </summary>
internal sealed class ToolScriptDetach
{
    // Guards the detach decision against concurrent presentation and stdout updates.
    internal readonly object Gate = new();
    private bool detached;
    private readonly TaskCompletionSource<bool> decision = new(
        TaskCreationOptions.RunContinuationsAsynchronously
    );

    // Receives the lean outcome of a segment that ended after detaching: completed, failed,
    // cancelled, or waiting for agent input.
    internal Func<JsonObject, Task>? Finished { get; init; }

    // Printed output of the current segment so far; read under Gate.
    internal Func<string>? Output { get; set; }

    internal bool Detached
    {
        get
        {
            lock (Gate)
                return detached;
        }
    }

    internal Task<bool> Decision => decision.Task;

    // Called under Gate.
    internal void Decide(bool value)
    {
        detached = value;
        decision.TrySetResult(value);
    }
}
