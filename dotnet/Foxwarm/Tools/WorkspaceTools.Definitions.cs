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
                "File to edit on the current Node. Relative paths follow that Node's working-directory rules. On master, they use the Session working directory or the Agent directory when unset. On master and CLI Nodes, ~/ and a leading $fw_agentdir or $fw_tmp are supported; other Nodes use their own path syntax."
            ),
            ["strict"] = false,
        };
}
