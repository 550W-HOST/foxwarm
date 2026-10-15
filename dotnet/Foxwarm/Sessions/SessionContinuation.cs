using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

public sealed class SessionContinuationUnavailableException(
    string message = "Session has no interrupted turn to continue."
) : InvalidOperationException(message)
{
    public string Code => "SESSION_CONTINUATION_NOT_AVAILABLE";
}

// Direct translation of sessionContinuation.ts; availability is history-derived, never an effect retry ledger.
public static class SessionContinuation
{
    private static JsonElement Property(JsonElement node, string key) =>
        node.ValueKind == JsonValueKind.Object && node.TryGetProperty(key, out var value)
            ? value
            : default;

    private static bool Truthy(JsonElement node) =>
        node.ValueKind switch
        {
            JsonValueKind.Undefined or JsonValueKind.Null or JsonValueKind.False => false,
            JsonValueKind.String => node.GetString()!.Length > 0,
            JsonValueKind.Number => node.GetDouble() != 0 && !double.IsNaN(node.GetDouble()),
            _ => true,
        };

    private static string? Text(JsonElement value) =>
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool Flag(JsonElement value, bool expected) =>
        value.ValueKind == (expected ? JsonValueKind.True : JsonValueKind.False);

    private static bool Meaningful(JsonElement node) =>
        Text(node) is string text && Trim(text).Length > 0;

    private static string Trim(string value)
    {
        static bool Space(char c) =>
            c
                is '\u0009'
                    or '\u000A'
                    or '\u000B'
                    or '\u000C'
                    or '\u000D'
                    or '\u0020'
                    or '\u00A0'
                    or '\u1680'
                    or '\u2028'
                    or '\u2029'
                    or '\u202F'
                    or '\u205F'
                    or '\u3000'
                    or '\uFEFF'
            || c is >= '\u2000' and <= '\u200A';
        var start = 0;
        var end = value.Length;
        while (start < end && Space(value[start]))
            start++;
        while (end > start && Space(value[end - 1]))
            end--;
        return value[start..end];
    }

    private static JsonElement[] Parts(JsonElement message)
    {
        var parts = Property(message, "parts");
        return parts.ValueKind == JsonValueKind.Array
            ? parts.EnumerateArray().Where(part => part.ValueKind == JsonValueKind.Object).ToArray()
            : [];
    }

    private static bool Retry(JsonElement message) =>
        Text(Property(Property(message, "__meta"), "noticeType")) == "llm-retry";

    private static bool CompactText(JsonElement value)
    {
        if (Text(value) is not string text)
            return false;
        text = Trim(text);
        return Regex.IsMatch(text, "^<foxwarm-system\\b[^>]*\\/>$", RegexOptions.ECMAScript)
            && Regex.IsMatch(
                text,
                "\\bkind=(?:\"session-boundary\"|'session-boundary')",
                RegexOptions.ECMAScript
            )
            && Regex.IsMatch(
                text,
                "\\bevent=(?:\"compact-completed\"|'compact-completed')",
                RegexOptions.ECMAScript
            );
    }

    private static bool GoalText(JsonElement value)
    {
        if (Text(value) is not string text)
            return false;
        var match = Regex.Match(
            text,
            "^<foxwarm-system kind=\"goal-reminder\">\\n([\\s\\S]+)\\n</foxwarm-system>$"
        );
        return match.Success && Trim(match.Groups[1].Value).Length > 0;
    }

    private static bool Compact(JsonElement message)
    {
        var parts = Parts(message);
        if (
            Text(Property(message, "role")) == "user"
            && Flag(Property(Property(message, "__meta"), "goalReminder"), true)
            && Text(Property(Property(message, "__meta"), "goalReminderKind"))
                == "compact-completion"
            && parts.Length == 2
            && parts[0].EnumerateObject().Count() == 1
            && CompactText(Property(parts[0], "system"))
            && parts[1].EnumerateObject().Count() == 1
            && GoalText(Property(parts[1], "system"))
        )
            return true;
        var meaningful = parts
            .Where(part =>
                Truthy(Property(part, "functionCall"))
                || Truthy(Property(part, "functionResponse"))
                || Meaningful(Property(part, "thinking"))
                || Meaningful(Property(part, "text"))
                || Meaningful(Property(part, "system"))
            )
            .ToArray();
        return meaningful.Length > 0
            && meaningful.All(part =>
                !Truthy(Property(part, "functionCall"))
                && !Truthy(Property(part, "functionResponse"))
                && !Meaningful(Property(part, "thinking"))
                && new[] { Property(part, "text"), Property(part, "system") }
                    .Where(Meaningful)
                    .All(CompactText)
            );
    }

    private static bool Transparent(JsonElement message) =>
        Flag(Property(Property(message, "__meta"), "temporary"), true)
        || Flag(Property(Property(message, "__meta"), "optimistic"), true)
        || !Retry(message) && (Flag(Property(message, "modelVisible"), false) || Compact(message));

