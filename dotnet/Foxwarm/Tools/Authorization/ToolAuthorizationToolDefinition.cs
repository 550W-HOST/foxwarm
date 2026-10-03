using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ToolAuthorizationToolDefinition
{
    internal static JsonObject Definition() => new()
    {
        ["type"] = "function", ["name"] = "set_tool_rules",
        ["description"] = "Replace the instance's tool authorization policy with a validated UTF-8 YAML file on Main. The current policy must allow this tool and reading the file.",
        ["parameters"] = new JsonObject
        {
            ["type"] = "object", ["additionalProperties"] = false,
            ["properties"] = new JsonObject
            {
                ["filePath"] = new JsonObject { ["type"] = "string", ["description"] = "Path to the candidate policy file. Relative paths use the session working directory, or the agent directory when unset. Absolute paths and ~/ paths are accepted subject to permissions. A leading $fw_agentdir or $fw_tmp expands to the agent directory or its tmp directory. Other leading $ names are rejected." }
            },
            ["required"] = new JsonArray("filePath")
        },
        ["strict"] = false
    };
}
