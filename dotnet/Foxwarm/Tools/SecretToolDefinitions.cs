using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// Working drafts: the coordinator owns the final model-facing wording.
internal static class SecretToolDefinitions
{
    internal static JsonArray Definitions() =>
        new(
            JsonNode.Parse(
                """
                {
                  "type": "function",
                  "name": "add_secret",
                  "description": "Store a credential in the secret store under a new name, so configuration can refer to it as ${secret:NAME} and its value stays out of the conversation. Give exactly one source: value, a file on your current Node, or configuration fields that hold the same literal credential, which are then changed to refer to the new secret. Existing names cannot be replaced; the user does that in Setup. Values are never shown again.",
                  "parameters": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "name": {
                        "type": "string",
                        "description": "New secret name: 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit."
                      },
                      "description": {
                        "type": "string",
                        "description": "Optional single-line description shown in Setup and list_secrets."
                      },
                      "value": {
                        "type": "string",
                        "description": "The credential itself. It remains in this call's record; prefer filePath when the value is in a file."
                      },
                      "filePath": {
                        "type": "string",
                        "description": "File on your current Node holding the value (UTF-8, at most 64 KiB; one trailing line break is ignored)."
                      },
                      "deleteFile": {
                        "type": "boolean",
                        "description": "Delete filePath after storing the value."
                      },
                      "fromConfig": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 16,
                        "description": "Credential fields that hold the same literal value. Each is replaced by a reference to the new secret.",
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "target": {
                              "type": "string",
                              "enum": ["models", "config", "mcp"],
                              "description": "models for providers and models, config for app settings, mcp for MCP servers."
                            },
                            "path": {
                              "type": "array",
                              "minItems": 1,
                              "items": { "type": ["string", "integer"] },
                              "description": "Keys and list indexes to the field, for example [\"providers\", \"openai\", \"apiKey\"]. An mcp path starts with the server name."
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
                  "description": "List stored secrets and names that configuration refers to but that have no value yet: description, owner, where each is used, and whether your permissions let you use it on your current Node. Values are never shown.",
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
