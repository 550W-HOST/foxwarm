using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal static class SessionBoundary
{
    internal static bool ApplyChildHandoff(JsonObject envelope, QueueItem item)
    {
        if (item.Type == QueueItemType.User)
        {
            envelope["childHandoffState"] = new JsonObject
            {
                ["boundary"] = "direct-user",
                ["resolved"] = true,
            };
            return true;
        }
        if (
            item.Type == QueueItemType.Intersession
            && item.SourceSessionRelation is "parent" or "other"
        )
        {
            envelope["childHandoffState"] = new JsonObject
            {
                ["boundary"] = "report-required",
                ["resolved"] = false,
            };
            return true;
        }
        return false;
    }

    internal static bool ResolveChildHandoff(JsonObject envelope)
    {
        if (
            envelope["childHandoffState"] is not JsonObject state
            || state["boundary"]?.GetValue<string>() != "report-required"
            || state["resolved"]?.GetValue<bool>() == true
        )
            return false;
        state["resolved"] = true;
        return true;
    }

    internal static bool NeedsChildHandoff(JsonObject envelope) =>
        envelope["childHandoffState"] is JsonObject state
        && state["boundary"]?.GetValue<string>() == "report-required"
        && state["resolved"]?.GetValue<bool>() != true;

    internal static bool IsNoAction(string? text) =>
        !string.IsNullOrWhiteSpace(text)
        && (
            text.Trim().Equals("NO_ACTION", StringComparison.Ordinal)
            || text.TrimEnd().EndsWith("[NO_ACTION]", StringComparison.Ordinal)
        );

    private static string Escape(string value) =>
        value
            .Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal);

    private static string LocalTime()
    {
        var now = DateTimeOffset.Now;
        return now.ToString("yyyy-MM-dd HH:mm:ss ", CultureInfo.InvariantCulture)
            + now.ToString("zzz", CultureInfo.InvariantCulture)
                .Replace(":", "", StringComparison.Ordinal);
    }

    internal static string SessionEvent(string type, string message) =>
        $"<foxwarm-message type=\"{Escape(type)}\" eventType=\"{Escape(type)}\" time=\"{LocalTime()}\" hint=\"{Escape(type)} session event\">\n{message}\n</foxwarm-message>";

    internal static string SystemEvent(string type, string hint) =>
        $"<foxwarm-system hint=\"{Escape(hint)}\" time=\"{LocalTime()}\" type=\"{Escape(type)}\" kind=\"event\" />";

    internal static string Identity(string parent, string current, bool inherited) =>
        $"<foxwarm-system kind=\"session-boundary\" event=\"{(inherited ? "history-inherited" : "new-child")}\" parentSessionId=\"{Escape(parent)}\" currentSessionId=\"{Escape(current)}\" time=\"{LocalTime()}\" />";

    internal static string Completion(string parent, bool handoffConfirmation = false) =>
        $"When you finish, explicitly call send_to_session({{sessionId: `{parent}`, message: \"...\", afterSend: \"finish\"{(handoffConfirmation ? HandoffConfirmation.GuidanceArgument : "")}}}).{(handoffConfirmation ? HandoffConfirmation.Guidance : "")} This sends the final report and ends the turn idle without creating a wait. Use afterSend: \"wait\" only when you genuinely require a later reply from the parent; do not add a separate wait call. If no report or parent action is needed, end your final message with `[NO_ACTION]`.";

    internal static string ManualForkNotice(string parent, string child, string? initialMessage)
    {
        var attributes =
            $"kind=\"session-event\" event=\"manual-fork-created\" currentSessionId=\"{Escape(parent)}\" childSessionId=\"{Escape(child)}\" time=\"{LocalTime()}\"";
        var text =
            $"User manually created fork child session `{child}` from the current session `{parent}`.\nInitial message:";
        return initialMessage is null
            ? $"<foxwarm-system {attributes} initialMessage=\"(none)\">\n{text} (none)\n</foxwarm-system>"
            : $"<foxwarm-system {attributes}>\n{text}\n{initialMessage}\n</foxwarm-system>";
    }
}
