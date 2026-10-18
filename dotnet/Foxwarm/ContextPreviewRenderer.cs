using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

// Selected-page Message previews; search input and folded display are deliberately independent.
internal sealed partial class ContextPreviewRenderer
{
    private readonly int budget;
    private readonly string detail;
    private readonly string? literal;
    private readonly Regex? include;
    private readonly Regex? exclude;
    private readonly Regex? literalRegex;
    private readonly List<string> warnings = [];
    private bool Active => literal is not null || include is not null || exclude is not null;

    internal ContextPreviewRenderer(JsonObject options, int defaultBudget = 6000)
    {
        var requested = SessionWait.Number(options["previewLength"]);
        if (options["previewLength"] is not null && requested is null)
            throw new InvalidDataException("previewLength must be a number when provided.");
        var value = requested is null or 0 ? defaultBudget : Math.Floor(requested.Value);
        if (!double.IsFinite(value))
            throw new InvalidDataException("previewLength must be a number when provided.");
        budget = (int)Math.Clamp(value, 1000, 20000);
        if (value < 1000)
            warnings.Add($"[warning] previewLength {value} is below the minimum; using 1000.");
        if (value > 20000)
            warnings.Add($"[warning] previewLength {value} exceeds the maximum; using 20000.");
        detail = SessionWait.Text(options["toolDetail"]) ?? "names";
        if (detail is not ("names" or "snippets" or "full"))
            throw new InvalidDataException("toolDetail must be names, snippets, or full.");
        literal =
            SessionWait.Text(options["contentFilter"]) is string filter
            && SessionGoal.Trim(filter).Length > 0
                ? SessionGoal.Trim(filter)
                : null;
        include = Pattern(options["includeRegex"], "includeRegex");
        exclude = Pattern(options["excludeRegex"], "excludeRegex");
        literalRegex = literal is null
            ? null
            : new Regex(
                Regex.Escape(literal),
                RegexOptions.IgnoreCase | RegexOptions.ECMAScript | RegexOptions.CultureInvariant
            );
    }

    private static Regex? Pattern(JsonNode? value, string label)
    {
        if (value is null || SessionWait.Text(value) == "")
            return null;
        if (SessionWait.Text(value) is not string pattern)
            throw new InvalidDataException(label + " must be a string.");
        try
        {
            return new Regex(
                pattern,
                RegexOptions.IgnoreCase | RegexOptions.ECMAScript | RegexOptions.CultureInvariant
            );
        }
        catch (ArgumentException error)
        {
            throw new InvalidDataException($"Invalid {label}: {error.Message}");
        }
    }

    internal static string Clip(string text, int limit)
    {
        if (limit <= 0)
            return "";
        if (text.Length <= limit)
            return text;
        var end = Math.Max(0, limit - 1);
        if (
            end > 0
            && end < text.Length
            && char.IsHighSurrogate(text[end - 1])
            && char.IsLowSurrogate(text[end])
        )
            end--;
        return text[..end] + "…";
    }

    private string Snippet(string text, int length)
    {
        text = SessionGoal.Trim(text);
        if (text.Length <= length)
            return text;
        var matches = new[] { literalRegex, include }
            .Where(regex => regex is not null)
            .Select(regex => regex!.Match(text))
            .Where(match => match.Success)
            .OrderBy(match => match.Index)
            .ToArray();
        if (matches.Length == 0)
            return Clip(text, length);
        var match = matches[0];
        var window = Math.Max(20, length - 2);
        var start = Math.Max(0, match.Index - Math.Max(0, window - Math.Max(1, match.Length)) / 2);
        var end = Math.Min(text.Length, start + window);
        if (end - start < window)
            start = Math.Max(0, end - window);
        if (start > 0 && char.IsLowSurrogate(text[start]) && char.IsHighSurrogate(text[start - 1]))
            start++;
        if (
            end > start
            && end < text.Length
            && char.IsHighSurrogate(text[end - 1])
            && char.IsLowSurrogate(text[end])
        )
            end--;
        return (start > 0 ? "…" : "")
            + SessionGoal.Trim(text[start..end])
            + (end < text.Length ? "…" : "");
    }

    private bool Matches(string text) =>
        (literal is null || text.Contains(literal, StringComparison.OrdinalIgnoreCase))
        && (include is null || include.IsMatch(text))
        && (exclude is null || !exclude.IsMatch(text));

    private string RenderItem(PreviewItem item, int max)
    {
        var prefix = item.Heading + "\n";
        var usable = Math.Max(80, max - prefix.Length);
        var body =
            item.Body.Length <= usable ? item.Body
            : Active ? Snippet(item.Body, usable)
            : Clip(item.Body, usable);
        if (Active && !string.IsNullOrEmpty(item.OmittedTools) && Matches(item.OmittedTools))
        {
            const string note =
                "[Matched in omitted tool call/result content; rerun with toolDetail:\"snippets\" or \"full\" to inspect.]";
            body =
                body.Length + note.Length + 1 <= usable
                    ? body + "\n" + note
                    : Snippet(body, Math.Max(40, usable - note.Length - 1)) + "\n" + note;
        }
        if (Active)
        {
            var count = 0;
            foreach (var regex in new[] { literalRegex, include }.Where(regex => regex is not null))
            {
                foreach (Match _ in regex!.Matches(item.Search))
                {
                    if (++count > 4)
                        break;
                }
                if (count > 4)
                    break;
            }
            if (count > 1 && body.Length + 48 < usable)
                body += $"\n[{count - 1} more match(es) may be omitted by preview budget]";
        }
        return prefix + body;
    }

