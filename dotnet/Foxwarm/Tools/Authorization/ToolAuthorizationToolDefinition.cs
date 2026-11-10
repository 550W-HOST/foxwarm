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

    internal const int MaxExplainProbes = 32;

    internal static JsonObject ExplainDefinition() =>
        JsonNode
            .Parse(
                """
                {
                  "type": "function",
                  "name": "explain_tool_authorization",
                  "description": "Explain how tool authorization would decide a call by an existing Session, without running it. Each probe names the caller Session and the tool, as for call_tool. The result shows the decision and matching rule of the global policy and of each Agent rule layer, and the facts used. Checks made inside the tool itself are not included. With policyFilePath, a candidate file replaces the global policy; set compare to evaluate both and list changed rule ids. Requires permission to read the active policy file and any candidate on master; probing another Session also requires permission to view it.",
                  "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "probes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 32,
                        "description": "Calls to evaluate.",
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "sessionId": { "type": "string", "description": "Existing caller Session ID or alias. Its Agent, current Node, cwd and relations are used." },
                            "toolId": { "type": "string", "description": "Tool ID such as builtin:send_file, node:master/read or mcp:server/tool." },
                            "source": { "type": "string", "enum": ["builtin", "node", "mcp"] },
                            "name": { "type": "string" },
                            "server": { "type": "string", "description": "MCP server." },
                            "nodeId": { "type": "string", "description": "Node for a node tool. Defaults to the caller Session's current Node." },
                            "args": { "type": "object", "description": "Arguments of the evaluated call." },
                            "argsJson": { "type": "string", "description": "Arguments as a JSON object string." }
                          },
                          "required": ["sessionId"]
                        }
                      },
                      "policyFilePath": {
                        "type": "string",
                        "description": "Path on master to a complete candidate tool-rules YAML that replaces the active global policy. A leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory on master."
                      },
                      "compare": {
                        "type": "boolean",
                        "description": "With policyFilePath, evaluate both the active and candidate policy and include a static rule id diff."
                      }
                    },
                    "required": ["probes"]
                  },
                  "strict": false
                }
                """
            )!
            .AsObject();
}
