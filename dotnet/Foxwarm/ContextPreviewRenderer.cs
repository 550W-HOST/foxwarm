using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

// Selected-page Message previews; search input and folded display are deliberately independent.
internal sealed partial class ContextPreviewRenderer
{
    private readonly int budget;
    private readonly bool externalRead;
    private readonly string detail;
    private readonly HashSet<string> parts;
    private readonly string? literal;
    private readonly Regex? include;
    private readonly Regex? exclude;
    private readonly Regex? literalRegex;
    private readonly List<string> warnings = [];
    private bool Active => literal is not null || include is not null || exclude is not null;

    internal ContextPreviewRenderer(
        JsonObject options,
        int defaultBudget = 6000,
        bool externalRead = false
    )
    {
        this.externalRead = externalRead;
        parts = new HashSet<string>(["text", "tools", "images"], StringComparer.Ordinal);
        if (options.ContainsKey("parts"))
        {
            if (
                options["parts"] is not JsonArray values
                || values.Any(value =>
                    SessionWait.Text(value) is not ("text" or "tools" or "images")
                )
            )
                throw new InvalidDataException("parts must be an array of text, tools, or images.");
            parts = values
                .Select(value => SessionWait.Text(value)!)
                .ToHashSet(StringComparer.Ordinal);
        }
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

    internal static string NormalizeSearch(string text) =>
        SessionGoal.Trim(text.Replace("\r\n", "\n", StringComparison.Ordinal));

    private static string SearchText(PreviewItem item) =>
        NormalizeSearch(item.Search.Length == 0 ? item.Body : item.Search);

    private bool Matches(string text)
    {
        var search = NormalizeSearch(text);
        return (literal is null || search.Contains(literal, StringComparison.OrdinalIgnoreCase))
            && (include is null || include.IsMatch(search))
            && (exclude is null || !exclude.IsMatch(search));
    }

    private string? RenderItem(PreviewItem item, int max)
    {
        var prefix = item.Heading + "\n";
        var folded = detail != "full" && !string.IsNullOrEmpty(item.OmittedTools);
        var toolMatch = Active && folded && Matches(item.OmittedTools!);
        string Notice(bool truncated)
        {
            if (!truncated && !folded)
                return "";
            return "["
                + (truncated ? "Truncated preview. " : "Tool content folded. ")
                + (toolMatch ? "Matched in omitted tool call/result content. " : "")
                + (
                    item.DrillDown is { Length: > 0 } drill
                        ? "Archive original: " + drill
                        : "Narrow the range or increase previewLength/toolDetail."
                            + (
                                externalRead
                                    ? " Archive originals are not available through this endpoint."
                                    : ""
                            )
                )
                + "]";
        }
        var note = Notice(false);
        var usable = max - prefix.Length - (note.Length > 0 ? note.Length + 1 : 0);
        var truncated = item.Body.Length > usable;
        if (truncated)
        {
            note = Notice(true);
            usable = max - prefix.Length - note.Length - 1;
        }
        // Never cut a recovery call or present a budget excerpt as the full body.
        if (usable < Math.Min(20, item.Body.Length))
            return null;
        var body = truncated
            ? (Active ? Snippet(item.Body, usable) : Clip(item.Body, usable))
            : item.Body;
        return prefix + body + (note.Length > 0 ? "\n" + note : "");
    }

    internal string Render(
        string sessionId,
        string runtime,
        int total,
        double start,
        IReadOnlyList<JsonObject> messages
    )
    {
        var items = messages
            .Select((message, index) => Item(message, (int)start + index, sessionId))
            .ToArray();
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
        var item = Item(record.Message, sessionId: ownerId ?? record.SessionId);
        var source =
            ownerId is not null && ownerId != record.SessionId
                ? "[inherited: " + record.SessionId + "]"
                : "[local]";
        return item with
        {
            Heading =
                $"[#{record.Seq}{Time(record.Timestamp)}] "
                + source
                + " "
                + Text(record.Message["role"])
                + Visibility(record.Message)
                + ":",
            SourceIndex = record.Seq,
            ArchiveSession = ownerId ?? record.SessionId,
            Sequence = record.Seq,
            EndSequence = record.Seq,
            DrillDown = ArchiveDrill(ownerId ?? record.SessionId, "msg#" + record.Seq),
        };
    }

    internal string LiveCall(JsonObject args)
    {
        if (!externalRead)
            return "view_session(" + EcmaJson.Stringify(args) + ")";
        var external = (JsonObject)args.DeepClone();
        external["action"] = "read";
        return "foxwarm_session(" + EcmaJson.Stringify(external) + ")";
    }

    internal string RenderLive(string sessionId, SessionViewPage page, JsonObject options)
    {
        var items = page.Messages.Select(row => Item(row.Message, row.Index, sessionId)).ToArray();
        JsonObject Navigation(bool older)
        {
            var args = (JsonObject)options.DeepClone();
            args["sessionId"] = sessionId;
            args.Remove(older ? "start" : "before");
            args[older ? "before" : "start"] = older ? page.Begin : page.End;
            args["count"] = page.Count;
            args["historyVersion"] = page.HistoryVersion;
            return args;
        }
        var navigation = new List<string>
        {
            page.Begin > 0 && page.Count > 0
                ? "Older: " + LiveCall(Navigation(true))
                : "No older eligible page.",
        };
        if (externalRead && page.End < page.Total && page.Count > 0)
            navigation.Add("Newer: " + LiveCall(Navigation(false)));
        return RenderItems(
            items,
            $"Session `{sessionId}` · active indices [{page.Begin},{page.End}) of {page.Total}; historyVersion:{page.HistoryVersion}.\n"
                + SessionStatus.Runtime(page.Runtime),
            matched => $"{matched} matches from {items.Length} selected eligible source records.",
            page.Count == 0 ? "Header only."
                : items.Length == 0 ? "No eligible content in this range."
                : "No selected records matched these page filters; older history was not searched.",
            navigation
        );
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
                item => SearchText(item).Contains(literal, StringComparison.OrdinalIgnoreCase),
                "[filter] contentFilter excluded {count} item(s) because the literal case-insensitive content filter did not match."
            );
        if (include is not null)
            Filter(
                item => include.IsMatch(SearchText(item)),
                "[filter] includeRegex excluded {count} additional item(s) that remained after earlier filter stages."
            );
        if (exclude is not null)
            Filter(
                item => !exclude.IsMatch(SearchText(item)),
                "[filter] excludeRegex excluded {count} additional item(s) that remained after earlier filter stages."
            );
        var sourceMatches = (maxItems is { } maximum ? selected.Take(maximum) : selected).ToArray();
        var matched = GroupTools(sourceMatches);
        var selectionOmitted = selected.Count() - sourceMatches.Length;
        if (selectionOmitted > 0)
            notices.Add(
                $"[selection] {selectionOmitted} additional matched item(s) omitted by the requested result limit."
            );
        var priority = (extraNotices ?? [])
            .Concat(matched.SelectMany(item => item.PriorityNotices ?? []))
            .Select(SessionGoal.Trim)
            .Where(notice => notice.Length > 0)
            .Take(4)
            .ToArray();
        var title = titleFor(sourceMatches.Length);
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
            var titleReserve = Math.Min(160, title.Length) + 1;
            Append(context, Math.Max(0, Math.Min(360, available - used - titleReserve)));
            foreach (var notice in priority)
            {
                var remaining = available - used - titleReserve;
                var action =
                    notice.Contains("recall(", StringComparison.Ordinal)
                    || notice.Contains("view_session(", StringComparison.Ordinal)
                    || notice.Contains("foxwarm_session(", StringComparison.Ordinal);
                if (action && notice.Length + 1 > remaining)
                    Append(
                        "[Navigation exceeds this preview budget; rerun with previewLength:20000 or shorter page filters.]",
                        remaining
                    );
                else
                    Append(notice, Math.Max(0, action ? remaining : Math.Min(560, remaining)));
            }
            var medium = string.Join('\n', notices);
            Append(
                medium,
                Math.Min(medium.Length + 1, Math.Max(0, available - used - titleReserve))
            );
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
        string Omission(PreviewItem[] rows)
        {
            var first = rows[0];
            var last = rows[^1];
            var drill =
                first.ArchiveSession is { } session
                && first.Sequence is { } seq
                && last.EndSequence is { } end
                && rows.All(row => row.ArchiveSession == session && row.Sequence is not null)
                    ? ArchiveDrill(session, $"msg#{Math.Min(seq, end)}-{Math.Max(seq, end)}")
                    : first.DrillDown;
            return $"[{rows.Length} item(s) not displayed: previewLength budget {budget}. "
                + (
                    drill is { Length: > 0 }
                        ? "Omitted Archive original(s): " + drill
                        : "Narrow the range or raise previewLength."
                            + (
                                externalRead
                                    ? " Archive originals are not available through this endpoint."
                                    : ""
                            )
                )
                + "]";
        }
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
            var reserve = remaining > 1 ? Omission(matched[(index + 1)..]).Length + 2 : 0;
            var separator = index == 0 ? "" : "\n\n";
            var max = available - separator.Length - reserve;
            var itemBudget = Math.Min(max, Math.Max(320, max / remaining));
            var item = RenderItem(matched[index], itemBudget);
            if (item is null)
            {
                omitted = remaining;
                break;
            }
            output += separator + item;
        }
        if (omitted > 0)
        {
            var note = "\n\n" + Omission(matched[^omitted..]);
            output = Clip(output, budget - note.Length) + note;
        }
        return Clip(output, budget).TrimEnd();
    }
}
