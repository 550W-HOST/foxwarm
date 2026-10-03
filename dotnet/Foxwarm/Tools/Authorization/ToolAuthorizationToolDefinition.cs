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
                ["filePath"] = new JsonObject { ["type"] = "string", ["description"] = "Path to the candidate file. Relative paths use this agent's tool directory; absolute paths are accepted. Symbolic links are not supported." }
            },
            ["required"] = new JsonArray("filePath")
        },
        ["strict"] = false
    };
}
