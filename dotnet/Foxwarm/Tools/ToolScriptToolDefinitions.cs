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
    "description": "Run Python-subset ToolScript to coordinate tool calls. Use it for dependent tool calls, conditional steps, or stopping after a failed prerequisite; ordinary adjacent exec calls may run concurrently. Supply code or filePath; args is the input dictionary. Call tools synchronously with call_tool (no await); its first argument can be a tool name or tool ID. Use return for the result. Example: code='return call_tool(\"read\", {\"filePath\": args[\"path\"], \"endLine\": 5})', args={\"path\": \"README.md\"}. Tools return their native values, not a common response envelope. Use call_tool for filesystem/process access rather than Python OS APIs. A defined main(args) is called automatically. Returns status and runId; resume a time-budget or agent-input pause with continue_script using runId and continuationId.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "node": {
          "type": "string",
          "description": "Node containing filePath. Omit or use current for this Session's current Node, or use master for Main. Source selection does not change script execution or nested tools' default Node."
        },
        "filePath": {
          "type": "string",
          "description": "Script path on the source Node. Relative paths follow that Node's file-tool path rules; surrounding whitespace is trimmed. Omit when using inline code."
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
        "node": {
          "type": "string",
          "description": "Node containing filePath. Omit or use current for this Session's current Node, or use master for Main. Source selection does not change script execution or nested tools' default Node."
        },
        "filePath": {
          "type": "string",
          "description": "Script path on the source Node. Relative paths follow that Node's file-tool path rules; surrounding whitespace is trimmed. Omit when using inline code."
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
