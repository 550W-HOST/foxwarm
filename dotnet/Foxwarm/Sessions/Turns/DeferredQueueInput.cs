using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal static class DeferredQueueInput
{
    private const string Hint =
        "Queued input: this message or event may predate the preceding outputs. Its position here reflects when it was processed, not necessarily when it was sent or occurred.";

    internal static void Mark(IEnumerable<QueueItem> items)
    {
        foreach (var item in items)
            if (
                item.Type != QueueItemType.CompactCommit
                && (item.Message is null || SessionWait.Text(item.Message["role"]) == "user")
                && item.Message?["modelVisible"]?.ToJsonString() != "false"
            )
                item.QueuedInput = true;
    }

    internal static JsonObject Message(QueueItem item, JsonObject message)
    {
        if (
            !item.QueuedInput
            || SessionWait.Text(message["role"]) != "user"
            || message["modelVisible"]?.ToJsonString() == "false"
            || message["parts"] is not JsonArray parts
        )
            return message;
        WithHint(parts);
        return message;
    }

    // Only inspect successive opening metadata parts and the existing outer source wrapper.
    // Never look for a wrapper inside a body, attachment, or historical request projection.
    private static void WithHint(JsonArray parts)
    {
        foreach (var part in parts.OfType<JsonObject>())
        {
            if (SessionWait.Text(part["system"]) is not { } system)
                return;
            var opening = Regex.Match(
                system,
                @"^(\s*)<foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)>",
                RegexOptions.IgnoreCase
            );
            if (!opening.Success)
                return;
            var tag = opening.Groups[2].Value.ToLowerInvariant();
            var attributes = opening.Groups[3].Value;
            var kind = Regex
                .Matches(attributes, "([a-zA-Z_:][a-zA-Z0-9_.:-]*)\\s*=\\s*\"([^\"]*)\"")
                .LastOrDefault(match => match.Groups[1].Value == "kind")
                ?.Groups[2]
                .Value;
            if (tag == "system" && kind is "session" or "channel-mode" or "time")
            {
                if (
                    !Regex.IsMatch(system, @"/\s*>\s*$")
                    || system[opening.Length..].Trim().Length != 0
                )
                    return;
                continue;
            }
            if (tag is not ("message" or "system"))
                return;
            var head = Regex.Replace(opening.Value, "\\s+queueInputHint\\s*=\\s*\"[^\"]*\"", "");
            var end = Regex.Match(head, @"\s*/?\s*>$");
            var selfClosing = Regex.IsMatch(end.Value, @"/\s*>$");
            part["system"] =
                head[..end.Index]
                + " queueInputHint=\""
                + Hint
                + "\""
                + (selfClosing ? " />" : ">")
                + system[opening.Length..];
            return;
        }
    }
}