    internal string Render(
        string sessionId,
        string runtime,
        int total,
        double start,
        IReadOnlyList<JsonObject> messages
    )
    {
        var items = messages.Select((message, index) => Item(message, start + index)).ToArray();
        return RenderItems(
            items,
            runtime,
            matched =>
                $"Session `{sessionId}` - showing {matched} of {total} message(s)"
                + (
                    matched == messages.Count
                        ? ""
                        : $" ({matched} matched after filters from {messages.Count} selected)"
                )
                + ":",
            messages.Count == 0
                ? $"No messages found in session `{sessionId}` (total: {total} messages)."
                : $"No messages matched the requested filters in session `{sessionId}` (total: {total} messages)."
        );
    }

    internal int Budget => budget;

    internal PreviewItem ArchivedMessage(ArchiveMessageRecord record, string? ownerId = null)
    {
        var item = Item(record.Message, record.Seq);
        var source =
            ownerId is not null && ownerId != record.SessionId
                ? "[inherited: " + record.SessionId + "]"
                : "[local]";
        return item with
        {
            Heading = item.Heading.Replace(
                $"[{record.Seq}]",
                $"[#{record.Seq} time {DateTimeOffset.FromUnixTimeMilliseconds((long)record.Timestamp):O}] "
                    + source,
                StringComparison.Ordinal
            ),
        };
    }

    internal string RenderItems(
        IReadOnlyList<PreviewItem> items,
        string context,
        Func<int, string> titleFor,
        string empty,
        IReadOnlyList<string>? extraNotices = null,
        int? maxItems = null
    )
    {
        var selected = items.AsEnumerable();
        var notices = new List<string>(warnings);
        void Filter(Func<PreviewItem, bool> predicate, string label)
        {
            var before = selected.Count();
            selected = selected.Where(predicate).ToArray();
            var removed = before - selected.Count();
            if (removed > 0)
                notices.Add(
                    label.Replace(
                        "{count}",
                        removed.ToString(System.Globalization.CultureInfo.InvariantCulture),
                        StringComparison.Ordinal
                    )
                );
        }
        if (literal is not null)
            Filter(
                item => item.Search.Contains(literal, StringComparison.OrdinalIgnoreCase),
                "[filter] contentFilter excluded {count} item(s) because the literal case-insensitive content filter did not match."
            );
        if (include is not null)
            Filter(
                item => include.IsMatch(item.Search),
                "[filter] includeRegex excluded {count} additional item(s) that remained after earlier filter stages."
            );
        if (exclude is not null)
            Filter(
                item => !exclude.IsMatch(item.Search),
                "[filter] excludeRegex excluded {count} additional item(s) that remained after earlier filter stages."
            );
        var matched = (maxItems is { } maximum ? selected.Take(maximum) : selected).ToArray();
        var selectionOmitted = selected.Count() - matched.Length;
        if (selectionOmitted > 0)
            notices.Add($"[selection] {selectionOmitted} additional matched item(s) omitted by the requested result limit.");
        var priority = (extraNotices ?? [])
            .Concat(matched.SelectMany(item => item.PriorityNotices ?? []))
            .Select(SessionGoal.Trim)
            .Where(notice => notice.Length > 0)
            .Take(4)
            .Select(notice => Clip(notice, 560));
        var title = titleFor(matched.Length);
        string Prefix(int reserveForBody)
        {
            var available = Math.Max(0, budget - reserveForBody);
            var sections = new List<string>();
            var used = 0;
            void Append(string text, int max)
            {
                var separator = sections.Count > 0 ? 1 : 0;
                if (text.Length == 0 || max <= separator)
                    return;
                var bounded = Clip(text, max - separator);
                if (bounded.Length == 0)
                    return;
                sections.Add(bounded);
                used += bounded.Length + separator;
            }
            var priorityText = string.Join('\n', priority);
            Append(priorityText, Math.Min(priorityText.Length, Math.Max(0, Math.Min(700, available - used))));
            var medium = string.Join('\n', notices);
            Append(medium, Math.Min(medium.Length, Math.Max(0, available - used)));
            Append(context, Math.Max(0, Math.Min(560, available - used)));
            Append(title, Math.Max(0, available - used));
            return string.Join('\n', sections);
        }
        if (matched.Length == 0)
        {
            var suffix = "\n\n" + empty;
            return Clip((Prefix(suffix.Length) + suffix).TrimStart(), budget);
        }
        var prefix = Prefix(242);
        var output = prefix.Length > 0 ? prefix + "\n\n" : "";
        var omitted = 0;
        for (var index = 0; index < matched.Length; index++)
        {
            var remaining = matched.Length - index;
            var available = budget - output.Length;
            if (available <= 120)
            {
                omitted = remaining;
                break;
            }
            var reserve = remaining > 1 ? 80 : 0;
            var itemBudget = Math.Max(160, (available - reserve) / remaining);
            var item = RenderItem(matched[index], itemBudget);
            var separator = index == 0 ? "" : "\n\n";
            var max = budget - output.Length - separator.Length - reserve;
            if (item.Length > max)
                item = Active ? Snippet(item, Math.Max(60, max)) : Clip(item, Math.Max(60, max));
            if (item.Length == 0)
            {
                omitted = remaining;
                break;
            }
            output += separator + item;
        }
        if (omitted > 0)
        {
            var note =
                $"\n\n[{omitted} item(s) omitted due to previewLength budget {budget}. Narrow the range/filter or raise previewLength up to 20000.]";
            output = Clip(output, budget - note.Length) + note;
        }
        return Clip(output, budget).TrimEnd();
    }
}
