using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private static bool IsIdentityMoveCommand(string text) =>
        Regex.IsMatch(SessionCatalog.Trim(text), @"^/session\s+move(?:\s|$)");

    private async Task<MessageRouteResult> HandleIdentityMoveCommandAsync(
        ChannelContext context,
        string text,
        SessionOwner owner,
        bool publishReply = true
    )
    {
        var tokens = Regex.Split(SessionCatalog.Trim(text), @"\s+").Skip(2).ToArray();
        var args = new JsonObject { ["sessionId"] = context.SessionId };
        string? parent = null;
        try
        {
            if (tokens.Length == 0)
                throw new InvalidDataException("Missing move target.");
            for (var index = 1; index < tokens.Length; index++)
            {
                if (tokens[index] != "--parent")
                    throw new InvalidDataException(
                        "Unknown /session move option: " + tokens[index]
                    );
                if (parent is not null)
                    throw new InvalidDataException("--parent may be specified only once.");
                if (++index == tokens.Length)
                    throw new InvalidDataException("Missing parent session ID after --parent.");
                parent = tokens[index];
            }
            var target = tokens[0].Split('/');
            if (target.Length is < 1 or > 2 || target.Any(string.IsNullOrEmpty))
                throw new InvalidDataException(
                    "Provide a new Session name or an existing Agent and Session name."
                );
            args["newSessionId"] = target[^1];
            if (target.Length == 2)
                args["newAgentName"] = target[0];
            if (parent is not null)
                args["parentSessionId"] = parent;
            var result = await runtime.MoveIdentityAsync(owner, args);
            var reply =
                $"✅ Session `{context.SessionId}` moved to `{SessionCatalog.Text(result["targetSessionId"])}`.";
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
                new
                {
                    success = true,
                    commandResponse = reply,
                    result,
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
                new
                {
                    success = false,
                    error = error.Message,
                    commandResponse = reply,
                    result = error.Details,
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
                new
                {
                    success = false,
                    error = error.Message,
                    commandResponse = reply,
                }
            );
        }
    }
}
