using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class SecretToolDefinitions
{
    internal static JsonArray Definitions() =>
        new(
            JsonNode.Parse(
                """
                {
                  "type": "function",
                  "name": "add_secret",
                  "description": "Store a credential under a new secret name. Configuration can then refer to it as `${secret:NAME}`, and its value is hidden from tool output, Session history and model requests. Give exactly one source: `value`, `filePath` or `fromConfig`. An existing name can't be replaced here; the user replaces values in Setup. Stored values can't be read back.",
                  "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "name": {
                        "type": "string",
                        "description": "New secret name: 1-64 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit."
                      },
                      "description": {
                        "type": "string",
                        "description": "Optional one-line description shown in Setup and `list_secrets`."
                      },
                      "value": {
                        "type": "string",
                        "description": "The credential. It remains visible in this tool call, so prefer `filePath` when the value is in a file or comes from a command's output."
                      },
                      "filePath": {
                        "type": "string",
                        "description": "File on your current Node containing the value: UTF-8 text, at most 64 KiB. A single trailing line break is ignored."
                      },
                      "deleteFile": {
                        "type": "boolean",
                        "description": "Delete the file after storing its value."
                      },
                      "fromConfig": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 16,
                        "description": "Configuration fields that currently hold the same literal credential. Each field is changed to refer to the new secret, which belongs to the instance rather than your Agent.",
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "target": {
                              "type": "string",
                              "enum": ["models", "config", "mcp"],
                              "description": "`models` for model configuration, `config` for app configuration, `mcp` for MCP servers."
                            },
                            "path": {
                              "type": "array",
                              "minItems": 1,
                              "items": { "type": ["string", "integer"] },
                              "description": "Keys and list indexes leading to the field, for example `[\"providers\", \"openai\", \"apiKey\"]`. For `mcp`, start with the server name."
                            }
                          },
                          "required": ["target", "path"]
                        }
                      }
                    },
                    "required": ["name"]
                  },
                  "strict": false
                }
                """
            ),
            JsonNode.Parse(
                """
                {
                  "type": "function",
                  "name": "list_secrets",
                  "description": "List secret names with their descriptions, owners and the configuration that uses them, including referenced names that have no value yet. `usable` tells whether your permissions let you use each stored secret from your current Node. Values are never returned.",
                  "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {}
                  },
                  "strict": false
                }
                """
            )
        );
}