    private static bool BareWait(JsonElement args)
    {
        if (args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            return true;
        if (args.ValueKind != JsonValueKind.Object)
            return false;
        return args.EnumerateObject()
            .All(pair =>
                pair.Name switch
                {
                    "reason" => Text(pair.Value) is not null,
                    "timeoutSeconds" => pair.Value.ValueKind == JsonValueKind.Number
                        && pair.Value.GetDouble() == 0,
                    "waitAllSessions" or "waitExecIds" => pair.Value.ValueKind
                        == JsonValueKind.Array
                        && pair.Value.GetArrayLength() == 0,
                    _ => false,
                }
            );
    }

    private static bool TerminalCall(JsonElement call)
    {
        var name = Text(Property(call, "name"));
        if (name == "wait")
            return Property(call, "args").ValueKind == JsonValueKind.Null
                ? false
                : BareWait(Property(call, "args"));
        return name is "send_to_session" or "create_child_session"
            && (
                Text(Property(Property(call, "args"), "afterSend")) is "wait" or "finish"
                || Flag(Property(Property(call, "args"), "waitAfterHandoff"), true)
                || Flag(Property(Property(call, "args"), "noFurtherAssistantReply"), true)
            );
    }

    private static bool TerminalTools(IReadOnlyList<HistoryMessage> messages, int last)
    {
        var batchIndex = -1;
        for (var index = last - 1; index >= 0; index--)
        {
            var message = messages[index].Data;
            if (Transparent(message) || Text(Property(message, "role")) == "tool")
                continue;
            if (
                Text(Property(message, "role")) != "model"
                || !Parts(message).Any(part => Truthy(Property(part, "functionCall")))
            )
                return false;
            batchIndex = index;
            break;
        }
        if (
            batchIndex < 0
            || Parts(messages[batchIndex].Data)
                .Any(part => Truthy(Property(part, "functionResponse")))
        )
            return false;
        var callNodes = Parts(messages[batchIndex].Data)
            .Select(part => Property(part, "functionCall"))
            .Where(Truthy)
            .ToArray();
        if (callNodes.Any(node => node.ValueKind != JsonValueKind.Object))
            return false;
        var calls = callNodes;
        var byId = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var call in calls)
        {
            var id = Text(Property(call, "id"));
            if (
                string.IsNullOrEmpty(id)
                || string.IsNullOrEmpty(Text(Property(call, "name")))
                || !byId.TryAdd(id, call)
            )
                return false;
        }
        var responses = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        for (var index = batchIndex + 1; index <= last; index++)
        {
            var message = messages[index].Data;
            if (Transparent(message))
                continue;
            var parts = Parts(message);
            if (
                Text(Property(message, "role")) != "tool"
                || parts.Any(part => Truthy(Property(part, "functionCall")))
            )
                return false;
            var responseNodes = parts
                .Select(part => Property(part, "functionResponse"))
                .Where(Truthy)
                .ToArray();
            if (responseNodes.Any(node => node.ValueKind != JsonValueKind.Object))
                return false;
            var row = responseNodes;
            if (row.Length == 0)
                return false;
            foreach (var response in row)
            {
                var id = Text(Property(response, "tool_use_id"));
                if (
                    string.IsNullOrEmpty(id)
                    || !byId.TryGetValue(id, out var call)
                    || Text(Property(response, "name")) != Text(Property(call, "name"))
                    || !responses.TryAdd(id, response)
                )
                    return false;
            }
        }
        return responses.Count == calls.Length
            && byId.Any(pair =>
                TerminalCall(pair.Value)
                && Property(Property(responses[pair.Key], "response"), "error").ValueKind
                    is JsonValueKind.Undefined
                        or JsonValueKind.Null
            );
    }

    public static bool IsIncomplete(IReadOnlyList<JsonObject> messages) =>
        IsIncomplete(SessionHistory.FromJson(messages));

    public static bool IsIncomplete(IReadOnlyList<HistoryMessage> messages)
    {
        var index = messages.Count - 1;
        while (index >= 0 && Transparent(messages[index].Data))
            index--;
        if (index < 0)
            return false;
        var message = messages[index].Data;
        if (Retry(message))
            return true;
        var role = Text(Property(message, "role"));
        if (role == "user")
            return true;
        if (role == "tool")
            return !TerminalTools(messages, index);
        if (role != "model")
            return true;
        var parts = Parts(message);
        var calls = parts.Any(part => Truthy(Property(part, "functionCall")));
        var complete = Property(Property(Property(message, "__meta"), "llmSegment"), "complete");
        if (Flag(complete, false))
            return true;
        if (Flag(complete, true))
            return calls;
        return !parts.Any(part => Meaningful(Property(part, "text"))) || calls;
    }
}
