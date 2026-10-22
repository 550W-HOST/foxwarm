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
    "name": "search_tools",
    "defaultInject": true,
    "description": "Find tools and their calling schemas. Results include a toolId or explicit source fields you can pass to call_tool. Search builtin for session and management tools, node for file and shell tools, or mcp for connected servers. Use limit=1 when looking up one known tool.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Words to match in tool names and descriptions. Results matching more words rank higher. Omit to list tools."
        },
        "sources": {
          "type": "array",
          "description": "Sources to search. Defaults to builtin, mcp, and node.",
          "items": {
            "type": "string",
            "enum": [
              "builtin",
              "mcp",
              "node"
            ]
          }
        },
        "server": {
          "type": "string",
          "description": "Limit MCP results to this server. Omit to search all enabled MCP servers."
        },
        "nodeId": {
          "type": "string",
          "description": "Node to search. Omit or use current to search this session's execution Node."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200,
          "description": "Maximum results. Defaults to 5, up to 200."
        },
        "includeSchema": {
          "type": "boolean",
          "description": "Include input schemas for up to the first 10 results. Defaults to true; remaining results use short summaries."
        }
      },
      "additionalProperties": false
    },
    "type": "function",
    "strict": false
  },
  {
    "name": "call_tool",
    "defaultInject": true,
    "description": "Call a tool found with search_tools. Supply its toolId, or identify it with source and name plus server or nodeId when needed. Put the tool's arguments in args. File and shell tools use source=node; session and management tools use builtin. Calling through this tool applies the target tool's normal checks.",
    "parameters": {
      "type": "object",
      "properties": {
        "toolId": {
          "type": "string",
          "description": "Tool ID returned by search_tools, such as builtin:session, mcp:server/tool, or node:master/read."
        },
        "source": {
          "type": "string",
          "enum": [
            "builtin",
            "mcp",
            "node"
          ],
          "description": "Tool source when not using toolId."
        },
        "name": {
          "type": "string",
          "description": "Tool name when not using toolId."
        },
        "server": {
          "type": "string",
          "description": "MCP server name. Required for source=mcp unless included in toolId."
        },
        "nodeId": {
          "type": "string",
          "description": "Node for source=node. Omit or use current to select master, the local execution Node."
        },
        "args": {
          "type": "object",
          "description": "Arguments for the selected tool.",
          "additionalProperties": true
        },
        "argsJson": {
          "type": "string",
          "description": "Arguments encoded as a JSON object string when args cannot be supplied, for example {\"filePath\":\"README.md\"}."
        }
      },
      "additionalProperties": false
    },
    "type": "function",
    "strict": false
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
    "defaultInject": true,
    "description": "Send a message to a specific channel destination. The destination does not need a Session attachment. For a normal-mode channel attached to this session, reply directly instead: your assistant text is delivered automatically. Use this tool for send-only channels or when the task requires delivery to a different destination.",
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
