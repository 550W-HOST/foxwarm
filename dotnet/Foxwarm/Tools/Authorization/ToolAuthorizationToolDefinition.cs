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
                "Install a complete YAML configuration from a file. Choose config, models, or tool-rules. The candidate is validated before replacing the active file. The result identifies applied changes and settings that require a restart. Your current permissions must allow both this operation and reading the candidate file.",
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
                            "Path to the complete candidate YAML file. It is read on master, or in this Agent's folder where there is no master. A leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory. Other leading $ names are rejected.",
                    },
                },
                ["required"] = new JsonArray("target", "filePath"),
            },
            ["strict"] = false,
        };

    internal const int MaxExplainProbes = 256;

    internal const int MaxExplainLabelLength = 200;

    internal static JsonObject ExplainDefinition() =>
        JsonNode
            .Parse(
                """
                {
                  "type": "function",
                  "name": "explain_tool_authorization",
                  "description": "Explain how tool authorization would decide a call by an existing Session, without running it. Each probe names the caller Session and either a ctl command or a tool, as for ctl tool call. The result shows the decision and matching rule of the global policy and of each Agent rule layer, and the facts used. It also lists the operations the call would perform and the authorization checks it must pass, with each check's decision; parts that are decided only when the call runs are marked incomplete. Checks made inside the tool itself are not included. With policyFilePath, a candidate file replaces the global policy; set compare to evaluate both and list changed rule ids. Set compact for one short row per probe, which suits large batches. Requires permission to read the active policy and any candidate file; probing another Session also requires permission to view it.",
                  "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "probes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 256,
                        "description": "Calls to evaluate, 1 to 256 per call.",
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "sessionId": { "type": "string", "description": "Existing caller Session ID or alias. Its Agent, current Node, cwd and relations are used." },
                            "label": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Name for this probe, echoed in its result." },
                            "command": { "type": "string", "description": "A ctl command to evaluate instead of a tool, such as `node select master`. The capability it runs is evaluated with the arguments the command gives it." },
                            "values": { "type": "object", "description": "Values for @name arguments of command." },
                            "valuesJson": { "type": "string", "description": "values as a JSON object string." },
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
                        "description": "Path to a complete candidate tool-rules YAML that replaces the active global policy. It is read on master, or in this Agent's folder where there is no master. A leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory."
                      },
                      "compare": {
                        "type": "boolean",
                        "description": "With policyFilePath, evaluate both the active and candidate policy and include a static rule id diff."
                      },
                      "compact": {
                        "type": "boolean",
                        "description": "Return one short row per probe: its index, Session, tool ID, decision, and the layer and rule ID of each layer that matched a rule or did not allow, the command of a command probe, and the first other authorization check that does not allow. With compare, the active and candidate rows and changed. Facts and rule details are omitted."
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
