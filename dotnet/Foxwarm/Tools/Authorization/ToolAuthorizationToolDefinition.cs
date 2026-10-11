using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ToolAuthorizationToolDefinition
{
    internal static JsonObject Definition() =>
        new()
        {
            ["type"] = "function",
            ["name"] = "set_config",
            ["description"] =
                "Install a complete YAML configuration from a file on master. Choose config, models, or tool-rules. The candidate is validated before replacing the active file. The result identifies applied changes and settings that require a restart. Your current permissions must allow both this operation and reading the candidate file.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["properties"] = new JsonObject
                {
                    ["target"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["enum"] = new JsonArray("config", "models", "tool-rules"),
                        ["description"] =
                            "Configuration to replace: config for app settings, models for providers and models, or tool-rules for the instance tool authorization policy.",
                    },
                    ["filePath"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] =
                            "Path on master to the complete candidate YAML file. A leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory on master. Other leading $ names are rejected.",
                    },
                },
                ["required"] = new JsonArray("target", "filePath"),
            },
            ["strict"] = false,
        };
}
