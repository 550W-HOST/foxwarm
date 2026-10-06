using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ToolScriptToolDefinitions
{
    internal static JsonArray Definitions() =>
        JsonNode
            .Parse(
                """
[
  {
    "type": "function",
    "name": "run_script",
    "description": "Run ToolScript code to coordinate tool calls. Supply a script file or inline code. Top-level code can read args and return a result; scripts defining main(args) are called automatically. Returns a runId for inspecting or resuming the run. A run paused at a safe time-budget checkpoint can be resumed with continue_script.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "filePath": {
          "type": "string",
          "description": "Script path. Relative paths use the session working directory, or the agent directory if unset."
        },
        "code": {
          "type": "string",
          "description": "Inline ToolScript. Top-level code can read args and return a result; a defined main(args) is called automatically. When supplied, filePath is not required."
        },
        "args": {
          "type": "object",
          "additionalProperties": true,
          "description": "Input object available to the script as args."
        },
        "argsJson": {
          "type": "string",
          "description": "Input encoded as a JSON object string when args cannot be supplied."
        },
        "mode": {
          "type": "string",
          "enum": [
            "foreground",
            "background"
          ],
          "description": "Run mode. Defaults to foreground. Both modes execute the initial segment before returning; agent-input and time-budget pauses require continue_script in either mode."
        },
        "timeoutSecs": {
          "type": "number",
          "description": "Time budget in seconds for this run segment. Defaults to 30. At a safe pause point after the budget is reached, the run pauses for continue_script rather than failing."
        }
      }
    }
  },
  {
    "type": "function",
    "name": "start_toolscript_run",
    "description": "Start a background ToolScript run. Retained for existing automation; use run_script with mode=background for new calls.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "filePath": {
          "type": "string",
          "description": "Script path. Relative paths use the session working directory, or the agent directory if unset."
        },
        "code": {
          "type": "string",
          "description": "Inline ToolScript. Top-level code can read args and return a result; a defined main(args) is called automatically. When supplied, filePath is not required."
        },
        "args": {
          "type": "object",
          "additionalProperties": true,
          "description": "Input object available to the script as args."
        },
        "argsJson": {
          "type": "string",
          "description": "Input encoded as a JSON object string when args cannot be supplied."
        },
        "mode": {
          "type": "string",
          "enum": [
            "foreground",
            "background"
          ],
          "description": "Run mode. Defaults to background for this compatibility entry point. Both modes execute the initial segment before returning; agent-input and time-budget pauses require continue_script in either mode."
        },
        "timeoutSecs": {
          "type": "number",
          "description": "Time budget in seconds for this run segment. Defaults to 30. At a safe pause point after the budget is reached, the run pauses for continue_script rather than failing."
        }
      }
    }
  },
  {
    "type": "function",
    "name": "continue_script",
    "description": "Resume a ToolScript run paused for agent input or a time budget. Use the runId and continuationId from the pause result. The returned stdout contains only newly produced output; get_toolscript_run returns the accumulated output.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "description": "Run ID returned by run_script."
        },
        "continuationId": {
          "type": "string",
          "description": "Continuation ID from the pause result."
        },
        "input": {
          "type": "string",
          "description": "Text returned to the script's paused ask_agent call. Encode structured input as JSON text. Ignored when resuming a time-budget pause."
        },
        "timeoutSecs": {
          "type": "number",
          "description": "Time budget for this continuation, in seconds. Defaults to the previous segment's budget."
        }
      },
      "required": [
        "runId",
        "continuationId"
      ]
    }
  },
  {
    "type": "function",
    "name": "list_toolscript_runs",
    "description": "List this session's ToolScript runs with their status and progress summaries.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "limit": {
          "type": "number",
          "description": "Maximum runs to return. Defaults to 20, up to 200."
        },
        "status": {
          "type": "string",
          "enum": [
            "running",
            "waiting",
            "completed",
            "failed",
            "cancelled"
          ],
          "description": "Include only runs with this status."
        }
      }
    }
  },
  {
    "type": "function",
    "name": "get_toolscript_run",
    "description": "Inspect a ToolScript run, including its status, pause details, accumulated output, and tool activity.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "description": "Run to inspect."
        }
      },
      "required": [
        "runId"
      ]
    }
  },
  {
    "type": "function",
    "name": "cancel_toolscript_run",
    "description": "Cancel a waiting ToolScript run, or request cancellation of an active run, owned by this session. Already started tool effects are not undone.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "description": "Run to cancel."
        }
      },
      "required": [
        "runId"
      ]
    }
  }
]
"""
            )!
            .AsArray();
}
