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
        text is not null
        && SessionGoal.Trim(text) is { Length: > 0 } trimmed
        && (
            trimmed.Equals("NO_ACTION", StringComparison.Ordinal)
            || trimmed.EndsWith("[NO_ACTION]", StringComparison.Ordinal)
        );

    internal static string ChildReminder(
        string parentSessionId,
        bool handoffConfirmation = false,
        bool externalRuntime = false
    )
    {
        var args = handoffConfirmation
            ? HandoffConfirmation.GuidanceArgument(
                parentSessionId,
                externalRuntime ? "continue" : "finish"
            )
            : $"sessionId: `{Escape(parentSessionId)}`, message: \"...\", afterSend: \"{(externalRuntime ? "continue" : "finish")}\"";
        var guidance = handoffConfirmation ? HandoffConfirmation.Guidance : "";
        if (externalRuntime)
            return $"<foxwarm-system kind=\"child-reminder\" event=\"missing-handoff\" parentSessionId=\"{Escape(parentSessionId)}\">Reminder: check whether your work still needs a completion report. If your current work is tracked by a task, complete it with the task tool unless it is already complete; do not send a duplicate routine completion report. Otherwise, if you need to report completion to the parent session, call send_to_session({{{args}}}) now.{guidance} Use afterSend: \"continue\" or omit it. After reporting, end your Claude Code response. If you need a reply from the parent, send the question and end this response; the reply will arrive as new input. If no separate report or parent action is needed, say `[NO_ACTION]`.</foxwarm-system>";
        return $"<foxwarm-system kind=\"child-reminder\" event=\"missing-handoff\" parentSessionId=\"{Escape(parentSessionId)}\">Reminder: check whether your work still needs a completion report. If your current work is tracked by a task, complete it with the task tool unless it is already complete; do not send a duplicate routine completion report. Otherwise, if you need to report completion to the parent session, call send_to_session({{{args}}}) now.{guidance} This reports so the Session becomes idle without a wait. Use afterSend: \"wait\" only when you genuinely require a later reply; do not add a separate wait call. If no separate report or parent action is needed, say `[NO_ACTION]`.</foxwarm-system>";
    }

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

    internal static IReadOnlyList<JsonObject> ChannelInput(
        IReadOnlyList<JsonObject> parts,
        string platform
    )
    {
        var opening =
            $"<foxwarm-message type=\"channel\" channelType=\"{Escape(platform)}\" time=\"{LocalTime()}\" hint=\"direct user message via channel\">";
        if (parts.All(part => part.Count == 1 && SessionWait.Text(part["text"]) is not null))
            return
            [
                new JsonObject
                {
                    ["system"] =
                        opening
                        + "\n"
                        + string.Join("\n", parts.Select(part => part["text"]!.GetValue<string>()))
                        + "\n</foxwarm-message>",
                },
            ];
        return new[] { new JsonObject { ["system"] = opening } }
            .Concat(parts.Select(part => (JsonObject)part.DeepClone()))
            .Append(new JsonObject { ["system"] = "</foxwarm-message>" })
            .ToArray();
    }

    internal static IReadOnlyList<JsonObject> ExternalChannelInput(
        IReadOnlyList<JsonObject> parts,
        Foxwarm.Channels.ExternalChannelContext source,
        bool sendOnly
    )
    {
        static string Attribute(string value) => LocalSessionTurnHost.EscapeFoxwarmAttribute(value);
        var hint = sendOnly
            ? "direct user message via channel"
            : "direct user message via channel; This channel is in normal mode. Assistant text from this session is automatically delivered to this channel, so you do not need to call send_to_channel to reply here.";
        var opening =
            "<foxwarm-message type=\"channel\" channelInstanceId=\""
            + Attribute(source.Instance)
            + "\" channelType=\""
            + Attribute(source.Type)
            + "\" conversationId=\""
            + Attribute(source.Conversation)
            + "\" channelTargetId=\""
            + Attribute(source.Target)
            + "\""
            + (source.Username is null ? "" : " sender=\"" + Attribute(source.Username) + "\"")
            + " time=\""
            + Attribute(LocalTime())
            + "\" hint=\""
            + Attribute(hint)
            + "\">";
        var result = new List<JsonObject>();
        if (sendOnly)
        {
            var notice =
                "Channel is in send-only mode. If you need to reply, call send_to_channel({channelTargetId: \""
                + source.Target
                + "\", message: \"...\"}).";
            result.Add(
                new JsonObject
                {
                    ["system"] =
                        "<foxwarm-system kind=\"channel-mode\" time=\""
                        + Attribute(LocalTime())
                        + "\" mode=\"send-only\" channelTargetId=\""
                        + Attribute(source.Target)
                        + "\" hint=\""
                        + Attribute(notice)
                        + "\" />",
                }
            );
        }
        if (parts.All(part => part.Count == 1 && SessionWait.Text(part["text"]) is not null))
            result.Add(
                new JsonObject
                {
                    ["system"] =
                        opening
                        + "\n"
                        + string.Join("\n", parts.Select(part => part["text"]!.GetValue<string>()))
                        + "\n</foxwarm-message>",
                }
            );
        else
        {
            result.Add(new JsonObject { ["system"] = opening });
            result.AddRange(parts.Select(part => (JsonObject)part.DeepClone()));
            result.Add(new JsonObject { ["system"] = "</foxwarm-message>" });
        }
        return result;
    }

    internal static string SessionEvent(string type, string message) =>
        $"<foxwarm-message type=\"{Escape(type)}\" eventType=\"{Escape(type)}\" time=\"{LocalTime()}\" hint=\"{Escape(type)} session event\">\n{message}\n</foxwarm-message>";

    internal static string SystemEvent(string type, string hint) =>
        $"<foxwarm-system kind=\"event\" type=\"{Escape(type)}\" hint=\"{Escape(hint)}\" time=\"{LocalTime()}\" />";

    internal static string Identity(string parent, string current, bool inherited) =>
        $"<foxwarm-system kind=\"session-boundary\" event=\"{(inherited ? "history-inherited" : "new-child")}\" parentSessionId=\"{Escape(parent)}\" currentSessionId=\"{Escape(current)}\" time=\"{LocalTime()}\" />";

    internal static string Completion(
        string parent,
        bool handoffConfirmation = false,
        string? taskId = null,
        bool externalRuntime = false
    )
    {
        if (taskId is not null)
            return $"This Session is linked to task {Escape(taskId)}. When the work is complete, complete the task with the task tool; completion automatically notifies the task creator. Do not send a separate routine completion message.";
        var args = handoffConfirmation
            ? HandoffConfirmation.GuidanceArgument(parent, externalRuntime ? "continue" : "finish")
            : $"sessionId: `{parent}`, message: \"...\", afterSend: \"{(externalRuntime ? "continue" : "finish")}\"";
        var guidance = handoffConfirmation ? HandoffConfirmation.Guidance : "";
        if (externalRuntime)
            return $"If your current work is tracked by a task, complete the task with the task tool. Completion notifies a Session creator automatically; do not send a separate routine completion report. For work not tracked by a task, when you finish, explicitly call send_to_session({{{args}}}).{guidance} Use afterSend: \"continue\" or omit it. After reporting, end your Claude Code response. If you need a reply from the parent, send the question and end this response; the reply will arrive as new input. If no separate report or parent action is needed, end your final message with `[NO_ACTION]`.";
        return $"If your current work is tracked by a task, complete the task with the task tool. Completion notifies a Session creator automatically; do not send a separate routine completion report. For work not tracked by a task, when you finish, explicitly call send_to_session({{{args}}}).{guidance} This sends the report and ends the turn idle without creating a wait. Use afterSend: \"wait\" only when you genuinely require a later reply from the parent; do not add a separate wait call. If no separate report or parent action is needed, end your final message with `[NO_ACTION]`.";
    }

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
