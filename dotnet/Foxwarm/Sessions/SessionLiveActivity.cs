using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

/// <summary>
/// One activity item in output order. A tool call without a summary has no text but still marks
/// its position, so a running call can hide the later calls of its batch.
/// </summary>
internal readonly record struct LiveActivityItem(bool Reasoning, string? Text, string? CallId);

/// <summary>The committed items since the latest input, and that input's timestamp when known.</summary>
internal sealed record LiveActivitySegment(IReadOnlyList<LiveActivityItem> Items, double? Since)
{
    internal static LiveActivitySegment Empty { get; } = new([], null);
}

/// <summary>The latest reasoning heading and tool summary since the latest input, and which is later.</summary>
internal sealed record LiveActivity(string? Reasoning, string? Tool, bool ReasoningLatest)
{
    internal string Text => (ReasoningLatest ? Reasoning : Tool) ?? Reasoning ?? Tool ?? "";

    internal JsonObject ToJson()
    {
        var result = new JsonObject();
        if (Reasoning is not null)
            result["reasoning"] = Reasoning;
        if (Tool is not null)
            result["tool"] = Tool;
        result["latest"] = ReasoningLatest ? "reasoning" : "tool";
        return result;
    }
}

// Transient presentation of what a busy Session is doing. It is derived from committed history
// after the latest input and from the live model stream; it is never persisted or sent to a model.
internal static partial class SessionLiveActivity
{
    private enum RowKind
    {
        Other,
        Input,
        ContextBlock,
        Model,
    }

    private sealed record RowInfo(RowKind Kind, long? Seq, double? Timestamp, LiveActivityItem[] Items);

    // History records are immutable and shared between history roots, so each is analyzed once.
    private static readonly ConditionalWeakTable<HistoryMessage, RowInfo> rows = new();

    [GeneratedRegex(@"^\*\*[^*\n]+\*\*\s*(?:\r?\n|$)")]
    private static partial Regex FirstHeading();

    [GeneratedRegex(@"^\*\*([^*\n]+)\*\*\s*$", RegexOptions.Multiline)]
    private static partial Regex HeadingLine();

    [GeneratedRegex(
        @"^\s*<\/?foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)\/?\s*>\s*$",
        RegexOptions.IgnoreCase
    )]
    private static partial Regex FoxwarmTagLine();

    [GeneratedRegex(@"([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*""([^""]*)""")]
    private static partial Regex TagAttribute();

    [GeneratedRegex(@"^<foxwarm-system\b[^>]*\/>$")]
    private static partial Regex SelfClosingSystem();

    [GeneratedRegex(@"\bkind=(?:""session-boundary""|'session-boundary')")]
    private static partial Regex SessionBoundaryKind();

    [GeneratedRegex(@"\bevent=(?:""compact-completed""|'compact-completed')")]
    private static partial Regex CompactCompletedEvent();

    [GeneratedRegex(
        @"^<foxwarm-system kind=""goal-reminder""(?: hint=""[^""]*"")?>\n([\s\S]+)\n<\/foxwarm-system>$"
    )]
    private static partial Regex GoalReminder();

    /// <summary>
    /// The last heading of reasoning text under the Reasoning card rule: the text must open with a
    /// bold heading line, and every bold-only line is a heading.
    /// </summary>
    internal static string? ReasoningTitle(string text)
    {
        var trimmed = text.TrimStart();
        if (!FirstHeading().IsMatch(trimmed))
            return null;
        string? title = null;
        foreach (Match match in HeadingLine().Matches(trimmed))
        {
            var value = match.Groups[1].Value.Trim();
            if (value.Length > 0)
                title = value;
        }
        return title is null ? null : ToolActivity.SingleLine(title);
    }

