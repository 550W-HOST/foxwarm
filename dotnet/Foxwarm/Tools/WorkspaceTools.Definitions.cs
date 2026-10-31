using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

public sealed partial class WorkspaceTools
{
    private static JsonObject EditDefinition() =>
        new()
        {
            ["type"] = "function",
            ["name"] = "edit",
            ["description"] = UnifiedEdit.Description,
            ["parameters"] = UnifiedEdit.Parameters(
                "File to edit. Relative paths use the session working directory, or the agent directory when unset. Absolute paths and ~/ paths are accepted subject to permissions. A leading $fw_agentdir or $fw_tmp expands to the agent directory or its tmp directory. Other leading $ names are rejected."
            ),
            ["strict"] = false,
        };
}
