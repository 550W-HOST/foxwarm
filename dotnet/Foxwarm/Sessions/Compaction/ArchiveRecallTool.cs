using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal static class ArchiveRecallTool
{
    public static JsonObject Definition() => JsonNode.Parse("""
        {
          "type": "function",
          "name": "recall",
          "description": "Recover earlier conversation context from archived blocks and messages. Use target to inspect an overview, drill into a context block, or read an exact message range. Filters narrow the selected context; they do not perform semantic search.",
          "parameters": {
            "type": "object",
            "properties": {
              "sessionId": {
                "type": "string",
                "description": "Session for exact context lookup. Defaults to this session."
              },
              "target": {
                "type": "string",
                "description": "What to open: overview (default), blocks, a block such as B#126, its raw messages with msg:B#126, or messages such as msg#10637 or msg#10637-10680. block#126 is also accepted."
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
              "toolDetail": {
                "type": "string",
                "description": "Tool display detail: names (default) shows name, ID, and status; snippets adds short excerpts; full includes arguments and results within the response budget.",
                "enum": [
                  "names",
                  "snippets",
                  "full"
                ]
              }
            },
            "required": [],
            "additionalProperties": false
          },
          "strict": false
        }
        """)!.AsObject();
    private const string Help = "Supported targets: overview, blocks, B#N or block#N, msg:B#N, msg#N or msg#A-B. Start with a visible block and drill down one layer at a time.";
    private sealed record Target(string Kind, long First = 0, long Last = 0);
    private static long Positive(string raw) => long.TryParse(raw, out var value) && value is > 0 and <= 9007199254740991L ? value
        : throw new InvalidDataException("Target IDs must be positive safe integers. " + Help);
    private static Target Parse(JsonNode? value)
    {
        if (value is null) return new("overview");
        if (SessionWait.Text(value) is not string raw) throw new InvalidDataException("recall target must be a string selector. " + Help);
        var text = SessionGoal.Trim(raw);
        if (text.Length == 0 || text.Equals("overview", StringComparison.OrdinalIgnoreCase) || text.Equals("help", StringComparison.OrdinalIgnoreCase)) return new("overview");
        if (text.Equals("blocks", StringComparison.OrdinalIgnoreCase)) return new("blocks");
        var block = Regex.Match(text, @"^(?:(msg)\s*:\s*)?(?:b|block)#(\d+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (block.Success) return new(block.Groups[1].Success ? "raw-block" : "block", Positive(block.Groups[2].Value));
        var messages = Regex.Match(text, @"^msg#(\d+)(?:-(?:msg#|#)?(\d+))?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (messages.Success)
        {
            var first = Positive(messages.Groups[1].Value); var last = messages.Groups[2].Success ? Positive(messages.Groups[2].Value) : first;
            return new("messages", Math.Min(first, last), Math.Max(first, last));
        }
        throw new InvalidDataException($"Could not parse recall target `{text}`. " + Help);
    }
    public static JsonObject Execute(SessionManager manager, SessionOwner source, JsonObject? args)
    {
        try
        {
            args ??= new JsonObject();
            var allowed = new[] { "sessionId", "target", "previewLength", "contentFilter", "includeRegex", "excludeRegex", "toolDetail" };
            var unknown = args.Select(item => item.Key).Where(key => !allowed.Contains(key, StringComparer.Ordinal)).ToArray();
            if (unknown.Length > 0) throw new InvalidDataException("Unsupported recall arguments: " + string.Join(", ", unknown)
                + ". Use an exact target, contentFilter and previewLength/toolDetail to inspect selected context. " + Help);
            if (args["sessionId"] is not null && SessionWait.Text(args["sessionId"]) is null) throw new InvalidDataException("sessionId must be a string.");
            var id = SessionGoal.Trim(SessionWait.Text(args["sessionId"]) ?? source.Id); if (id.Length == 0) id = source.Id;
            var owner = manager.Find(id);
            if (owner is null) return Output($"Session `{id}` not found.");
            var target = Parse(args["target"]); var renderer = new ContextPreviewRenderer(args, 1000);
            var reader = new ArchiveContextReader(owner.Archive);
            string Advice(params string[] targets) => "Drill down: " + string.Join("; ", targets.Select(item => "recall(" + EcmaJson.Stringify(new JsonObject { ["sessionId"] = id, ["target"] = item }) + ")"));
            if (target.Kind == "overview")
            {
                var stats = reader.Stats(); var topology = reader.Topology(); var frontier = reader.Frontier(topology);
                var levels = string.Join(", ", topology.GroupBy(row => row.Level).OrderBy(group => group.Key).Select(group => $"L{group.Key}: {group.Count()} (latest B#{group.Max(row => row.Id)})"));
                var range = stats.Count == 0 ? "none" : $"msg#{stats.First}-{stats.Last} ({stats.Count} messages)";
                var blocks = topology.Count == 0 ? "none" : $"B#{topology.Min(row => row.Id)}-B#{topology.Max(row => row.Id)} ({topology.Count} total; frontier: {frontier.Count}; {levels})";
                return Output(ContextPreviewRenderer.Clip($"Recall overview for session `{id}`.\n\nAvailable message log: {range}.\nLayered CTX-BLOCK archive: {blocks}.\n\n{Help}\n" + Advice(frontier.Count > 0 ? ["blocks", $"B#{frontier[0].Id}"] : ["blocks"]), renderer.Budget));
            }
            if (target.Kind == "blocks")
            {
                var frontier = reader.Frontier(reader.Topology());
                var items = frontier.Select(row => reader.Block(row.Id)).OfType<ArchiveBlockRecord>().Select(ArchiveContextReader.BlockItem).ToArray();
                return Output(renderer.RenderItems(items, $"Current CTX-BLOCK frontier for session `{id}`, sorted by message range.",
                    matched => $"{matched} of {frontier.Count} top-level blocks.", "No current CTX-BLOCK frontier blocks matched this lookup.", [Advice("overview")]));
            }
            ArchiveBlockRecord? block = null;
            if (target.Kind is "block" or "raw-block")
            {
                block = reader.Block(target.First);
                if (block is null) return Output(ContextPreviewRenderer.Clip($"No CTX-BLOCK B#{target.First} found in session `{id}`.\n" + Advice("overview", "blocks"), renderer.Budget));
                if (target.Kind == "raw-block") target = new("messages", block.RawStartSeq, block.RawEndSeq);
            }
            if (target.Kind == "block" && block is not null)
            {
                var own = ArchiveContextReader.BlockItem(block);
                var context = $"CTX-BLOCK B#{block.Id} L{block.Level} for session `{id}`. Raw range msg#{block.RawStartSeq}-{block.RawEndSeq}.";
                if (block.SourceKind == "block")
                {
                    var children = reader.Children(block); var max = Math.Max(1, 20000 / renderer.Budget); var shown = children.Take(max).ToArray();
                    var notices = new List<string> { Advice($"msg:B#{block.Id}", "blocks") };
                    if (shown.Length < children.Count) notices.Add($"Child list capped at {shown.Length} of {children.Count}: count × previewLength exceeds 20000. Open a child B#N or lower previewLength.");
                    var items = new[] { own }.Concat(shown.Select(ArchiveContextReader.BlockItem)).ToArray();
                    return Output(renderer.RenderItems(items, context, _ => "Block summary and immediate child blocks (source order):", "No block summaries matched the requested filters.", notices));
                }
                var messages = reader.Messages(block.SourceStart, block.SourceEnd);
                return Output(renderer.RenderItems(new[] { own }.Concat(messages.Select(renderer.ArchivedMessage)).ToArray(), context,
                    _ => $"Block summary and {messages.Count} source messages:", "No selected context matched the requested filters.", [Advice($"msg:B#{block.Id}", "blocks")]));
            }
            var records = reader.Messages(target.First, target.Last);
            var available = reader.Stats();
            var header = $"Archived messages for session `{id}` at msg#{target.First}-{target.Last}.";
            if (block is not null) header = $"Messages covered by CTX-BLOCK B#{block.Id}. " + header;
            return Output(renderer.RenderItems(records.Select(renderer.ArchivedMessage).ToArray(), header,
                matched => $"Showing {matched} of {records.Count} selected messages.",
                $"No archived messages matched this lookup. Available message log: {(available.Count == 0 ? "none" : $"msg#{available.First}-{available.Last}")}.", [Advice("overview")]));
        }
        catch (Exception error) when (error is InvalidDataException or IOException or ArgumentException or InvalidOperationException)
        { return UnsupportedTurnToolExecutor.ToolError("recall_error", error.Message); }
    }
    private static JsonObject Output(string text) => new() { ["output"] = text };
}
