using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task<MessageRouteResult> HandleNodeCommandAsync(string text, SessionOwner owner)
    {
        var args = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Skip(1)
            .ToArray();
        var manager = runtime.Manager;
        try
        {
            string reply;
            var bound = manager.BoundNode(owner.Agent);
            if (args.Length == 0 || args[0] == "list")
            {
                reply =
                    $"📋 **Nodes**\n\n💡 Current node: `{bound ?? manager.CurrentNode(owner)}`\n"
                    + (
                        bound is null
                            ? ""
                            : $"🔒 Runtime is bound by agent isolation to `{bound}`.\n"
                    )
                    + "\n**Nodes**\n";
                foreach (var node in manager.NodeSummaries().OfType<JsonObject>())
                    reply += NodeRow(node) + "\n";
                var pending = manager.Nodes.ListPending();
                reply += "\n**Pending Approvals**\n";
                if (pending.Count == 0)
                    reply += "- (No pending pairing requests)\n";
                foreach (var entry in pending.OfType<JsonObject>())
                {
                    var protocol = Foxwarm.Nodes.NodeConnectionHub.Protocol(
                        new JsonObject { ["nodeProtocol"] = entry["nodeProtocol"]?.DeepClone() }
                    );
                    reply +=
                        $"- `{entry["id"]}` [{entry["nodeType"]}] requested=`{SessionWait.Text(entry["requestedName"]) ?? "-"}`"
                        + (SessionCatalog.Flag(entry["connected"]) ? " ✅ online" : " offline")
                        + (
                            entry["approvedNodeId"] is null
                                ? ""
                                : $" approved→`{entry["approvedNodeId"]}`"
                        )
                        + (
                            SessionWait.Text(protocol["status"]) == "compatible"
                                ? $" protocol=v{protocol["negotiated"]}"
                                : " ⚠️ upgrade required"
                        )
                        + "\n";
                }
                reply +=
                    "\nCommands:\n- `/node` or `/node list` — list nodes and pending approvals\n- `/node approve <pending-id> [node-id]` — approve a pending node\n- `/node create <node-id>` — create a node ID and receive its initial auth token\n- `/node reject <pending-id>` — reject a pending node\n- `/node remove <node-id>` — remove an approved node and invalidate its credentials\n- `/node move <old-id> <new-id>` — rename an approved node id (node-side credentials must be updated)\n- `/node pair-help` — show pairing/bootstrap help\n- `/node <node-id>` — switch current node\n";
            }
            else if (args[0] == "pair-help")
            {
                var info = manager.Bootstrap!.Info();
                var commands = info["commands"]!.AsObject();
                reply = "🧩 **Node Pairing / Bootstrap Help**\n\n" + info["instruction"] + "\n\n";
                foreach (
                    var (key, title, language) in new[]
                    {
                        ("bareMetal", "Linux CLI", "bash"),
                        ("bareMetalInstall", "Linux CLI with systemd startup", "bash"),
                        ("interactive", "Interactive CLI", "bash"),
                        ("docker", "Docker", "bash"),
                        ("manualCompose", "Manual Docker Compose", "bash"),
                        ("windows", "Windows PowerShell", "powershell"),
                    }
                )
                    reply += $"**{title}**\n```{language}\n{commands[key]}\n```\n\n";
                reply +=
                    "**Shell-only Node (POSIX sh + curl; exec only)**\nFirst run `/node create my-shell`; replace the per-node token placeholder below with its token.\n```sh\n"
                    + commands["shell"]
                    + "\n```\n\n**Approve a pending Node**\nCopy the exact `/node approve <pending-id>` command shown by the client, or approve it in WebUI → Nodes → New nodes.\n\nThe commands above contain pairing credentials. Keep them private.";
            }
            else if (args[0] == "create")
            {
                if (args.Length != 2)
                    throw new InvalidDataException("Usage: `/node create <node-id>`");
                var result = manager.Nodes.Registry.Create(args[1]);
                var info = manager.Bootstrap!.Info();
                var url = SessionWait.Text(info["baseUrl"])!;
                var quote = "'" + url.Replace("'", "'\"'\"'") + "'";
                reply =
                    $"✅ Created node `{result["nodeId"]}`. Its per-node auth token is in the command below. Save it now; it will not be shown again.\n\nStart the Node directly, without a pending approval:\n```bash\nBASE_URL={quote}\ncurl -fsSL \"$BASE_URL/node/run.sh\" | bash -s -- --dir=/opt/foxwarm-node --host=\"$BASE_URL\" --node-id={result["nodeId"]} --auth-token={result["authToken"]}\n```";
            }
            else if (args[0] == "approve")
            {
                if (args.Length < 2)
                    throw new InvalidDataException("Usage: `/node approve <pending-id> [node-id]`");
                var pending = manager
                    .Nodes.ListPending()
                    .OfType<JsonObject>()
                    .FirstOrDefault(row => SessionWait.Text(row["id"]) == args[1]);
                var approved = await manager.Nodes.ApproveAsync(
                    args[1],
                    args.ElementAtOrDefault(2)
                );
                reply =
                    $"✅ Approved pending pairing `{args[1]}`\n\nNode id: `{approved["nodeId"]}`\nRequested name: `{SessionWait.Text(pending?["requestedName"]) ?? "-"}`\nDelivered live: `{(SessionCatalog.Flag(approved["deliveredLive"]) ? "yes" : "no")}`\n\nPer-node token (save securely):\n`{approved["authToken"]}`";
            }
            else if (args[0] == "reject")
            {
                if (args.Length < 2)
                    throw new InvalidDataException("Usage: `/node reject <pending-id>`");
                manager.Nodes.Reject(args[1], null);
                reply = $"✅ Rejected pending pairing `{args[1]}`";
            }
            else if (args[0] == "remove")
            {
                if (args.Length < 2)
                    throw new InvalidDataException("Usage: `/node remove <node-id>`");
                var disconnected = manager.Nodes.Remove(args[1]);
                reply =
                    $"✅ Removed approved node `{args[1]}`.\nRuntime connection: `{(disconnected ? "closed" : "not online")}`.\nThe old node credentials are no longer valid; the node must be paired again before it can reconnect.";
            }
            else if (args[0] == "move")
            {
                if (args.Length < 3)
                    throw new InvalidDataException("Usage: `/node move <old-id> <new-id>`");
                var online = manager.Nodes.Connected(args[1]);
                manager.Nodes.Rename(args[1], args[2]);
                reply =
                    $"✅ Moved approved node `{args[1]}` → `{args[2]}`.\nAuth token hash and metadata were preserved server-side.\nRuntime connection: `{(online ? "old connection closed" : "old node not online")}`.\nNode-side credentials still store the old node id. Update the node credentials file to use nodeId `{args[2]}` with the existing authToken, then restart the node so it reconnects with the new id.";
            }
            else if (args.Length == 2 && args[0] == "inspect")
            {
                var summary =
                    manager
                        .NodeSummaries()
                        .OfType<JsonObject>()
                        .FirstOrDefault(node => SessionWait.Text(node["id"]) == args[1])
                    ?? throw new InvalidDataException("Node not found.");
                reply =
                    $"Node inspection: `{args[1]}`\n```json\n"
                    + summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true })
                    + "\n```";
            }
            else if (bound is not null)
                reply =
                    $"🔒 Current session belongs to an isolated agent bound to node `{bound}`. Changing `currentNode` here would not affect runtime execution. Use `/agent isolated <agent> off` first if you really want to unbind it.";
            else
            {
                var selected = await manager.SelectNodeAsync(owner, args[0]);
                reply =
                    $"✅ Switched to node `{selected["nodeId"]}`\n\nAll file/exec/browser tools will now execute on this node.";
            }
            return new(
                200,
                new
                {
                    success = true,
                    commandResponse = reply,
                    text = reply,
                }
            );
        }
        catch (Exception error)
            when (error is InvalidDataException or InvalidOperationException or IOException)
        {
            return new(400, new { error = error.Message, commandResponse = "❌ " + error.Message });
        }
    }

    private static string NodeRow(JsonObject node) =>
        $"- `{node["id"]}` [{node["type"]}] "
        + (
            SessionWait.Text(node["id"]) == "master" ? "ready"
            : SessionWait.Text(node["protocolCompatibility"]?["status"]) == "upgrade-required"
                ? (SessionCatalog.Flag(node["connected"]) ? "⚠️ connected" : "offline")
                    + " · upgrade required"
            : SessionCatalog.Flag(node["connected"]) ? "✅ online"
            : "offline"
        )
        + (
            SessionWait.Text(node["requestedName"]) is { } requested
            && requested != SessionWait.Text(node["id"])
                ? $" requested=`{requested}`"
                : ""
        )
        + (
            SessionWait.Number(node["lastSeenAt"]) is { } stamp
                ? " lastSeen=" + SessionStatus.Date(stamp)
                : ""
        );
}