    /// <summary>
    /// Whether a committed row is an input that starts a new activity segment: a user, peer
    /// Session, event or notification input. Tool results, reminders, compaction maintenance,
    /// settings and first-run boundaries are not inputs.
    /// </summary>
    internal static bool IsInput(JsonObject message)
    {
        var meta = message["__meta"] as JsonObject;
        if (
            SessionWait.Text(message["role"]) != "user"
            || Flag(meta?["temporary"])
            || Flag(meta?["optimistic"])
            || Flag(meta?["queuedPreview"])
            || meta?["contextBlock"] is not null
            || EffortChangeRecord.Is(message)
        )
            return false;
        var parts = Parts(message);
        if (InternalTimeline(message, parts) || TaskReminderRow(message) || CompactMaintenance(meta, parts))
            return false;
        return parts.Any(part => part["functionResponse"] is null && part["toolUseId"] is null);
    }

    /// <summary>The activity items a committed model row contributes, in part order.</summary>
    internal static LiveActivityItem[] ModelItems(JsonObject message)
    {
        if (
            SessionWait.Text(message["role"]) != "model"
            || message["modelVisible"] is JsonValue visible
                && visible.TryGetValue<bool>(out var shown)
                && !shown
        )
            return [];
        var meta = message["__meta"] as JsonObject;
        if (Flag(meta?["temporary"]) || Flag(meta?["optimistic"]))
            return [];
        var items = new List<LiveActivityItem>();
        foreach (var part in Parts(message))
        {
            if (SessionWait.Text(part["thinking"]) is { } thinking)
            {
                if (ReasoningTitle(thinking) is { } title)
                    items.Add(new(true, title, null));
            }
            else if (part["functionCall"] is JsonObject call)
            {
                items.Add(new(false, CallSummary(call), SessionWait.Text(call["id"])));
            }
        }
        return items.ToArray();
    }

    /// <summary>The summary of a committed call; unparsable arguments are read as a JSON prefix.</summary>
    internal static string? CallSummary(JsonObject call)
    {
        var name = SessionWait.Text(call["name"]);
        var args =
            SessionWait.Text(call["argsParseError"]) is { Length: > 0 }
            && SessionWait.Text(call["rawArgsText"]) is { } raw
                ? PartialObject(raw)
                : call["args"] as JsonObject;
        return args is null ? null : ToolActivity.CaptionSummary(name, args);
    }

    /// <summary>
    /// The committed items after the latest input of a history root. A context block also ends
    /// earlier evidence, and rows at or before <paramref name="floor"/> belong to an ended turn.
    /// </summary>
    internal static LiveActivitySegment Segment(IReadOnlyList<HistoryMessage> history, long? floor)
    {
        var start = 0;
        double? since = null;
        for (var index = history.Count - 1; index >= 0; index--)
        {
            var row = Analyze(history[index]);
            if (floor is { } ended && row.Seq is { } seq && seq <= ended)
            {
                start = index + 1;
                break;
            }
            if (row.Kind == RowKind.ContextBlock)
            {
                start = index + 1;
                break;
            }
            if (row.Kind == RowKind.Input)
            {
                start = index + 1;
                since = row.Timestamp;
                break;
            }
        }
        var items = new List<LiveActivityItem>();
        for (var index = start; index < history.Count; index++)
            items.AddRange(Analyze(history[index]).Items);
        return items.Count == 0 && since is null ? LiveActivitySegment.Empty : new(items, since);
    }

    /// <summary>
    /// The last displayable items: committed history, then the live stream. A running call marks
    /// the current position, so later calls of its batch appear when they run.
    /// </summary>
    internal static LiveActivity? Select(
        LiveActivitySegment segment,
        IReadOnlyList<LiveActivityItem> stream,
        double? streamStartedAt,
        string? runningCallId
    )
    {
        IEnumerable<LiveActivityItem> items = segment.Items;
        var position = -1;
        if (runningCallId is not null)
            for (var index = segment.Items.Count - 1; index >= 0; index--)
                if (segment.Items[index].CallId == runningCallId)
                {
                    position = index;
                    break;
                }
        if (position >= 0)
            items = segment.Items.Take(position + 1);
        else if (!(segment.Since is { } since && streamStartedAt is { } started && started < since))
            items = items.Concat(stream);
        string? reasoning = null;
        string? tool = null;
        var reasoningLatest = false;
        foreach (var item in items)
        {
            if (item.Text is null)
                continue;
            if (item.Reasoning)
                reasoning = item.Text;
            else
                tool = item.Text;
            reasoningLatest = item.Reasoning;
        }
        return reasoning is null && tool is null ? null : new(reasoning, tool, reasoningLatest);
    }

