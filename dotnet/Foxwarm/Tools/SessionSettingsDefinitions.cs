using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class SessionSettingsDefinitions
{
    internal static JsonArray Definitions() =>
        JsonNode
            .Parse(
                """
[
  {
    "type": "function",
    "name": "set_session_model",
    "description": "Inspect or switch the model and effort of this Session or one of its descendant Sessions. Without model or effort, shows the current selection and the configured models. A change applies from the target's next model request, including later requests of a turn already in progress, and starts a new prompt cache.",
    "strict": false,
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "This Session or a descendant Session. Defaults to this Session."
        },
        "model": {
          "type": "string",
          "description": "Configured model key; default returns to the default model."
        },
        "effort": {
          "type": "string",
          "description": "Effort setting; use default or unset to clear the override.",
          "enum": [
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "default",
            "unset"
          ]
        }
      },
      "required": []
    }
  },
  {
    "type": "function",
    "name": "set_session_child_model",
    "description": "Inspect or change the default model and effort for future child or related new sessions. Unset settings follow the source session's normal model and effort defaults.",
    "strict": false,
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Session whose defaults to inspect or change. Defaults to this session."
        },
        "model": {
          "type": "string",
          "description": "Configured model key for future child or related new sessions."
        },
        "effort": {
          "type": "string",
          "description": "Effort setting; use default or unset to clear the override.",
          "enum": [
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "default",
            "unset"
          ]
        },
        "clear": {
          "type": "boolean",
          "description": "Clear only the model override. Do not combine with model."
        }
      },
      "required": []
    }
  },
  {
    "type": "function",
    "name": "set_session_compact_threshold",
    "description": "Inspect or change the context-token threshold that triggers automatic compaction for a session. Without an override, the threshold follows the active model's context window.",
    "strict": false,
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionId": {
          "type": "string",
          "description": "Session to inspect or change. Defaults to this session."
        },
        "thresholdTokens": {
          "type": "number",
          "description": "Token threshold for automatic compaction. Omit to inspect the current setting."
        },
        "clear": {
          "type": "boolean",
          "description": "Remove the override and use the model-derived default."
        }
      },
      "required": []
    }
  }
]
"""
            )!
            .AsArray();
}
