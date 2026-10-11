using System.Text.Json.Nodes;

namespace Foxwarm.Nodes;

internal static class NodeToolDefinitions
{
    internal static JsonArray All() => JsonNode.Parse("""
    [
      {
        "type": "function", "name": "node",
        "description": "List available Nodes, select this session's execution Node, or inspect a Node. For select, you may put exec or file calls after it in the same response. Those calls use the selected Node; if selection fails, the remaining calls in that batch are skipped.",
        "parameters": { "type": "object", "properties": {
          "action": { "type": "string", "enum": ["list", "select", "inspect"], "description": "list shows Nodes; select changes this session's execution Node; inspect shows a Node's details." },
          "nodeId": { "type": "string", "description": "Node to select or inspect." }
        }, "required": ["action"], "additionalProperties": false }
      },
      {
        "type": "function", "name": "node_bootstrap_info",
        "description": "Get Node setup instructions, bootstrap endpoints, and the pairing token. Commands use config.url when set; otherwise replace the example address with one reachable from the new Node. Treat the pairing token as a secret.",
        "parameters": { "type": "object", "properties": {} }
      },
      {
        "type": "function", "name": "node_pair_approve",
        "description": "Approve a pending Node pairing request. First inspect node_pair_list and verify the request is from the Node you intend to trust.",
        "parameters": { "type": "object", "properties": {
          "pendingId": { "type": "string", "description": "Pending request ID from node_pair_list." },
          "nodeId": { "type": "string", "description": "Node ID to assign. Defaults to the requested name." }
        }, "required": ["pendingId"] }
      },
      {
        "type": "function", "name": "node_pair_list",
        "description": "List Node pairing requests awaiting approval.",
        "parameters": { "type": "object", "properties": {} }
      }
    ]
    """)!.AsArray();
}