    private static RowInfo Analyze(HistoryMessage message) =>
        rows.GetValue(
            message,
            static message =>
            {
                var json = message.ToJson();
                var meta = json["__meta"] as JsonObject;
                var seq = message.Sequence;
                var timestamp = SessionWait.Number(meta?["timestamp"]);
                if (meta?["contextBlock"] is not null)
                    return new(RowKind.ContextBlock, seq, timestamp, []);
                if (IsInput(json))
                    return new(RowKind.Input, seq, timestamp, []);
                var items = ModelItems(json);
                return new(items.Length > 0 ? RowKind.Model : RowKind.Other, seq, timestamp, items);
            }
        );

    private static bool Flag(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    private static JsonObject[] Parts(JsonObject message) =>
        (message["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();

    private static bool SystemOnly(JsonObject part, out string text)
    {
        text = SessionWait.Text(part["system"]) ?? "";
        return part.Count == 1 && part["system"] is JsonValue value && value.TryGetValue<string>(out _);
    }

    private static (string Tag, bool Closing, Dictionary<string, string> Attributes)? Tag(
        string text
    )
    {
        var line = text.Split('\n')[0];
        var match = FoxwarmTagLine().Match(line);
        if (!match.Success)
            return null;
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match attribute in TagAttribute().Matches(match.Groups[2].Value))
            attributes[attribute.Groups[1].Value] = System.Net.WebUtility.HtmlDecode(
                attribute.Groups[2].Value
            );
        return (
            match.Groups[1].Value.ToLowerInvariant(),
            line.TrimStart().StartsWith("</", StringComparison.Ordinal),
            attributes
        );
    }

    // Model and Node selection changes and the first-run opening are runtime bookkeeping.
    private static bool InternalSystemPart(JsonObject part)
    {
        if (!SystemOnly(part, out var text) || Tag(text) is not { } tag)
            return false;
        if (tag.Closing || tag.Tag != "system")
            return false;
        var kind = tag.Attributes.GetValueOrDefault("kind");
        return kind == "session-settings-changed"
            || kind == "session-boundary" && tag.Attributes.GetValueOrDefault("event") == "first-run";
    }

    private static bool LightweightMetadata(string text)
    {
        if (Tag(text) is not { } tag)
            return false;
        if (tag.Closing || tag.Tag is "image" or "file" or "metadata")
            return true;
        if (tag.Tag == "message")
            return tag.Attributes.GetValueOrDefault("type") == "channel";
        if (tag.Tag != "system")
            return false;
        return tag.Attributes.GetValueOrDefault("kind")
            is "time"
                or "session"
                or "channel-mode"
                or "question-answer";
    }

    private static bool InternalTimeline(JsonObject message, JsonObject[] parts)
    {
        if (SessionWait.Text(message["__meta"]?["synthetic"]) == "persistentMemorySnapshot")
            return true;
        if (parts.Length == 0)
            return false;
        var internalPart = false;
        foreach (var part in parts)
        {
            if (InternalSystemPart(part))
                internalPart = true;
            else if (!SystemOnly(part, out var text) || !LightweightMetadata(text))
                return false;
        }
        return internalPart;
    }

    private static bool TaskReminderRow(JsonObject message) =>
        Flag(message["__meta"]?[TaskReminder.MetaKey])
        && TaskReminder.IsRow(JsonData.SerializeToElement(message));

    private static bool CompactCompleted(string text)
    {
        var marker = text.Trim();
        return SelfClosingSystem().IsMatch(marker)
            && SessionBoundaryKind().IsMatch(marker)
            && CompactCompletedEvent().IsMatch(marker);
    }

    // The canonical compaction completion row, with or without its generated goal reminder.
    private static bool CompactMaintenance(JsonObject? meta, JsonObject[] parts)
    {
        if (
            Flag(meta?["goalReminder"])
            && SessionWait.Text(meta?["goalReminderKind"]) == "compact-completion"
            && parts.Length == 2
            && SystemOnly(parts[0], out var marker)
            && CompactCompleted(marker)
            && SystemOnly(parts[1], out var reminder)
            && GoalReminder().Match(reminder) is { Success: true } goal
            && goal.Groups[1].Value.Trim().Length > 0
        )
            return true;
        return parts.Length == 1 && SystemOnly(parts[0], out var only) && CompactCompleted(only);
    }

    /// <summary>
    /// The complete members of a JSON object prefix, such as tool arguments still streaming:
    /// strings, numbers and literals once they are complete, and nested objects and arrays with
    /// their complete members so far. Returns null when the text does not start an object.
    /// </summary>
    internal static JsonObject? PartialObject(string raw)
    {
        var reader = new PrefixReader(raw);
        reader.Space();
        return reader.Peek() == '{' ? reader.ReadValue(out _) as JsonObject : null;
    }

    private sealed class PrefixReader(string raw)
    {
        private int offset;

        internal char Peek() => offset < raw.Length ? raw[offset] : '\0';

        internal void Space()
        {
            while (offset < raw.Length && raw[offset] is ' ' or '\t' or '\n' or '\r')
                offset++;
        }

        // Reads one value. complete reports whether it ended inside the text; a container that
        // ends early is returned with its complete members, an incomplete scalar as null.
        internal JsonNode? ReadValue(out bool complete)
        {
            complete = false;
            Space();
            var opening = Peek();
            if (opening == '"')
            {
                var text = ReadString(out complete);
                return complete ? JsonValue.Create(text) : null;
            }
            if (opening is '{' or '[')
                return ReadContainer(opening, out complete);
            var start = offset;
            while (offset < raw.Length && raw[offset] is not (',' or '}' or ']' or ' ' or '\t' or '\n' or '\r'))
                offset++;
            // A scalar is complete only once a delimiter follows it.
            if (offset >= raw.Length || offset == start)
                return null;
            try
            {
                var node = JsonNode.Parse(raw.AsSpan(start, offset - start).ToString());
                complete = node is JsonValue;
                return complete ? node : null;
            }
            catch (JsonException)
            {
                offset = raw.Length;
                return null;
            }
        }

        private JsonNode ReadContainer(char opening, out bool complete)
        {
            complete = false;
            var closing = opening == '{' ? '}' : ']';
            JsonNode container = opening == '{' ? new JsonObject() : new JsonArray();
            offset++;
            Space();
            if (Peek() == closing)
            {
                offset++;
                complete = true;
                return container;
            }
            while (offset < raw.Length)
            {
                Space();
                string? key = null;
                if (container is JsonObject)
                {
                    if (Peek() != '"')
                        break;
                    key = ReadString(out var keyComplete);
                    if (!keyComplete)
                        break;
                    Space();
                    if (Peek() != ':')
                        break;
                    offset++;
                }
                var value = ReadValue(out var valueComplete);
                if (value is not null || valueComplete)
                {
                    if (container is JsonObject members)
                        members[key!] = value;
                    else
                        ((JsonArray)container).Add(value);
                }
                if (!valueComplete)
                    break;
                Space();
                if (Peek() == closing)
                {
                    offset++;
                    complete = true;
                    return container;
                }
                if (Peek() != ',')
                    break;
                offset++;
            }
            offset = raw.Length;
            return container;
        }

        private string? ReadString(out bool complete)
        {
            complete = false;
            var start = offset++;
            while (offset < raw.Length)
            {
                var current = raw[offset++];
                if (current == '"')
                {
                    try
                    {
                        var value = JsonNode.Parse(raw.AsSpan(start, offset - start).ToString());
                        complete = true;
                        return value!.GetValue<string>();
                    }
                    catch (JsonException)
                    {
                        break;
                    }
                }
                if (current == '\\')
                    offset++;
            }
            offset = raw.Length;
            return null;
        }
    }
}
