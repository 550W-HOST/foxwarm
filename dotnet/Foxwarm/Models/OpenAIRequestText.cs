using System.Globalization;
using System.Numerics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Models;

internal static class OpenAIRequestText
{
    private const string Space = "[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
    internal static string Trim(string value)
    {
        var start = 0; var end = value.Length;
        while (start < end && IsWhitespace(value[start])) start++;
        while (end > start && IsWhitespace(value[end - 1])) end--;
        return value[start..end];
    }
    internal static string TrimStart(string value)
    {
        var start = 0; while (start < value.Length && IsWhitespace(value[start])) start++;
        return value[start..];
    }
    private static bool IsWhitespace(char character) => character is '\u0009' or '\u000A' or '\u000B' or '\u000C' or '\u000D' or '\u0020' or '\u00A0' or '\u1680' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' || character is >= '\u2000' and <= '\u200A';
    private static Match Match(string text, string pattern) => Regex.Match(text, pattern.Replace("[\\s\\S]", "(?s:.)", StringComparison.Ordinal).Replace("\\s", Space, StringComparison.Ordinal), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.ECMAScript);
    private static string Attribute(string value)
    {
        value = value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        value = Regex.Replace(value, "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", " ").Replace('\n', ' ');
        value = Trim(Regex.Replace(value, Space + "+", " "));
        return value.Replace("&", "&amp;", StringComparison.Ordinal).Replace("<", "&lt;", StringComparison.Ordinal).Replace(">", "&gt;", StringComparison.Ordinal).Replace("\"", "&quot;", StringComparison.Ordinal).Replace("'", "&apos;", StringComparison.Ordinal);
    }
    private static string Unescape(string value) => value.Replace("&quot;", "\"", StringComparison.Ordinal).Replace("&apos;", "'", StringComparison.Ordinal).Replace("&lt;", "<", StringComparison.Ordinal).Replace("&gt;", ">", StringComparison.Ordinal).Replace("&amp;", "&", StringComparison.Ordinal);
    private static string Tag(Dictionary<string, string?> attrs)
    {
        var values = string.Join(" ", attrs.Where(pair => pair.Value is not null).Select(pair => Regex.Replace(pair.Key, "[^a-zA-Z0-9_.:-]", "") + "=\"" + Attribute(pair.Value!) + "\""));
        return values.Length == 0 ? "<foxwarm-system />" : "<foxwarm-system " + values + " />";
    }
    private static string Wrapped(Dictionary<string, string?> attrs, string content)
    {
        var normalized = Trim(content); var tag = Tag(attrs);
        return normalized.Length == 0 ? tag : tag[..^3] + ">\n" + normalized + "\n</foxwarm-system>";
    }
    private static Dictionary<string, string?>? ParseTag(string value)
    {
        var tag = Match(value, "^\\s*<foxwarm-system\\b([^>]*)/?\\s*>\\s*$");
        if (!tag.Success) return null;
        var result = new Dictionary<string, string?>();
        foreach (Match attr in Regex.Matches(tag.Groups[1].Value, "([a-zA-Z_:][a-zA-Z0-9_.:-]*)" + Space + "*=" + Space + "*\"([^\"]*)\"")) result[attr.Groups[1].Value] = Unescape(attr.Groups[2].Value);
        return result;
    }
    internal static string System(string system)
    {
        var trimmed = Trim(system);
        var legacy = Legacy(trimmed);
        if (legacy is not null) return legacy;
        if (Match(trimmed, "^</?foxwarm-(?:system|metadata|message)\\b").Success)
        {
            var attrs = ParseTag(trimmed);
            if (attrs is not null && !attrs.ContainsKey("kind") && attrs.TryGetValue("hint", out var hint) && hint is not null)
                return Legacy(Trim(hint)) ?? Wrapped(new() { ["kind"] = "system" }, hint);
            return trimmed;
        }
        return Wrapped(new() { ["kind"] = "system" }, system);
    }
    private static string? Legacy(string value)
    {
        var newline = value.IndexOf('\n');
        if (newline >= 0)
        {
            var first = Trim(value[..newline]); var attrs = first.EndsWith("/>", StringComparison.Ordinal) ? ParseTag(first) : null;
            if (attrs is not null) return Wrapped(attrs, value[(newline + 1)..]);
        }
        foreach (var (label, eventName) in new[] { ("COMPACTION COMPLETED. PARENT SESSION", "compact-completed"), ("NEW CHILD SESSION WITH PARENT SESSION", "new-child"), ("HISTORY ABOVE IS INHERITED FROM PARENT SESSION", "history-inherited") })
        {
            var match = Match(value, "^\\*\\*" + Regex.Escape(label) + " `([^`]*)`\\. CURRENT SESSION ID IS `([^`]*)`\\.\\*\\*([\\s\\S]*)$");
            if (!match.Success) continue;
            var payload = Trim(match.Groups[3].Value);
            var attrs = new Dictionary<string, string?> { ["kind"] = "session-boundary", ["event"] = eventName, ["parentSessionId"] = match.Groups[1].Value, ["currentSessionId"] = match.Groups[2].Value };
            if (eventName != "compact-completed") return Wrapped(attrs, payload);
            if (payload.Length > 0) attrs["hint"] = payload;
            return Tag(attrs);
        }
        var time = Match(value, "^current time\\s*=\\s*(.+)$");
        if (time.Success) return Tag(new() { ["kind"] = "time", ["localTime"] = Trim(time.Groups[1].Value) });
        var session = Match(value, "^current session ID\\s*=\\s*(.+)$");
        if (session.Success) return Tag(new() { ["kind"] = "session", ["currentSessionId"] = Trim(session.Groups[1].Value) });
        var goal = Match(value, "^Session goal reminder:\\s*\\n?([\\s\\S]*)$");
        if (goal.Success) return Wrapped(new() { ["kind"] = "goal-reminder" }, goal.Groups[1].Value);
        if (Match(value, "^Reminder: message ended without send_to_session call\\.").Success)
        {
            var parent = Match(value, "send_to_session\\(\\{sessionId:\\s*`([^`]*)`");
            return Wrapped(new() { ["kind"] = "child-reminder", ["event"] = "missing-handoff", ["parentSessionId"] = parent.Success ? parent.Groups[1].Value : null }, value);
        }
        var background = Match(value, "^Background Process Finished\\s*\\n?([\\s\\S]*)$");
        if (background.Success) return Wrapped(new() { ["kind"] = "event", ["type"] = "background-process-finished" }, background.Groups[1].Value);
        foreach (var (text, type) in new[] { ("session resumed after process restart", "session-resumed"), ("retrying last request", "retrying-last-request") })
            if (Match(value, "^" + text + "$" ).Success) return Wrapped(new() { ["kind"] = "event", ["type"] = type }, value);
        var managed = Match(value, "^Managed session `([^`]*)` has (\\d+) pending inbox item\\(s\\)\\.([\\s\\S]*)$");
        if (managed.Success) return Wrapped(new() { ["kind"] = "managed-session", ["event"] = "pending-inbox", ["managedSessionId"] = managed.Groups[1].Value, ["pendingCount"] = managed.Groups[2].Value }, value);
        var compact = Match(value, "^Compaction completed\\.?\\s*([\\s\\S]*)$");
        if (compact.Success) return Tag(new() { ["kind"] = "session-boundary", ["event"] = "compact-completed", ["hint"] = Trim(compact.Groups[1].Value) is { Length: > 0 } hint ? hint : null });
        return null;
    }
    private static string FixedSeconds(double duration)
    {
        var seconds = Math.Max(0, duration) / 1000;
        if (seconds >= 1e21) return Foxwarm.Sessions.EcmaNumber.Format(seconds);
        var bits = (ulong)BitConverter.DoubleToInt64Bits(seconds); var exponentBits = (int)((bits >> 52) & 2047);
        var significand = new BigInteger(bits & ((1UL << 52) - 1));
        if (exponentBits != 0) significand += BigInteger.One << 52;
        var exponent = exponentBits == 0 ? -1074 : exponentBits - 1075;
        var numerator = significand * 10; BigInteger rounded;
        if (exponent >= 0) rounded = numerator << exponent;
        else
        {
            var denominator = BigInteger.One << -exponent;
            rounded = BigInteger.DivRem(numerator, denominator, out var remainder);
            if (remainder * 2 >= denominator) rounded++;
        }
        return (rounded / 10).ToString(CultureInfo.InvariantCulture) + "." + (rounded % 10).ToString(CultureInfo.InvariantCulture);
    }
    internal static string? PreviousRequest(JsonObject response)
    {
        if (response["previousLlmRequest"] is not JsonObject timing || timing["time"] is not JsonValue text || !text.TryGetValue<string>(out var time) || Foxwarm.Sessions.SessionWait.Number(timing["durationMs"]) is not double duration || !double.IsFinite(duration)) return null;
        return Tag(new() { ["kind"] = "time", ["time"] = time, ["prevLLMReqTime"] = FixedSeconds(duration) + "s" });
    }
}
