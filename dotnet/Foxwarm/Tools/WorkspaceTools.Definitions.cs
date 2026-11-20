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
                "File to edit on the current Node. A relative path uses the Session working directory, or the Node's default directory when none is set (the Agent directory on master and CLI Nodes). On master and CLI Nodes, ~/ and a leading $fw_agentdir or $fw_tmp are accepted; other leading $ names are rejected."
            ),
            ["strict"] = false,
        };
}
