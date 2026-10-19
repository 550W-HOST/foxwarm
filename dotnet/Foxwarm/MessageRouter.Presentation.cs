using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private const string CommandSpace =
        "[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]";

    internal static bool IsPresentationCommand(string text) =>
        Regex.IsMatch(
            SessionCatalog.Trim(text),
            "^/session"
                + CommandSpace
                + "+(archive|unarchive|parent|unparent)(?:"
                + CommandSpace
                + "|$)"
        );

    private MessageRouteResult HandlePresentationCommand(ChannelContext context, string text, bool publishReply = true)
    {
        void Reply(string id, string value) { if (publishReply) runtime.ReplyToCommand(id, value); }
        var words = Regex.Split(SessionCatalog.Trim(text), CommandSpace + "+");
        var action = words[1];
        var args = words.Skip(2).ToArray();
        var reply = "";
        JsonObject? outcome = null;
        try
        {
            if (action is "archive" or "unarchive")
            {
                var requested = args.FirstOrDefault() ?? context.SessionId;
                var canonical = SessionCatalog.Text(
                    runtime.Catalog.Resolve(requested)["sessionId"]
                );
                if (canonical is null)
                    reply = $"❌ Session `{requested}` not found.";
                else
                {
                    outcome = runtime
                        .ChangePresentation(catalog =>
                            catalog.Archive(canonical, action == "archive", singleCommand: true)
                        )
                        .Result;
                    reply =
                        $"✅ Session `{requested}` {(action == "archive" ? "archived" : "unarchived")}.";
                }
            }
            else if (action == "parent" && args.Length == 0)
                reply = "Usage: /session parent <parent-session-id> [child-session-id]";
            else
            {
                var child =
                    action == "parent"
                        ? args.Skip(1).FirstOrDefault() ?? context.SessionId
                        : args.FirstOrDefault() ?? context.SessionId;
                outcome = runtime
                    .ChangePresentation(catalog =>
                        catalog.SetParent(child, action == "parent" ? args[0] : null)
                    )
                    .Result;
                var previous = SessionCatalog.Text(outcome["previousParentSessionId"]);
                var parent = SessionCatalog.Text(outcome["parentSessionId"]);
                var label = child == context.SessionId ? "Current session" : $"Session `{child}`";
                if (action == "parent")
                    reply =
                        previous == parent
                            ? $"ℹ️ {label} already uses parent `{parent}`."
                            : $"✅ {label} parent set to `{parent}`."
                                + (previous is null ? "" : $"\nPrevious parent: `{previous}`");
                else
                    reply = previous is null
                        ? $"ℹ️ {label} has no parent session."
                        : $"✅ {label} detached from parent session `{previous}`.";
            }
        }
        catch (SessionPresentationException error)
        {
            reply =
                $"❌ {(action == "parent" ? "Parent update" : action == "unparent" ? "Unparent" : "Command")} failed: {error.Message}";
        }
        catch (PresentationCommittedException error)
        {
            Reply(
                context.SessionId,
                "Command change committed, but its notification failed."
            );
            return new(
                500,
                new
                {
                    error = error.Message,
                    committed = true,
                    commandResponse = "Command change committed, but its notification failed.",
                    result = error.Change.Result,
                }
            );
        }
        catch (Exception error)
        {
            reply = $"Command error: {error.Message}";
            Reply(context.SessionId, reply);
            return new(
                500,
                new
                {
                    success = false,
                    error = error.Message,
                    commandResponse = reply,
                }
            );
        }
        Reply(context.SessionId, reply);
        return new(
            200,
            new
            {
                success = true,
                commandResponse = reply,
                result = outcome,
            }
        );
    }
}
