using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Timers;

internal static class TimerArguments
{
    internal readonly record struct Schedule(double? At, string? Cron, bool Provided);
    internal static string? Optional(JsonNode? node)
    {
        if (node is null) return null;
        var text = MainTimers.Text(node) ?? (node is JsonValue ? node.ToJsonString() : node is JsonArray array ? string.Join(',', array.Select(Optional)) : "[object Object]");
        text = SessionGoal.Trim(text); return text.Length == 0 ? null : text;
    }
    internal static string Prefix(JsonNode? node)
    {
        var value = Optional(node) ?? "timer";
        if (!Regex.IsMatch(value, "^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)) throw new InvalidDataException("sessionPrefix may only contain letters, numbers, hyphens, and underscores.");
        return value;
    }
    private static bool Present(JsonNode? node) => node is not null && MainTimers.Text(node) != "";
    private static double Coerce(JsonNode? node)
    {
        if (node is null) return 0;
        if (MainTimers.Number(node) is double number) return number;
        if (node is JsonValue scalar && scalar.TryGetValue<bool>(out var flag)) return flag ? 1 : 0;
        return CronFields.Number(Optional(node) ?? "");
    }
    internal static Schedule Normalize(JsonObject args, bool required)
    {
        var hasAt = Present(args["at"]); var rawAfter = Present(args["afterSeconds"]); var seconds = rawAfter ? Coerce(args["afterSeconds"]) : 0;
        var after = rawAfter && double.IsFinite(seconds) && seconds > 0;
        var cron = MainTimers.Text(args["cron"]); cron = cron is null ? null : SessionGoal.Trim(cron); if (cron == "") cron = null;
        if (rawAfter && !after && (seconds != 0 || required && !hasAt && cron is null)) throw new InvalidDataException("afterSeconds must be a positive number.");
        var count = (hasAt ? 1 : 0) + (after ? 1 : 0) + (cron is null ? 0 : 1);
        if (required && count != 1) throw new InvalidDataException("Exactly one of at, afterSeconds, or cron is required.");
        if (!required && count > 1) throw new InvalidDataException("At most one schedule may be updated at a time.");
        if (count == 0) return new(null, null, false);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); double? at = null;
        if (hasAt)
        {
            at = Absolute(args["at"]!);
            if (at <= now) throw new InvalidDataException("at must be in the future.");
        }
        if (after) at = now + seconds * 1000;
        if (at is double absolute && (!double.IsFinite(absolute) || absolute > DateTimeOffset.MaxValue.ToUnixTimeMilliseconds() || absolute < DateTimeOffset.MinValue.ToUnixTimeMilliseconds())) throw new InvalidDataException("Unsupported absolute timer date.");
        if (cron is not null) _ = new CronSchedule(cron, now).Next();
        return new(at, cron, true);
    }
    internal static double Absolute(JsonNode node, TimeZoneInfo? timezone = null)
    {
        if (MainTimers.Number(node) is double value) return value;
        var text = MainTimers.Text(node);
        if (text is null || SessionGoal.Trim(text).Length == 0) throw new InvalidDataException("at must be an ISO date-time string or Unix epoch milliseconds.");
        var match = Regex.Match(text, "^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})(?:T(?<hour>[0-9]{2}):(?<minute>[0-9]{2})(?::(?<second>[0-9]{2})(?:\\.(?<fraction>[0-9]+))?)?(?<zone>Z|[+-][0-9]{2}:?[0-9]{2})?)?$", RegexOptions.CultureInvariant);
        if (match.Success)
        {
            int Part(string name) => match.Groups[name].Success ? int.Parse(match.Groups[name].Value, CultureInfo.InvariantCulture) : 0;
            var year = Part("year"); var month = Part("month"); var day = Part("day"); var hour = Part("hour"); var minute = Part("minute"); var second = Part("second");
            var fraction = match.Groups["fraction"].Value; var milliseconds = fraction.Length == 0 ? 0 : int.Parse((fraction + "000")[..3], CultureInfo.InvariantCulture);
            if (year < 1 || month is < 1 or > 12 || day is < 1 or > 31 || hour > 24 || minute > 59 || second > 59 || hour == 24 && (minute != 0 || second != 0 || milliseconds != 0)) throw new InvalidDataException("Invalid absolute time.");
            var wall = new DateTime(year, month, 1, 0, 0, 0, DateTimeKind.Unspecified).AddDays(day - 1).AddHours(hour).AddMinutes(minute).AddSeconds(second).AddMilliseconds(milliseconds);
            var localStamp = new DateTimeOffset(DateTime.SpecifyKind(wall, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
            var zone = match.Groups["zone"].Value;
            if (zone == "Z" || !match.Groups["hour"].Success) return localStamp;
            if (zone.Length > 0)
            {
                var digits = zone[1..].Replace(":", "", StringComparison.Ordinal); var hours = int.Parse(digits[..2], CultureInfo.InvariantCulture); var minutes = int.Parse(digits[2..], CultureInfo.InvariantCulture);
                if (hours > 23 || minutes > 59) throw new InvalidDataException("Invalid absolute time offset.");
                return localStamp - (zone[0] == '+' ? 1 : -1) * (hours * 60L + minutes) * 60_000;
            }
            timezone ??= TimeZoneInfo.Local;
            // Native Date.parse uses compatible disambiguation, unlike CronDate's
            // guessed-offset-preserving Luxon operations: first fold, forward gap.
            var offsets = new[] { localStamp - 172_800_000, localStamp, localStamp + 172_800_000 }
                .Select(stamp => (long)timezone.GetUtcOffset(DateTimeOffset.FromUnixTimeMilliseconds(stamp)).TotalMilliseconds).Distinct().ToArray();
            var candidates = offsets.Select(offset => localStamp - offset).ToArray();
            var valid = candidates.Where(stamp => stamp + (long)timezone.GetUtcOffset(DateTimeOffset.FromUnixTimeMilliseconds(stamp)).TotalMilliseconds == localStamp).ToArray();
            return valid.Length > 0 ? valid.Min() : candidates.Max();
        }
        if (DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var parsed)) return parsed.ToUnixTimeMilliseconds();
        throw new InvalidDataException("Invalid absolute time.");
    }
    internal static string Message(JsonNode? node)
    {
        var value = MainTimers.Text(node); if (value is null || SessionGoal.Trim(value).Length == 0) throw new InvalidDataException("message must be a non-empty string.");
        return SessionGoal.Trim(value);
    }
}
