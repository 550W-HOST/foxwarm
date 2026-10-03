using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private static bool IsIdentityMoveCommand(string text) => Regex.IsMatch(SessionCatalog.Trim(text), @"^/session\s+move(?:\s|$)");
    private async Task<MessageRouteResult> HandleIdentityMoveCommandAsync(ChannelContext context, string text, SessionOwner owner)
    {
        var tokens = Regex.Split(SessionCatalog.Trim(text), @"\s+").Skip(2).ToArray();
        var args = new JsonObject { ["sessionId"] = context.SessionId }; var remaining = new List<string>(); string? parent = null;
        try
        {
            for (var index = 0; index < tokens.Length; index++)
            {
                if (tokens[index] != "--parent") { remaining.Add(tokens[index]); continue; }
                if (parent is not null || ++index == tokens.Length) throw new InvalidDataException("Provide one --parent followed by an existing Session ID.");
                parent = tokens[index];
            }
            if (remaining.Count != 1) throw new InvalidDataException("Usage: /session move <new-session-id>|<existing-agent>/<new-session-id> [--parent <parent-session-id>]");
            var target = remaining[0].Split('/');
            if (target.Length is < 1 or > 2 || target.Any(string.IsNullOrEmpty)) throw new InvalidDataException("Provide a new Session name or an existing Agent and Session name.");
            args["newSessionId"] = target[^1]; if (target.Length == 2) args["newAgentName"] = target[0]; if (parent is not null) args["parentSessionId"] = parent;
            var result = await runtime.MoveIdentityAsync(owner, args);
            var reply = $"Session `{context.SessionId}` moved to `{SessionCatalog.Text(result["targetSessionId"])}`.";
            if (SessionCatalog.Text(result["parentUpdateError"]) is { } failure) reply += " The identity moved, but the requested parent update failed: " + failure;
            runtime.ReplyToCommand(owner.Id, reply); return new(200, new { success = true, commandResponse = reply, result });
        }
        catch (SessionIdentityMoveException error)
        {
            var reply = "Move failed: " + error.Message; runtime.ReplyToCommand(owner.Id, reply);
            return new(500, new { success = false, error = error.Message, commandResponse = reply, result = error.Details });
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException)
        {
            var reply = "Move failed: " + error.Message; runtime.ReplyToCommand(owner.Id, reply);
            return new(409, new { success = false, error = error.Message, commandResponse = reply });
        }
    }
}
