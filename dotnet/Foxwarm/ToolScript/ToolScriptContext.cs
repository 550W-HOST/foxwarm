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
);
