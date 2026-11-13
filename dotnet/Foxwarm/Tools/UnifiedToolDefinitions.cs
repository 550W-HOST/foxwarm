using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class UnifiedToolDefinitions
{
    internal static JsonArray All() =>
        JsonNode
            .Parse(
                """
[
  {
    "type": "function",
    "strict": false,
    "name": "ctl",
    "description": "Run a Foxwarm runtime command, such as `session list`, `memory read MEMORY.md` or `timer create …`. Commands act on Sessions, Agents, Nodes, memory, history, skills, timers, configuration and MCP or Node tools with this Session's permissions; they don't run in a shell. Start with `help`, or add `--help` to any command. Pass long text or JSON as `@name` and supply it in `values`.",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "One command. Quote arguments containing spaces. An argument that is exactly `@name` takes `values.name`; write `@@` for a literal leading `@`."
        },
        "values": {
          "type": "object",
          "description": "Values for `@name` arguments, used as-is: multi-line text, numbers, arrays or objects.",
          "additionalProperties": true
        },
        "valuesJson": {
          "type": "string",
          "description": "`values` as a JSON object string when `values` cannot be supplied."
        }
      },
      "required": ["command"],
      "additionalProperties": false
    }
  },
  {
    "type": "function",
    "strict": false,
    "name": "mcp_notifications",
    "description": "Start, stop, or inspect message notifications from a configured MCP server for the current Session. Requires Streamable HTTP and Foxwarm notification support. Calls to the server share this Session's connection. Incoming messages enter this Session's normal queue only while reception is enabled; disconnected messages are not replayed. See the mcp-management skill for setup and explicit replies between instances.",
    "parameters": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "enum": ["start", "stop", "status"], "description": "Operation to perform." },
        "server": { "type": "string", "description": "Configured MCP server name." }
      },
      "required": ["action", "server"]
    }
  },
  {
    "type": "function",
    "strict": false,
    "name": "send_to_channel",
    "description": "Send a message to a specific channel destination. The destination does not need a Session attachment. For a normal-mode channel attached to this Session, reply directly instead: your assistant text is delivered automatically. Use this tool for send-only channels or when the task requires delivery to a different destination.",
    "parameters": {
      "type": "object",
      "properties": {
        "channelTargetId": { "type": "string", "description": "Destination in the form <channel-instance-id>:<conversation-id>." },
        "message": { "type": "string", "description": "Message to deliver." }
      },
      "required": ["channelTargetId", "message"]
    }
  },
  {
    "name": "mcp_config",
    "description": "Add or update an MCP server connection. Successful changes apply to subsequent calls without restarting Foxwarm; use enable=false to disable a server. Load the mcp-management skill before changing connections. Use this tool rather than editing the configuration file when the change must apply immediately.",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Name identifying the server."
        },
        "url": {
          "type": "string",
          "description": "MCP endpoint URL. Use its streamable HTTP endpoint for streamable-http or auto, or its SSE endpoint for sse."
        },
        "command": {
          "type": "string",
          "description": "Executable to start for stdio transport."
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Command-line arguments for the stdio server."
        },
        "env": {
          "type": "object",
          "description": "Additional environment variables for the stdio server.",
          "additionalProperties": {
            "type": "string"
          }
        },
        "envJson": {
          "type": "string",
          "description": "Environment variables as a JSON object string when env cannot be supplied. All values must be strings."
        },
        "cwd": {
          "type": "string",
          "description": "Working directory for the stdio server."
        },
        "stderr": {
          "type": "string",
          "description": "How to handle the stdio server's standard error stream: inherit, pipe, or ignore."
        },
        "token": {
          "type": "string",
          "description": "Bearer token for the Authorization header."
        },
        "headers": {
          "type": "object",
          "description": "HTTP request headers. An explicit Authorization header takes precedence over token.",
          "additionalProperties": {
            "type": "string"
          }
        },
        "headersJson": {
          "type": "string",
          "description": "HTTP headers as a JSON object string when headers cannot be supplied. All values must be strings."
        },
        "transport": {
          "type": "string",
          "description": "Connection transport. Defaults to auto."
        },
        "type": {
          "type": "string",
          "description": "Alternative name for transport."
        },
        "description": {
          "type": "string",
          "description": "Short description of the server."
        },
        "timeoutSeconds": {
          "type": "number",
          "minimum": 0,
          "maximum": 3600,
          "description": "Time limit for calls to this server, in seconds, from 1 to 3,600. Use 0 to restore the default of 60 seconds. Does not change connection or tool-listing timeouts."
        },
        "enable": {
          "type": "boolean",
          "description": "Whether this server is enabled."
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    },
    "type": "function",
    "strict": false
  },
  {
    "name": "list_mcp_servers",
    "description": "List configured MCP servers, including disabled ones, with redacted connection summaries. A null timeoutSeconds means the default of 60 seconds is used.",
    "parameters": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "type": "function",
    "strict": false
  }
]
"""
            )!
            .AsArray();
}
