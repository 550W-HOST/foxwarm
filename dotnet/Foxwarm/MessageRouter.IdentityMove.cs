using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task<MessageRouteResult> HandleIdentityMoveCommandAsync(
        ChannelContext context,
        JsonObject args,
        SessionOwner owner,
        bool publishReply = true
    )
    {
        var moved = SessionCatalog.Text(args["sessionId"]) ?? context.SessionId;
        try
        {
            var result = await runtime.MoveIdentityAsync(owner, args);
            var reply =
                $"✅ Session `{moved}` moved to `{SessionCatalog.Text(result["targetSessionId"])}`.";
            if (result["aliases"] is JsonArray aliases && aliases.Count > 0)
                reply +=
                    "\nAliases: " + string.Join(", ", aliases.Select(alias => "`" + alias + "`"));
            if (result["updatedChildren"] is JsonArray children && children.Count > 0)
                reply += $"\nUpdated {children.Count} child session parent reference(s).";
            reply +=
                "\nPrevious parent: "
                + (
                    SessionCatalog.Text(result["previousParentSessionId"]) is { } previous
                        ? "`" + previous + "`"
                        : "(none)"
                )
                + ".";
            reply +=
                "\nResulting parent: "
                + (
                    SessionCatalog.Text(result["parentSessionId"]) is { } resulting
                        ? "`" + resulting + "`"
                        : "(none)"
                )
                + ".";
            if (SessionCatalog.Text(result["parentUpdateError"]) is { } failure)
                reply +=
                    "\n⚠️ Identity move committed, but the requested parent update was not confirmed: "
                    + failure
                    + "\nRequested parent: "
                    + (
                        SessionCatalog.Text(result["requestedParentSessionId"]) is { } requested
                            ? "`" + requested + "`"
                            : "(none)"
                    )
                    + ".";
            if (publishReply)
                runtime.ReplyToCommand(owner.Id, reply);
            return new(
                200,
                new JsonObject
                {
                    ["success"] = true,
                    ["commandResponse"] = reply,
                    ["result"] = JsonData.Node(result),
                }
            );
        }
        catch (SessionIdentityMoveException error)
        {
            var reply = "Move failed: " + error.Message;
            if (publishReply)
                runtime.ReplyToCommand(owner.Id, reply);
            return new(
                500,
                new JsonObject
                {
                    ["success"] = false,
                    ["error"] = error.Message,
                    ["commandResponse"] = reply,
                    ["result"] = JsonData.Node(error.Details),
                }
            );
        }
        catch (Exception error)
            when (error is InvalidDataException or InvalidOperationException or IOException)
        {
            var reply = "Move failed: " + error.Message;
            if (publishReply)
                runtime.ReplyToCommand(owner.Id, reply);
            return new(
                409,
                new JsonObject
                {
                    ["success"] = false,
                    ["error"] = error.Message,
                    ["commandResponse"] = reply,
                }
            );
        }
    }
}
