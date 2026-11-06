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
    internal Action<JsonObject>? SessionMessageDelivered { get; set; }
    internal Action<JsonObject>? ExecPlacementObserved { get; set; }

    // 1-based position of the current call_tool host call within this run slice.
    internal int? SubCallOrdinal { get; set; }

    // 1-based position of the current call_tool host call across all slices of this run.
    internal int? RunSubCallOrdinal { get; set; }
}

internal sealed class ToolScriptWaitScope
{
    internal JsonObject? Pending { get; set; }
}
