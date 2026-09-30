using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

public sealed class SessionContinuationUnavailableException(string message = "Session has no interrupted turn to continue.") : InvalidOperationException(message)
{
    public string Code => "SESSION_CONTINUATION_NOT_AVAILABLE";
}

// Direct translation of sessionContinuation.ts; availability is history-derived, never an effect retry ledger.
public static class SessionContinuation
{
    private static JsonNode? Property(JsonNode? node, string key) => node is JsonObject obj ? obj[key] : null;
    private static bool Truthy(JsonNode? node)
    {
        if (node is null) return false;
        if (node is not JsonValue value) return true;
        if (value.TryGetValue<bool>(out var flag)) return flag;
        if (value.TryGetValue<string>(out var text)) return text.Length > 0;
        return SessionWait.Number(node) is not double number || number != 0 && !double.IsNaN(number);
    }
    private static string? Text(JsonNode? value) => SessionWait.Text(value);
    private static bool Flag(JsonNode? value, bool expected) => value is JsonValue scalar && scalar.TryGetValue<bool>(out var flag) && flag == expected;
    private static bool Meaningful(JsonNode? node) => Text(node) is string text && Trim(text).Length > 0;
    private static string Trim(string value)
    {
        static bool Space(char c) => c is '\u0009' or '\u000A' or '\u000B' or '\u000C' or '\u000D' or '\u0020' or '\u00A0' or '\u1680' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' || c is >= '\u2000' and <= '\u200A';
        var start = 0; var end = value.Length;
        while (start < end && Space(value[start])) start++;
        while (end > start && Space(value[end - 1])) end--;
        return value[start..end];
    }
    private static JsonObject[] Parts(JsonObject message) => message["parts"] is JsonArray parts ? parts.OfType<JsonObject>().ToArray() : [];
    private static bool Retry(JsonObject message) => Text(message["__meta"]?["noticeType"]) == "llm-retry";
    private static bool CompactText(JsonNode? value)
    {
        if (Text(value) is not string text) return false;
        text = Trim(text);
        return Regex.IsMatch(text, "^<foxwarm-system\\b[^>]*\\/>$", RegexOptions.ECMAScript)
            && Regex.IsMatch(text, "\\bkind=(?:\"session-boundary\"|'session-boundary')", RegexOptions.ECMAScript)
            && Regex.IsMatch(text, "\\bevent=(?:\"compact-completed\"|'compact-completed')", RegexOptions.ECMAScript);
    }
    private static bool GoalText(JsonNode? value)
    {
        if (Text(value) is not string text) return false;
        var match = Regex.Match(text, "^<foxwarm-system kind=\"goal-reminder\">\\n([\\s\\S]+)\\n</foxwarm-system>$");
        return match.Success && Trim(match.Groups[1].Value).Length > 0;
    }
    private static bool Compact(JsonObject message)
    {
        var parts = Parts(message);
        if (Text(message["role"]) == "user" && Flag(message["__meta"]?["goalReminder"], true)
            && Text(message["__meta"]?["goalReminderKind"]) == "compact-completion" && parts.Length == 2
            && parts[0].Count == 1 && CompactText(parts[0]["system"]) && parts[1].Count == 1 && GoalText(parts[1]["system"])) return true;
        var meaningful = parts.Where(part => Truthy(part["functionCall"]) || Truthy(part["functionResponse"])
            || Meaningful(part["thinking"]) || Meaningful(part["text"]) || Meaningful(part["system"])).ToArray();
        return meaningful.Length > 0 && meaningful.All(part => !Truthy(part["functionCall"]) && !Truthy(part["functionResponse"])
            && !Meaningful(part["thinking"]) && new[] { part["text"], part["system"] }.Where(Meaningful).All(CompactText));
    }
    private static bool Transparent(JsonObject message) => Flag(message["__meta"]?["temporary"], true)
        || Flag(message["__meta"]?["optimistic"], true) || !Retry(message) && (Flag(message["modelVisible"], false) || Compact(message));

    private static bool BareWait(JsonNode? args)
    {
        if (args is null) return true; // Omitted historical args.
        if (args is not JsonObject obj) return false;
        return obj.All(pair => pair.Key switch
        {
            "reason" => Text(pair.Value) is not null,
            "timeoutSeconds" => SessionWait.Number(pair.Value) == 0,
            "waitAllSessions" or "waitExecIds" => pair.Value is JsonArray { Count: 0 },
            _ => false
        });
    }
    private static bool TerminalCall(JsonObject call)
    {
        var name = Text(call["name"]);
        if (name == "wait") return call.ContainsKey("args") && call["args"] is null ? false : BareWait(call["args"]);
        return name is "send_to_session" or "create_child_session" &&
            (Text(Property(call["args"], "afterSend")) is "wait" or "finish" || Flag(Property(call["args"], "waitAfterHandoff"), true) || Flag(Property(call["args"], "noFurtherAssistantReply"), true));
    }
    private static bool TerminalTools(IReadOnlyList<JsonObject> messages, int last)
    {
        var batchIndex = -1;
        for (var index = last - 1; index >= 0; index--)
        {
            var message = messages[index];
            if (Transparent(message) || Text(message["role"]) == "tool") continue;
            if (Text(message["role"]) != "model" || !Parts(message).Any(part => Truthy(part["functionCall"]))) return false;
            batchIndex = index; break;
        }
        if (batchIndex < 0 || Parts(messages[batchIndex]).Any(part => Truthy(part["functionResponse"]))) return false;
        var callNodes = Parts(messages[batchIndex]).Select(part => part["functionCall"]).Where(Truthy).ToArray();
        if (callNodes.Any(node => node is not JsonObject)) return false;
        var calls = callNodes.Cast<JsonObject>().ToArray();
        var byId = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var call in calls)
        {
            var id = Text(call["id"]);
            if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(Text(call["name"])) || !byId.TryAdd(id, call)) return false;
        }
        var responses = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        for (var index = batchIndex + 1; index <= last; index++)
        {
            var message = messages[index]; if (Transparent(message)) continue;
            var parts = Parts(message);
            if (Text(message["role"]) != "tool" || parts.Any(part => Truthy(part["functionCall"]))) return false;
            var responseNodes = parts.Select(part => part["functionResponse"]).Where(Truthy).ToArray();
            if (responseNodes.Any(node => node is not JsonObject)) return false;
            var row = responseNodes.Cast<JsonObject>().ToArray();
            if (row.Length == 0) return false;
            foreach (var response in row)
            {
                var id = Text(response["tool_use_id"]);
                if (string.IsNullOrEmpty(id) || !byId.TryGetValue(id, out var call) || Text(response["name"]) != Text(call["name"]) || !responses.TryAdd(id, response)) return false;
            }
        }
        return responses.Count == calls.Length && byId.Any(pair => TerminalCall(pair.Value) && Property(responses[pair.Key]["response"], "error") is null);
    }
    public static bool IsIncomplete(IReadOnlyList<JsonObject> messages)
    {
        var index = messages.Count - 1;
        while (index >= 0 && Transparent(messages[index])) index--;
        if (index < 0) return false;
        var message = messages[index]; if (Retry(message)) return true;
        var role = Text(message["role"]);
        if (role == "user") return true;
        if (role == "tool") return !TerminalTools(messages, index);
        if (role != "model") return true;
        var parts = Parts(message);
        var calls = parts.Any(part => Truthy(part["functionCall"]));
        var complete = message["__meta"]?["llmSegment"]?["complete"];
        if (Flag(complete, false)) return true;
        if (Flag(complete, true)) return calls;
        return !parts.Any(part => Meaningful(part["text"])) || calls;
    }
}
