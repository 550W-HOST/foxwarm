using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed record StructuredVectorRecall(
    IReadOnlyList<PreviewItem> Items,
    JsonArray Sources,
    string SearchLabel,
    int HitCount,
    IReadOnlyList<string> Notices,
    IReadOnlyList<JsonObject>? Candidates = null
);

internal static class VectorRecall
{
    internal static int Limit(JsonNode? value)
    {
        if (
            value is null
            || value is JsonValue scalar
                && scalar.TryGetValue<string>(out var text)
                && text.Length == 0
        )
            return 5;
        var number = SessionWait.Number(value);
        if (number is null || !double.IsFinite(number.Value))
            throw new InvalidDataException("limit must be a positive number when provided.");
        return (int)Math.Clamp(Math.Floor(number.Value), 1, 20);
    }

    private static (long First, long Last)? Range(JsonObject hit)
    {
        static long? Positive(JsonNode? value) =>
            SessionWait.Number(value) is { } number
            && number > 0
            && number <= 9007199254740991
            && Math.Floor(number) == number
                ? (long)number
                : null;
        var first =
            Positive(hit["raw_start_seq"]) ?? Positive(hit["start_seq"]) ?? Positive(hit["seq"]);
        var last = Positive(hit["raw_end_seq"]) ?? Positive(hit["end_seq"]) ?? first;
        return first is { } start && last is { } end
            ? (Math.Min(start, end), Math.Max(start, end))
            : null;
    }

    private static JsonObject MessageSource(ArchiveMessageRecord record)
    {
        var message = (JsonObject)record.Message.DeepClone();
        var meta = message["__meta"] as JsonObject ?? new JsonObject();
        if (message["__meta"] is null)
            message["__meta"] = meta;
        meta["seq"] = record.Seq;
        meta["timestamp"] = record.Timestamp;
        meta["contextArchiveItem"] = new JsonObject { ["kind"] = "message", ["seq"] = record.Seq };
        return message;
    }

    private static JsonObject BlockSource(ArchiveBlockRecord block)
    {
        var message = block.ToMessage();
        message["__meta"]!["contextArchiveItem"] = new JsonObject
        {
            ["kind"] = "block",
            ["id"] = block.Id,
        };
        return message;
    }

    internal static async Task<StructuredVectorRecall> SearchAsync(
        VectorService vector,
        Func<string, SqliteArchiveMessageStore> archiveReader,
        string query,
        int limit,
        VectorSearchOptions options,
        string effectiveScope,
        string? resolvedSessionId,
        JsonObject? filters = null,
        bool preferBlocks = false,
        bool bounded = false,
        Action<JsonObject>? fallbackWarning = null,
        Func<string, bool>? sourceAllowed = null,
        bool filterSources = false
    )
    {
        if (Trim(query).Length == 0)
            throw new InvalidDataException("Search query must be non-empty.");
        var candidateLimit = Math.Max(limit * 4, 20);
        var detailed = await vector.SearchAsync(
            query,
            candidateLimit,
            options with
            {
                PreferBlocks = preferBlocks,
            }
        );
        var hits = detailed.Hits;
        var fallbackUsed = false;
        if (
            effectiveScope == "current-session"
            && resolvedSessionId is not null
            && (
                detailed.Lexical["configured"]?.GetValue<bool>() != true
                || detailed.Lexical["ready"]?.GetValue<bool>() != true
                || detailed.Lexical["backfilling"]?.GetValue<bool>() == true
                || detailed.Lexical["errorCode"] is not null
            )
        )
        {
            try
            {
                var lexical = ArchiveLexicalRecall.Search(
                    archiveReader(resolvedSessionId),
                    query,
                    candidateLimit,
                    options
                );
                hits = VectorRuntime.Fuse(hits, lexical, candidateLimit);
                fallbackUsed = lexical.Count > 0;
            }
            catch { }
        }
        var hybridUsed = detailed.Lexical["used"]?.GetValue<bool>() == true;
        var labelText = hybridUsed
            ? fallbackUsed
                ? "hybrid search with bounded identifier fallback"
                : "hybrid search"
            : fallbackUsed
                ? "semantic search with bounded identifier fallback"
                : "vector search";
        var selected = Reload(
            archiveReader,
            hits,
            query,
            bounded ? limit : candidateLimit,
            options,
            resolvedSessionId,
            filters,
            bounded,
            fallbackWarning,
            sourceAllowed,
            filterSources
        );
        return selected with { SearchLabel = labelText };
    }

