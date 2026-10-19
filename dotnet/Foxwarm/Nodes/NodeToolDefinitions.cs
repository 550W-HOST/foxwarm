using System.Text.Json.Nodes;

namespace Foxwarm.Nodes;

internal static class NodeToolDefinitions
{
    internal static JsonArray All() =>
        JsonNode
            .Parse(
                """
                [
                  {
                    "type": "function", "name": "node",
                    "description": "List available Nodes, select this session's execution Node, or manage a Node through its configured provider. Inspect a provider to see its supported operations and parameters. For select, you may put exec or file calls after it in the same response. Those calls use the selected Node; if selection fails, the remaining calls in that batch are skipped. Provider operations may create or remove resources; inspect the provider's behavior before assuming what will be retained or deleted.",
                    "parameters": { "type": "object", "properties": {
                      "action": { "type": "string", "enum": ["list", "select", "create", "ensure", "inspect", "destroy"], "description": "list shows Nodes and providers; select changes this session's Node; create or ensure uses a provider; inspect shows Node or provider details; destroy requests a Node's removal." },
                      "nodeId": { "type": "string", "description": "Node to select, inspect, or destroy. For create or ensure, supply it when requesting a specific Node ID." },
                      "providerId": { "type": "string", "description": "Configured provider to inspect or use for create or ensure. Inspect accepts either providerId or nodeId, not both. Existing Nodes identify their own provider for destroy." },
                      "parameters": { "type": "object", "description": "Provider-specific options for the lifecycle operation.", "additionalProperties": true },
                      "parametersJson": { "type": "string", "description": "Provider options as a JSON object string when parameters cannot be supplied." },
                      "confirmation": { "type": "string", "description": "For destroy, exactly: destroy node <nodeId>." }
                    }, "required": ["action"] }
                  },
                  {
                    "type": "function", "name": "node_create_auth_token",
                    "description": "Reserve a new approved Node ID and write its per-node auth token to a private file on Main. Returns the Node ID and file path, never the token. Existing Node IDs and files are not replaced. Use run_script with file transfer or exec tools to configure the Node without putting the token in tool arguments or output.",
                    "parameters": { "type": "object", "properties": {
                      "nodeId": { "type": "string", "description": "New Node ID to reserve. Existing IDs are rejected; this does not rotate an existing credential." },
                      "filePath": { "type": "string", "description": "Absolute path on Main for the new token file. Its parent directory must already exist. The file is created with owner-only permissions and contains the token followed by a newline." }
                    }, "required": ["nodeId", "filePath"] }
                  },
                  {
                    "type": "function", "name": "node_remove",
                    "description": "Remove an approved Node and revoke its credentials. Disconnects its active connection without stopping the client process or deleting files, containers, Agents, or Sessions.",
                    "parameters": { "type": "object", "properties": {
                      "nodeId": { "type": "string", "description": "Approved Node ID to remove." }
                    }, "required": ["nodeId"], "additionalProperties": false }
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
                """
            )!
            .AsArray();
}
