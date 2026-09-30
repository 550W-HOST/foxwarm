using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class SessionGoal
{
    internal const string Guidance = "Keep this long-term goal in mind when deciding what to do next.";
    internal static string Trim(string text) => text.Trim('\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff');
    internal static double Interval(JsonNode? value)
    {
        var number = SessionWait.Number(value);
        if (number is null && SessionWait.Text(value) is string text && double.TryParse(Trim(text), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) number = parsed;
        if (number is null || !double.IsFinite(number.Value)) throw new InvalidDataException("remindEvery must be a positive integer.");
        var interval = Math.Truncate(number.Value);
        if (interval < 1) throw new InvalidDataException("remindEvery must be at least 1.");
        return interval;
    }
    internal static bool Reminder(JsonObject row) => (row["__meta"] as JsonObject)?["goalReminder"] is JsonValue flag && flag.TryGetValue<bool>(out var value) && value;
    internal static long Seq(JsonObject row) => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) ?? 0;
    internal static string Format(string goal) => $"<foxwarm-system kind=\"goal-reminder\">\n{Trim(goal)}\n{Guidance}\n</foxwarm-system>";
    internal static bool NoAction(string text)
    {
        text = Trim(text);
        return text == "NO_ACTION" || text == "[NO_ACTION]" || text.EndsWith("[NO_ACTION]", StringComparison.Ordinal);
    }
    internal static (JsonObject Goal, JsonObject Message)? Prepare(SessionState state, long now)
    {
        if (state.AuthorityEnvelope["goalState"] is not JsonObject goal) return null;
        var latest = state.History.LastOrDefault(row => !Reminder(row));
        if (latest?["role"]?.GetValue<string>() == "model" && (latest["parts"] as JsonArray)?.OfType<JsonObject>().Any(part => SessionWait.Text(part["text"]) is string text && NoAction(text)) == true) return null;
        var latestUser = state.History.LastOrDefault(row => row["role"]?.GetValue<string>() == "user");
        if (latestUser is not null && Reminder(latestUser)) return null;
        var anchor = CompactCandidateBuilder.Number(goal["anchorSeq"]) ?? 0;
        var count = 0;
        for (var index = state.History.Count - 1; index >= 0; index--)
        {
            var row = state.History[index];
            if (Seq(row) <= anchor) break;
            if (!Reminder(row)) count++;
        }
        if (count < Interval(goal["remindEvery"])) return null;
        var current = latest is null ? Math.Max(0, state.NextMessageSeq - 1) : Seq(latest);
        if (current <= 0) current = Math.Max(0, state.NextMessageSeq - 1);
        if (state.History.Any(row => Reminder(row) && CompactCandidateBuilder.Number(row["__meta"]?["goalAnchorSeq"]) == current)) return null;
        var updated = (JsonObject)goal.DeepClone(); updated["anchorSeq"] = current;
        return (updated, new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["system"] = Format(SessionWait.Text(goal["goal"]) ?? "") }),
            ["__meta"] = new JsonObject { ["seq"] = state.NextMessageSeq, ["timestamp"] = now, ["goalReminder"] = true, ["goalAnchorSeq"] = current, ["goalReminderKind"] = "interval" }
        });
    }
    internal static void Validate(JsonObject envelope)
    {
        if (envelope["goalState"] is null) return;
        if (envelope["goalState"] is not JsonObject goal || SessionWait.Text(goal["goal"]) is null)
            throw new InvalidDataException("Session authority goalState must contain a goal string.");
        _ = Interval(goal["remindEvery"]);
        if (CompactCandidateBuilder.Number(goal["anchorSeq"]) is not >= 0 || SessionWait.Number(goal["updatedAt"]) is not double updated || !double.IsFinite(updated))
            throw new InvalidDataException("Session authority goalState anchor/time are invalid.");
    }
}