    internal static StructuredVectorRecall Reload(
        Func<string, SqliteArchiveMessageStore> archiveReader,
        IReadOnlyList<JsonObject> hits,
        string query,
        int limit,
        VectorSearchOptions options,
        string? resolvedSessionId,
        JsonObject? filters = null,
        bool bounded = false,
        Action<JsonObject>? fallbackWarning = null,
        Func<string, bool>? sourceAllowed = null,
        bool filterSources = false,
        bool strict = false
    )
    {
        var renderer = new ContextPreviewRenderer(filters ?? new(), 1000);
        var items = new List<PreviewItem>();
        var sources = new JsonArray();
        var candidates = new List<JsonObject>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var hit in hits)
        {
            var sourceId = Text(hit["session_id"]);
            if (sourceId.Length == 0 || sourceAllowed is not null && !sourceAllowed(sourceId))
            {
                if (strict)
                    throw new InvalidDataException(
                        "A recalled source is no longer accessible; start a new search."
                    );
                continue;
            }
            var readId = bounded && resolvedSessionId is not null ? resolvedSessionId : sourceId;
            if (strict && hit["compatibility"] is JsonObject compatibility)
            {
                // This source was already unavailable when the filtered window was made.
                // Preserve that classification/excerpt, not a newly substituted source.
                var excerpt = Text(compatibility["fallbackExcerpt"]);
                items.Add(new("", excerpt, excerpt, null));
                sources.Add(compatibility.DeepClone());
                candidates.Add(hit);
                continue;
            }
            var archive = archiveReader(readId);
            var kind = Text(hit["kind"]);
            var blockId = SessionWait.Number(hit["block_id"]);
            var modernFact = kind == "fact" && blockId.HasValue;
            var range = Range(hit);
            PreviewItem? item = null;
            JsonObject? source = null;
            var reason = "legacy-source-identity-unavailable";
            var key = Text(hit["source_family"] ?? hit["id"]);
            if (kind == "block" || modernFact)
            {
                if (
                    blockId is { } number
                    && number > 0
                    && number <= 9007199254740991
                    && Math.Floor(number) == number
                    && new ArchiveContextReader(archive).Block((long)number) is { } stored
                )
                {
                    var block = ArchiveContextReader.HydrateBlock(archive, stored);
                    var own = ArchiveContextReader.BlockItem(block, readId);
                    var facts =
                        (hit["matched_facts"] as JsonArray)?.OfType<JsonObject>().Take(3).ToArray()
                        ?? [];
                    var factText = string.Join(
                        "\n\n",
                        facts.Select(fact =>
                            "[matched memory fact"
                            + (
                                Text(fact["fact_kind"]).Length > 0
                                    ? ": " + Text(fact["fact_kind"])
                                    : ""
                            )
                            + (
                                Text(fact["attributed_to"]).Length > 0
                                    ? ", attributed:" + Text(fact["attributed_to"])
                                    : ""
                            )
                            + "]\n"
                            + CompactPrompt.TruncateGraphemes(Text(fact["text"]), 1000, "", false)
                        )
                    );
                    item = own with
                    {
                        Heading = $"[vector source session:{sourceId}] " + own.Heading,
                        Body = own.Body + (factText.Length == 0 ? "" : "\n\n" + factText),
                        Search =
                            own.Search
                            + "\n"
                            + string.Join('\n', facts.Select(fact => Text(fact["text"]))),
                    };
                    key = Text(hit["source_family"]);
                    if (key.Length == 0)
                        key = $"vector:block:{sourceId}:{block.Id}";
                    source = new()
                    {
                        ["key"] = key,
                        ["sessionId"] = readId,
                        ["kind"] = "block",
                        ["sourceRange"] = new JsonObject
                        {
                            ["startSeq"] = block.RawStartSeq,
                            ["endSeq"] = block.RawEndSeq,
                        },
                        ["messages"] = new JsonArray(BlockSource(block)),
                        ["matchedFacts"] = new JsonArray(
                            facts
                                .Select(fact =>
                                    (JsonNode?)
                                        new JsonObject
                                        {
                                            ["kind"] = fact["fact_kind"]?.DeepClone(),
                                            ["text"] = CompactPrompt.TruncateGraphemes(
                                                Text(fact["text"]),
                                                300,
                                                "",
                                                false
                                            ),
                                        }
                                )
                                .ToArray()
                        ),
                    };
                }
                else
                    reason = "archive-block-source-missing";
            }
            if (
                item is null
                && !(modernFact && reason == "archive-block-source-missing")
                && range is { } rawRange
            )
            {
                IReadOnlyList<ArchiveMessageRecord> records =
                    bounded && !filterSources
                        ? []
                        : archive
                            .ReadEffectiveMessagesRange(rawRange.First, rawRange.Last)
                            .Where(record =>
                                (options.StartTime is null || record.Timestamp >= options.StartTime)
                                && (options.EndTime is null || record.Timestamp < options.EndTime)
                            )
                            .ToArray();
                if (
                    (options.StartTime is not null || options.EndTime is not null)
                    && records.Count == 0
                )
                {
                    if (strict)
                        throw new InvalidDataException(
                            "A recalled source is no longer available; start a new search."
                        );
                    continue;
                }
                var window =
                    bounded && !filterSources
                        ? VectorRawWindow.Bounded(
                            archive,
                            rawRange.First,
                            rawRange.Last,
                            query,
                            Text(hit["chunk_text"])
                        )
                        : VectorRawWindow.Select(records, query, Text(hit["chunk_text"]), filters);
                if (window.Records.Count > 0)
                {
                    var messageItems = window
                        .Records.Select(record => renderer.ArchivedMessage(record, readId))
                        .ToArray();
                    key = Text(hit["source_family"]);
                    if (key.Length == 0)
                        key = $"vector:raw:{sourceId}:{rawRange.First}-{rawRange.Last}";
                    item = new(
                        $"[vector source session:{sourceId}; full hit msg#{rawRange.First}-{rawRange.Last}; selected msg#{window.FirstSeq}-{window.LastSeq}; omitted {window.OmittedCount} message(s)]",
                        string.Join(
                            "\n\n",
                            renderer
                                .GroupTools(messageItems)
                                .Select(message =>
                                    (message.Heading.Length > 0 ? message.Heading + "\n" : "")
                                    + message.Body
                                )
                        ),
                        bounded && !filterSources
                            ? ""
                            : string.Join("\n\n", records.Select(VectorRawWindow.SearchText)),
                        string.Join(
                            "\n\n",
                            messageItems
                                .Select(message => message.OmittedTools)
                                .Where(text => !string.IsNullOrEmpty(text))
                        ),
                        window.Notices,
                        DrillDown: ContextPreviewRenderer.ArchiveDrill(
                            readId,
                            $"msg#{window.FirstSeq}-{window.LastSeq}"
                        )
                    );
                    source = new()
                    {
                        ["key"] = key,
                        ["sessionId"] = readId,
                        ["kind"] = "messages",
                        ["sourceRange"] = new JsonObject
                        {
                            ["startSeq"] = rawRange.First,
                            ["endSeq"] = rawRange.Last,
                        },
                        ["messages"] = new JsonArray(
                            window
                                .Records.Select(record => (JsonNode?)MessageSource(record))
                                .ToArray()
                        ),
                    };
                }
                else if (reason != "archive-block-source-missing")
                    reason = "archive-message-source-missing";
            }
            if (item is null)
            {
                if (strict)
                    throw new InvalidDataException(
                        "A recalled source is no longer available; start a new search."
                    );
                try
                {
                    var warning = new JsonObject
                    {
                        ["classification"] = "vector-recall-compatibility-fallback",
                        ["reason"] = reason,
                        ["sourceSessionId"] = SafeClip(Trim(sourceId), 160),
                        ["agent"] = SafeClip(Trim(Text(hit["agent"])), 160),
                        ["memoryKind"] = SafeClip(kind, 160),
                        ["sourceKind"] = SafeClip(Text(hit["source_kind"]), 160),
                        ["blockId"] = blockId,
                        ["rawStartSeq"] = range?.First,
                        ["rawEndSeq"] = range?.Last,
                    };
                    if (fallbackWarning is not null)
                        fallbackWarning(warning);
                    else
                        Console.Error.WriteLine(EcmaJson.Stringify(warning));
                }
                catch { }
                var text =
                    SessionWait.Text(hit["text"])
                    ?? SessionWait.Text(hit["chunk_text"])
                    ?? "[empty vector hit]";
                var label = range is { } fallbackRange
                    ? $"msg#{fallbackRange.First}-{fallbackRange.Last}"
                    : "seq:" + Text(hit["seq"]);
                item = new($"[vector source session:{sourceId} {label}]", text, text, null);
                source = new()
                {
                    ["key"] = key,
                    ["sessionId"] = readId,
                    ["kind"] = "unavailable",
                    ["messages"] = new JsonArray(),
                    ["fallbackExcerpt"] = CompactPrompt.TruncateGraphemes(text, 500, "", false),
                };
                key =
                    "vector:fallback:"
                    + (Text(hit["id"]) is { Length: > 0 } id ? id : sourceId + ":" + label);
            }
            if (!seen.Add(key))
                continue;
            items.Add(item);
            candidates.Add(hit);
            if (bounded)
            {
                if (source is not null)
                {
                    source["rank"] = sources.Count + 1;
                    source["denseDistance"] = hit["_distance"]?.DeepClone();
                    source["lexicalScore"] = hit["lexical_score"]?.DeepClone();
                    source["lexicalRank"] = hit["lexical_rank"]?.DeepClone();
                    source["fusionScore"] = hit["fusion_score"]?.DeepClone();
                    source["locator"] = new JsonObject
                    {
                        ["sessionId"] = Text(source["sessionId"]),
                        ["kind"] = Text(source["kind"]),
                        ["sourceRange"] = source["sourceRange"]?.DeepClone(),
                    };
                    sources.Add(source);
                }
            }
            if (!filterSources && items.Count >= limit)
                break;
        }
        IReadOnlyList<string> notices = [];
        if (filterSources)
        {
            // A cursor already selected these immutable sources with the bound filters.
            // In particular, its bounded compatibility excerpt may omit the original match.
            var filtered = strict
                ? (
                    Items: (IReadOnlyList<PreviewItem>)items,
                    Notices: (IReadOnlyList<string>)Array.Empty<string>()
                )
                : renderer.FilterItems(items);
            notices = filtered.Notices;
            var selected = filtered.Items.Take(limit).ToHashSet(ReferenceEqualityComparer.Instance);
            for (var index = items.Count - 1; index >= 0; index--)
            {
                if (selected.Contains(items[index]))
                    continue;
                items.RemoveAt(index);
                candidates.RemoveAt(index);
                sources.RemoveAt(index);
            }
            for (var index = 0; index < sources.Count; index++)
                sources[index]!["rank"] = index + 1;
        }
        return new(items, sources, "", hits.Count, notices, candidates);
    }
}
