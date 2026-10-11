using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task<MessageRouteResult> HandleNodeCommandAsync(string text, SessionOwner owner)
    {
        var args = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Skip(1).ToArray();
        var manager = runtime.Manager;
        try
        {
            JsonObject result;
            if (args.Length == 0 || args.SequenceEqual(new[] { "list" }))
                result = new() { ["nodes"] = manager.NodeSummaries(), ["pending"] = manager.Nodes.ListPending() };
            else if (args.SequenceEqual(new[] { "pair-help" })) result = manager.Bootstrap!.Info();
            else if (args.Length == 2 && args[0] == "create") result = manager.Nodes.Registry.Create(args[1]);
            else if (args.Length is 2 or 3 && args[0] == "approve") result = await manager.Nodes.ApproveAsync(args[1], args.Length == 3 ? args[2] : null);
            else if (args.Length == 2 && args[0] == "reject") { manager.Nodes.Reject(args[1], null); result = new() { ["success"] = true }; }
            else if (args.Length == 2 && args[0] == "remove") { manager.Nodes.Remove(args[1]); result = new() { ["success"] = true }; }
            else if (args.Length == 3 && args[0] == "move") { manager.Nodes.Rename(args[1], args[2]); result = new() { ["success"] = true }; }
            else if (args.Length == 2 && args[0] == "inspect") result = manager.NodeSummaries().OfType<JsonObject>().FirstOrDefault(value => SessionWait.Text(value["id"]) == args[1]) ?? throw new InvalidDataException("Node not found.");
            else if (args.Length == 1) result = await manager.SelectNodeAsync(owner, args[0]);
            else throw new InvalidDataException("Use /node list, create <id>, approve <pending-id> [id], reject <pending-id>, remove <id>, move <old-id> <new-id>, inspect <id>, pair-help, or <id>.");
            return new(200, new { success = true, text = result.ToJsonString() });
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException)
        { return new(400, new { error = error.Message }); }
    }
}
