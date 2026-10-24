using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal static class ArchiveRecallTool
{
    public static JsonObject Definition() =>
        JsonNode
            .Parse(
                """
                {
                  "type": "function",
                  "name": "recall",
                  "description": "Read archived conversation context or find historical evidence. Use target for known message/block references, text_query for a bounded literal search in one Session without Vector, or vector_query for semantic search. Filters narrow the selected results; they do not search unselected history.",
                  "parameters": {
                    "type": "object",
                    "properties": {
                      "sessionId": {
                        "type": "string",
                        "description": "Session for exact lookup or literal search. Defaults to this Session."
                      },
                      "target": {
                        "type": "string",
                        "description": "What to open: overview (default), blocks, B#126, msg:B#126, or msg#10637-10680. block#126 is also accepted. Message numbers are Archive sequences, not active-history indices. Omit when using text_query or vector_query."
                      },
                      "vector_query": {
                        "type": "string",
                        "description": "Search earlier context by meaning and return matching source messages or block summaries."
                      },
                      "limit": {
                        "type": "number",
                        "description": "Maximum search results. Defaults to 5, up to 20."
                      },
                      "scope": {
                        "type": "string",
                        "enum": [
                          "all",
                          "current-session",
                          "current-agent"
                        ],
                        "description": "Scope for semantic search. Searches stay within this agent; legacy isolated agents are further limited to the current session."
                      },
                      "agentName": {
                        "type": "string",
                        "description": "Agent for semantic search. Only this session's agent is supported."
                      },
                      "previewLength": {
                        "type": "number",
                        "description": "Total character budget for the response. Omit or use 0 for the default; other values are bounded to 1,000-20,000."
                      },
                      "contentFilter": {
                        "type": "string",
                        "description": "Keep retrieved items containing this text, ignoring case, and show the matching area when possible. Omit to read the complete selected context."
                      },
                      "includeRegex": {
                        "type": "string",
                        "description": "Keep retrieved items matching this regular expression, ignoring case."
                      },
                      "excludeRegex": {
                        "type": "string",
                        "description": "Exclude retrieved items matching this regular expression, ignoring case."
                      },
                      "preferBlocks": {
                        "type": "boolean",
                        "description": "Give context-block summaries a small ranking preference in semantic search."
                      },
                      "toolDetail": {
                        "type": "string",
                        "description": "Tool display detail: names (default) summarizes names, counts and errors; snippets adds short excerpts; full expands arguments and results within the response budget.",
                        "enum": [
                          "names",
                          "snippets",
                          "full"
                        ]
                      },
                      "text_query": {
                        "type": "string",
                        "description": "Literal text to find in archived messages of one Session, ignoring case. Reads a bounded range and reports its extent and older continuation. Do not combine with target or vector_query."
                      },
                      "beforeSeq": {
                        "type": "number",
                        "description": "Exclusive Archive message sequence for continuing a text_query into older messages. Omit to search from the newest messages."
                      }
                    },
                    "required": [],
                    "additionalProperties": false
                  },
                  "strict": false,
                  "defaultInject": true
                }
                """
            )!
            .AsObject();

    private const string Help =
        "Supported targets: overview, blocks, B#N or block#N, msg:B#N, msg#N or msg#A-B. Start with a visible block and drill down one layer at a time.";

    private sealed record Target(string Kind, long First = 0, long Last = 0);

    private static long Positive(string raw) =>
        long.TryParse(raw, out var value) && value is > 0 and <= 9007199254740991L
            ? value
            : throw new InvalidDataException("Target IDs must be positive safe integers. " + Help);

    private static Target Parse(JsonNode? value)
    {
        if (value is null)
            return new("overview");
        if (SessionWait.Text(value) is not string raw)
            throw new InvalidDataException("recall target must be a string selector. " + Help);
        var text = SessionGoal.Trim(raw);
        if (
            text.Length == 0
            || text.Equals("overview", StringComparison.OrdinalIgnoreCase)
            || text.Equals("help", StringComparison.OrdinalIgnoreCase)
        )
            return new("overview");
        if (text.Equals("blocks", StringComparison.OrdinalIgnoreCase))
            return new("blocks");
        var block = Regex.Match(
            text,
            @"^(?:(msg)\s*:\s*)?(?:b|block)#(\d+)$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
        );
        if (block.Success)
            return new(
                block.Groups[1].Success ? "raw-block" : "block",
                Positive(block.Groups[2].Value)
            );
        var messages = Regex.Match(
            text,
            @"^msg#(\d+)(?:-(?:msg#|#)?(\d+))?$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
        );
        if (messages.Success)
        {
            var first = Positive(messages.Groups[1].Value);
            var last = messages.Groups[2].Success ? Positive(messages.Groups[2].Value) : first;
            return new("messages", Math.Min(first, last), Math.Max(first, last));
        }
        throw new InvalidDataException($"Could not parse recall target `{text}`. " + Help);
    }

    public static async Task<JsonObject> ExecuteAsync(
        SessionManager manager,
        SessionOwner source,
        JsonObject? args,
        CancellationToken cancellationToken = default
    )
    {
        try
        {
            args ??= new JsonObject();
            var allowed = new[]
            {
                "sessionId",
                "target",
                "vector_query",
                "text_query",
                "beforeSeq",
                "limit",
                "scope",
                "agentName",
                "preferBlocks",
                "previewLength",
                "contentFilter",
                "includeRegex",
                "excludeRegex",
                "toolDetail",
            };
            var unknown = args.Select(item => item.Key)
                .Where(key => !allowed.Contains(key, StringComparer.Ordinal))
                .ToArray();
            if (unknown.Length > 0)
                throw new InvalidDataException(
                    "Unsupported recall arguments: "
                        + string.Join(", ", unknown)
                        + ". Use an exact target, contentFilter and previewLength/toolDetail to inspect selected context. "
                        + Help
                );
            if (args["sessionId"] is not null && SessionWait.Text(args["sessionId"]) is null)
                throw new InvalidDataException("sessionId must be a string.");
            var literalMode = args.ContainsKey("text_query");
            if (literalMode && (args.ContainsKey("target") || args.ContainsKey("vector_query")))
                throw new InvalidDataException(
                    "text_query cannot be combined with target or vector_query."
                );
            if (!literalMode && args.ContainsKey("beforeSeq"))
                throw new InvalidDataException("beforeSeq requires text_query.");
            if (
                literalMode
                && (
                    SessionWait.Text(args["text_query"]) is not string textQuery
                    || ContextPreviewRenderer.NormalizeSearch(textQuery).Length == 0
                )
            )
                throw new InvalidDataException("text_query must be a nonempty literal string.");
            var id = SessionGoal.Trim(SessionWait.Text(args["sessionId"]) ?? source.Id);
            if (id.Length == 0)
                id = source.Id;
            await manager.AuthorizeToolAsync(
                source,
                new("recall", "builtin", "recall", args),
                null,
                cancellationToken
            );
            if (
                SessionWait.Text(args["vector_query"]) is { } semantic
                && SessionGoal.Trim(semantic).Length > 0
            )
            {
                var query = SessionGoal.Trim(semantic);
                var limit = Foxwarm.Vector.VectorRecall.Limit(args["limit"]);
                var scope = manager.ResolveVectorScope(source, args);
                var semanticRenderer = new ContextPreviewRenderer(args, 1000);
                var result = await Foxwarm.Vector.VectorRecall.SearchAsync(
                    manager.Vector,
                    manager.ArchiveReader,
                    query,
                    limit,
                    scope.Options,
                    scope.Scope,
                    scope.SessionId,
                    args,
                    args["preferBlocks"]?.GetValue<bool>() == true,
                    sourceAllowed: sourceId =>
                        manager.VectorCanonicalSourceAllowed(sourceId, scope.Options)
                );
                return Output(
                    semanticRenderer.RenderItems(
                        result.Items,
                        "",
                        matched =>
                            $"Recall {result.SearchLabel} for `{query}` ({scope.Scope}; source archive ranges loaded before preview) - showing {matched} unique source group(s) from {result.HitCount} ranked source group(s).",
                        "No archived source messages or blocks found for this vector_query.",
                        result.Notices,
                        maxItems: limit
                    )
                );
            }
            if (literalMode)
            {
                // Catalog identity and read-only Archive access do not hydrate a
                // target owner. Retained/deleted exact-target expansion stays separate.
                var existing = manager.AuthorizationTarget(id);
                if (existing is null)
                    return Output($"Session `{id}` not found.");
                await manager.AuthorizeToolAsync(
                    source,
                    new("recall", "builtin", "recall", args),
                    null,
                    cancellationToken
                );
                var archive = manager.ArchiveReader(existing.Id);
                if (archive.CanonicalSessionId != existing.Id)
                    throw new InvalidOperationException(
                        "Archive identity changed; retry the lookup."
                    );
                var result = Literal(archive, existing.Id, args, cancellationToken);
                await manager.AuthorizeToolAsync(
                    source,
                    new("recall", "builtin", "recall", args),
                    null,
                    cancellationToken
                );
                var current = manager.AuthorizationTarget(id);
                if (
                    current?.Id != existing.Id
                    || current.Agent != existing.Agent
                    || archive.CanonicalSessionId != existing.Id
                )
                    throw new InvalidOperationException(
                        "Archive identity changed; retry the lookup."
                    );
                return result;
            }
            var owner = await manager.GetExistingAsync(id, cancellationToken);
            if (owner is null)
                return Output($"Session `{id}` not found.");
            await manager.AuthorizeToolAsync(
                source,
                new("recall", "builtin", "recall", args),
                null,
                cancellationToken,
                owner
            );
            var target = Parse(args["target"]);
            var renderer = new ContextPreviewRenderer(args, 1000);
            var reader = new ArchiveContextReader(owner.Archive);
            string Advice(params string[] targets) =>
                "Drill down: "
                + string.Join(
                    "; ",
                    targets.Select(item =>
                        "recall("
                        + EcmaJson.Stringify(
                            new JsonObject { ["sessionId"] = id, ["target"] = item }
                        )
                        + ")"
                    )
                );
            if (target.Kind == "overview")
            {
                var stats = reader.Stats();
                var topology = reader.Topology();
                var frontier = reader.Frontier(topology);
                var levels = string.Join(
                    ", ",
                    topology
                        .GroupBy(row => row.Level)
                        .OrderBy(group => group.Key)
                        .Select(group =>
                            $"L{group.Key}: {group.Count()} (latest B#{group.Max(row => row.Id)})"
                        )
                );
                var range =
                    stats.Count == 0
                        ? "none"
                        : $"msg#{stats.First}-{stats.Last} ({stats.Count} messages)";
                var blocks =
                    topology.Count == 0
                        ? "none"
                        : $"B#{topology.Min(row => row.Id)}-B#{topology.Max(row => row.Id)} ({topology.Count} total; frontier: {frontier.Count}; {levels})";
                return Output(
                    ContextPreviewRenderer.Clip(
                        $"Recall overview for session `{id}`.\n\nAvailable message log: {range}.\nLayered CTX-BLOCK archive: {blocks}.\n\n{Help}\n"
                            + Advice(
                                frontier.Count > 0 ? ["blocks", $"B#{frontier[0].Id}"] : ["blocks"]
                            ),
                        renderer.Budget
                    )
                );
            }
            if (target.Kind == "blocks")
            {
                var frontier = reader.Frontier(reader.Topology());
                var items = frontier
                    .Select(row => reader.Block(row.Id))
                    .OfType<ArchiveBlockRecord>()
                    .Select(block => ArchiveContextReader.BlockItem(block, id))
                    .ToArray();
                return Output(
                    renderer.RenderItems(
                        items,
                        $"Current CTX-BLOCK frontier for session `{id}`, sorted by message range.",
                        matched => $"{matched} of {frontier.Count} top-level blocks.",
                        "No current CTX-BLOCK frontier blocks matched this lookup.",
                        [Advice("overview")]
                    )
                );
            }
            ArchiveBlockRecord? block = null;
            if (target.Kind is "block" or "raw-block")
            {
                block = reader.Block(target.First);
                if (block is null)
                    return Output(
                        ContextPreviewRenderer.Clip(
                            $"No CTX-BLOCK B#{target.First} found in session `{id}`.\n"
                                + Advice("overview", "blocks"),
                            renderer.Budget
                        )
                    );
                if (target.Kind == "raw-block")
                    target = new("messages", block.RawStartSeq, block.RawEndSeq);
            }
            if (target.Kind == "block" && block is not null)
            {
                var own = ArchiveContextReader.BlockItem(block, id);
                var context =
                    $"CTX-BLOCK B#{block.Id} L{block.Level} for session `{id}`. Raw range msg#{block.RawStartSeq}-{block.RawEndSeq}.";
                if (block.SourceKind == "block")
                {
                    var children = reader.Children(block);
                    var max = Math.Max(1, 20000 / renderer.Budget);
                    var shown = children.Take(max).ToArray();
                    var notices = new List<string> { Advice($"msg:B#{block.Id}", "blocks") };
                    if (shown.Length < children.Count)
                        notices.Add(
                            $"Child list capped at {shown.Length} of {children.Count}: count × previewLength exceeds 20000. Open a child B#N or lower previewLength."
                        );
                    var items = new[] { own }
                        .Concat(shown.Select(block => ArchiveContextReader.BlockItem(block, id)))
                        .ToArray();
                    return Output(
                        renderer.RenderItems(
                            items,
                            context,
                            _ => "Block summary and immediate child blocks (source order):",
                            "No block summaries matched the requested filters.",
                            notices
                        )
                    );
                }
                var messages = reader.Messages(block.SourceStart, block.SourceEnd);
                return Output(
                    renderer.RenderItems(
                        new[] { own }
                            .Concat(messages.Select(record => renderer.ArchivedMessage(record, id)))
                            .ToArray(),
                        context,
                        _ => $"Block summary and {messages.Count} source messages:",
                        "No selected context matched the requested filters.",
                        [Advice($"msg:B#{block.Id}", "blocks")]
                    )
                );
            }
            var records = reader.Messages(target.First, target.Last);
            var available = reader.Stats();
            var header =
                $"Archived messages for session `{id}` at msg#{target.First}-{target.Last}.";
            if (block is not null)
                header = $"Messages covered by CTX-BLOCK B#{block.Id}. " + header;
            return Output(
                renderer.RenderItems(
                    records.Select(record => renderer.ArchivedMessage(record, id)).ToArray(),
                    header,
                    matched => $"Showing {matched} of {records.Count} selected messages.",
                    $"No archived messages matched this lookup. Available message log: {(available.Count == 0 ? "none" : $"msg#{available.First}-{available.Last}")}.",
                    [Advice("overview")]
                )
            );
        }
        catch (Foxwarm.Vector.VectorUnavailableException error)
        {
            var result = UnsupportedTurnToolExecutor.ToolError(error.Code, error.Message);
            result["code"] = error.Code;
            if (error.Retryable)
                result["retryable"] = true;
            return result;
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or IOException
                        or ArgumentException
                        or InvalidOperationException
            )
        {
            return UnsupportedTurnToolExecutor.ToolError("recall_error", error.Message);
        }
    }

    private static JsonObject Literal(
        SqliteArchiveMessageStore archive,
        string id,
        JsonObject args,
        CancellationToken token
    )
    {
        var query = ContextPreviewRenderer.NormalizeSearch(SessionWait.Text(args["text_query"])!);
        var limit = Foxwarm.Vector.VectorRecall.Limit(args["limit"]);
        long? before = null;
        if (args.ContainsKey("beforeSeq"))
        {
            if (
                SessionWait.Number(args["beforeSeq"]) is not { } number
                || !double.IsFinite(number)
                || number != Math.Truncate(number)
                || number < 1
                || number > 9007199254740991L
            )
                throw new InvalidDataException("beforeSeq must be a positive safe integer.");
            before = (long)number;
        }
        var options = (JsonObject)args.DeepClone();
        // Reuse the existing match-centered preview, without changing the user's
        // separate page filters or the semantic retrieval/ranking path.
        if (!options.ContainsKey("contentFilter"))
            options["contentFilter"] = query;
        var renderer = new ContextPreviewRenderer(options, 1000);
        // One native effective Archive page bounds message decoding and matching.
        // Stop examination at the hit limit so older hits are reachable next time.
        var candidates = archive.ReadEffectiveMessagesPage(null, before - 1, 100, descending: true);
        var hits = new List<PreviewItem>();
        long? newest = null;
        long? oldest = null;
        var scanned = 0;
        foreach (var record in candidates)
        {
            token.ThrowIfCancellationRequested();
            newest ??= record.Seq;
            oldest = record.Seq;
            scanned++;
            var item = renderer.ArchivedMessage(record, id);
            if (
                !ContextPreviewRenderer
                    .NormalizeSearch(item.Search)
                    .Contains(query, StringComparison.OrdinalIgnoreCase)
            )
                continue;
            hits.Add(item);
            if (hits.Count == limit)
                break;
        }
        var remaining =
            oldest is { } last && archive.ReadEffectiveMessagesPage(null, last - 1, 1).Count > 0;
        var next = (JsonObject)args.DeepClone();
        next["sessionId"] = id;
        next["beforeSeq"] = oldest;
        var continuation = remaining
            ? "Older literal search: recall(" + EcmaJson.Stringify(next) + ")"
            : "No older messages remain in this Session's accessible Archive range.";
        var extent =
            scanned == 0
                ? "No messages examined in the requested range."
                : $"Examined {scanned} archived messages at seq #{oldest}–#{newest} (newest first).";
        return Output(
            renderer.RenderItems(
                hits,
                $"Literal Archive lookup in Session `{id}`. {extent}",
                matched =>
                    $"{matched} matching source record(s) from {hits.Count} literal hit(s) in this bounded range.",
                hits.Count == 0
                    ? "No literal matches in the examined range."
                    : "Literal hits were excluded by the result filters.",
                [continuation]
            )
        );
    }

    private static JsonObject Output(string text) => new() { ["output"] = text };
}
