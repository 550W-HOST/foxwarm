using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed record VectorSearchOptions(string? Agent = null, string[]? SessionIds = null, IReadOnlyList<ArchiveVectorScope>? LineageSessions = null, string? IncludeRegex = null, string? ExcludeRegex = null, bool PreferBlocks = false);
internal sealed record VectorSearchResult(IReadOnlyList<JsonObject> Hits, JsonObject Lexical);

internal sealed partial class VectorRuntime
{
    internal static double Number(JsonNode? node, double fallback = 0) => SessionWait.Number(node) ?? fallback;
    internal static long Integer(JsonNode? node, long fallback = 0) => (long)Number(node, fallback);
    internal static string Family(JsonObject row)
    {
        var session = Text(row["session_id"]);
        var kind = Text(row["kind"]);
        if (kind is "block" or "fact" && Number(row["block_id"]) is var block && block > 0 && Math.Floor(block) == block)
            return $"{session}:block:{block}";
        if (kind == "raw")
            return $"{session}:raw:{Number(row["start_seq"] ?? row["seq"])}-{Number(row["end_seq"] ?? row["seq"])}";
        return session + ":" + (kind.Length == 0 ? "raw" : kind) + ":" + Text(row["id"] ?? row["message_id"]);
    }
    private static double Distance(JsonObject row) => Number(row["_distance"], double.PositiveInfinity);
    internal static double Overlap(JsonObject a, JsonObject b, bool rawOnly = true)
    {
        if (Text(a["session_id"]) != Text(b["session_id"]) || rawOnly && (Text(a["kind"]) != "raw" || Text(b["kind"]) != "raw"))
            return 0;
        var aStart = Number(a["raw_start_seq"] ?? a["start_seq"] ?? a["seq"]);
        var aEnd = Number(a["raw_end_seq"] ?? a["end_seq"] ?? a["seq"]);
        var bStart = Number(b["raw_start_seq"] ?? b["start_seq"] ?? b["seq"]);
        var bEnd = Number(b["raw_end_seq"] ?? b["end_seq"] ?? b["seq"]);
        return Math.Max(0, Math.Min(aEnd, bEnd) - Math.Max(aStart, bStart) + 1) / Math.Max(1, Math.Min(aEnd - aStart + 1, bEnd - bStart + 1));
    }
    internal static (IReadOnlyList<JsonObject> Selected, int DiverseCount) SelectSources(IEnumerable<JsonObject> rows, int limit, bool preferBlocks)
    {
        var groups = rows.GroupBy(Family).Select(group =>
        {
            var sorted = group.OrderBy(Distance).ThenBy(row => Text(row["id"]), StringComparer.InvariantCulture).ToArray();
            var row = (JsonObject)sorted[0].DeepClone();
            var block = sorted.FirstOrDefault(member => Text(member["kind"]) == "block");
            row["source_family"] = group.Key;
            row["source_group_size"] = sorted.Length;
            row["has_block_source"] = block is not null;
            row["source_timestamp"] = Number(block?["end_timestamp"] ?? block?["start_timestamp"] ?? block?["timestamp"] ?? row["end_timestamp"] ?? row["start_timestamp"] ?? row["timestamp"]);
            row["matched_facts"] = new JsonArray(sorted.Where(member => Text(member["kind"]) == "fact" && Trim(Text(member["text"])).Length > 0)
                .Select(member => new JsonObject { ["text"] = Trim(Text(member["text"])) is var fact && fact.Length > 1000 ? fact[..1000] : fact, ["fact_kind"] = member["fact_kind"]?.DeepClone(), ["attributed_to"] = member["attributed_to"]?.DeepClone(), ["distance"] = Number(member["_distance"]) })
                .OrderBy(member => Number(member["distance"])).ThenBy(member => Text(member["text"]), StringComparer.InvariantCulture).Take(3).Select(member => (JsonNode?)member).ToArray());
            return row;
        }).ToArray();
        var recency = groups.OrderByDescending(row => Number(row["source_timestamp"])).ThenBy(row => Text(row["source_family"]), StringComparer.InvariantCulture)
            .Select((row, rank) => (Family: Text(row["source_family"]), Rank: rank)).ToDictionary(entry => entry.Family, entry => entry.Rank, StringComparer.Ordinal);
        double Tie(JsonObject row) => (row["has_block_source"]?.GetValue<bool>() == true || Text(row["kind"]) == "block" ? preferBlocks ? 4 : 1 : 0)
            + (row["matched_facts"] is JsonArray { Count: > 0 } ? 2 : 0) + 1d / (recency[Text(row["source_family"])] + 2);
        var ranked = groups.OrderBy(row => Math.Floor(Distance(row) * 1_000_000 + .5)).ThenByDescending(Tie).ThenBy(Distance).ThenBy(row => Text(row["source_family"]), StringComparer.InvariantCulture);
        var diverse = new List<JsonObject>();
        var deferred = new List<JsonObject>();
        foreach (var row in ranked)
        {
            if (diverse.Any(existing => Overlap(row, existing) >= .65))
                deferred.Add(row);
            else
                diverse.Add(row);
            if (diverse.Count >= limit)
                return (diverse.Take(limit).ToArray(), limit);
        }
        return (diverse.Concat(deferred).Take(limit).ToArray(), diverse.Count);
    }

    internal static string? Predicate(VectorSearchOptions? options)
    {
        if (options is null)
            return null;
        var clauses = new List<string>();
        if (options.Agent is { Length: > 0 } agent)
            clauses.Add($"agent = '{Escape(agent)}'");
        if (options.LineageSessions is { Count: > 0 } lineage)
        {
            var branches = lineage.Select(entry =>
            {
                var raw = entry.MaxMessageSeq is { } rawCap ? $"(memory_kind = 'raw' AND start_seq <= {rawCap})" : "(memory_kind = 'raw')";
                var block = entry.MaxBlockId is { } blockCap ? $"(memory_kind = 'block' AND block_id <= {blockCap})" : "(memory_kind = 'block')";
                var facts = new List<string>();
                if (entry.MaxBlockId is { } factBlockCap)
                    facts.Add($"(block_id IS NOT NULL AND block_id <= {factBlockCap})");
                if (entry.MaxMessageSeq is { } factRawCap)
                    facts.Add($"(block_id IS NULL AND raw_end_seq <= {factRawCap})");
                var fact = facts.Count == 0 ? "(memory_kind = 'fact')" : "(memory_kind = 'fact' AND (" + string.Join(" OR ", facts) + "))";
                return $"(session_id = '{Escape(entry.SessionId)}' AND ({raw} OR {block} OR {fact}))";
            });
            clauses.Add("(" + string.Join(" OR ", branches) + ")");
        }
        else if (options.SessionIds is { Length: > 0 } ids)
            clauses.Add("(" + string.Join(" OR ", ids.Distinct(StringComparer.Ordinal).Select(id => $"session_id = '{Escape(id)}'")) + ")");
        return clauses.Count == 0 ? null : string.Join(" AND ", clauses);
    }
    private JsonObject? ClipLineage(JsonObject row, VectorSearchOptions? options)
    {
        var scope = options?.LineageSessions?.FirstOrDefault(entry => entry.SessionId == Text(row["session_id"]));
        if (scope is null)
            return row;
        var kind = Text(row["kind"]);
        if (kind == "fact")
        {
            var block = Number(row["block_id"]);
            return block > 0 && Math.Floor(block) == block
                ? scope.MaxBlockId is { } cap && block > cap ? null : row
                : scope.MaxMessageSeq is { } rawCap && Number(row["raw_end_seq"] ?? row["end_seq"] ?? row["seq"]) > rawCap ? null : row;
        }
        if (kind != "raw" || scope.MaxMessageSeq is not { } max)
            return row;
        var first = Integer(row["start_seq"] ?? row["seq"]);
        var last = Integer(row["end_seq"] ?? row["seq"]);
        if (first > max || last <= max)
            return row;
        var records = Archive(scope.SessionId).ReadMessagesRange(first, max).Where(record => Message(record.Message).Length > 0).ToArray();
        if (records.Length == 0)
            return null;
        var text = string.Join("\n\n", records.Select(record => Message(record.Message)));
        row["seq"] = records[0].Seq;
        row["start_seq"] = records[0].Seq;
        row["raw_start_seq"] = records[0].Seq;
        row["end_seq"] = records[^1].Seq;
        row["raw_end_seq"] = records[^1].Seq;
        row["message_count"] = records.Length;
        row["timestamp"] = records[0].Timestamp;
        row["start_timestamp"] = records[0].Timestamp;
        row["end_timestamp"] = records[^1].Timestamp;
        row["text"] = text;
        row["chunk_text"] = Truncate(text);
        return row;
    }
    private static Regex? SearchRegex(string? pattern, string label)
    {
        if (string.IsNullOrEmpty(pattern))
            return null;
        try { return new(pattern, RegexOptions.IgnoreCase | RegexOptions.ECMAScript | RegexOptions.CultureInvariant); }
        catch (ArgumentException error) { throw new InvalidDataException($"Invalid {label}: {error.Message}"); }
    }
    internal async Task<VectorSearchResult> SearchAsync(string query, int limit, VectorSearchOptions? options)
    {
        var vector = await EmbeddingAsync(query, query: true);
        IReadOnlyList<JsonObject> hits;
        using (await operations.EnterAsync())
        {
            var include = SearchRegex(options?.IncludeRegex, "includeRegex");
            var exclude = SearchRegex(options?.ExcludeRegex, "excludeRegex");
            var count = Math.Min(1024, Math.Max(limit * 8, 40) * (include is not null || exclude is not null || options?.PreferBlocks == true ? 2 : 1));
            while (true)
            {
                var fetched = await table.SearchAsync(vector, Predicate(options), count);
                var rows = fetched.Where(row => Text(row["text"]).Length > 0 && Text(row["session_id"]) != "__init__").Select(row =>
                {
                    row["kind"] = SessionWait.Text(row["memory_kind"]) is { Length: > 0 } memoryKind ? memoryKind : "raw";
                    row["seq"] = (row["start_seq"] ?? row["seq"])?.DeepClone();
                    var source = Text(row["source_kind"]);
                    var role = Text(row["role"]).Split(':');
                    row["fact_kind"] = source.StartsWith("memory_fact:", StringComparison.Ordinal) && source[12..] is "decision" or "preference" or "fact" or "convention" or "environment" ? source[12..] : null;
                    row["attributed_to"] = role.Length >= 3 && role[0] == "fact" && role[2] is "user" or "assistant" or "both" ? role[2] : null;
                    return ClipLineage(row, options);
                }).OfType<JsonObject>().Where(row =>
                {
                    var text = Text(row["text"]) + "\n" + Text(row["chunk_text"]);
                    return (include is null || include.IsMatch(text)) && (exclude is null || !exclude.IsMatch(text));
                });
                var selected = SelectSources(rows, limit, options?.PreferBlocks == true);
                hits = selected.Selected;
                if (selected.DiverseCount >= limit || fetched.Count < count || count >= 1024)
                    break;
                count = Math.Min(1024, count * 2);
            }
        }
        var lexical = await Lexical.QueryAsync(query, limit, options);
        var fused = lexical.Hits.Count > 0 ? Fuse(hits, lexical.Hits, limit) : hits;
        lexical.Lexical["used"] = fused.Any(hit => Text(hit["lexical_lane"]) is "identifier" or "prose");
        return new(fused, lexical.Lexical);
    }

    internal static IReadOnlyList<JsonObject> Fuse(IReadOnlyList<JsonObject> dense, IReadOnlyList<JsonObject> lexical, int limit)
    {
        if (lexical.Count == 0)
            return dense.Take(limit).ToArray();
        var families = new Dictionary<string, (JsonObject Hit, int? Dense, int? Lexical, string Lane, double Score)>(StringComparer.Ordinal);
        for (var index = 0; index < dense.Count; index++)
        {
            var row = dense[index];
            families.TryAdd(Text(row["source_family"] ?? row["id"]), ((JsonObject)row.DeepClone(), index, null, "", 0));
        }
        for (var index = 0; index < lexical.Count; index++)
        {
            var row = lexical[index];
            var containing = Text(row["kind"]) == "raw" ? dense.Select((entry, rank) => (Row: entry, Rank: rank))
                .Where(entry => Text(entry.Row["kind"]) == "raw" && Text(entry.Row["session_id"]) == Text(row["session_id"])
                    && Number(entry.Row["raw_start_seq"] ?? entry.Row["start_seq"]) <= Number(row["raw_start_seq"])
                    && Number(entry.Row["raw_end_seq"] ?? entry.Row["end_seq"]) >= Number(row["raw_start_seq"]))
                .OrderBy(entry => Number(entry.Row["raw_end_seq"] ?? entry.Row["end_seq"]) - Number(entry.Row["raw_start_seq"] ?? entry.Row["start_seq"]))
                .ThenBy(entry => entry.Rank).Select(entry => Text(entry.Row["source_family"] ?? entry.Row["id"])).FirstOrDefault() : null;
            var family = containing ?? Text(row["source_family"]);
            var lane = SessionWait.Text(row["lexical_lane"]) ?? "identifier";
            var exists = families.TryGetValue(family, out var entry);
            if (!exists)
                entry = ((JsonObject)row.DeepClone(), null, null, lane, 0);
            if (entry.Lexical is null)
            {
                entry.Lexical = (int)Number(row["lexical_rank"], index);
                entry.Lane = lane;
                entry.Score = Number(row["lexical_score"]);
                if (exists)
                {
                    foreach (var key in new[] { "lexical_score", "lexical_locators" })
                        if (row.TryGetPropertyValue(key, out var value))
                            entry.Hit[key] = value?.DeepClone();
                        else
                            entry.Hit.Remove(key);
                    entry.Hit["lexical_lane"] = lane;
                }
                families[family] = entry;
            }
        }
        var ranked = families.Values.OrderByDescending(entry => (entry.Dense is { } d ? 1000d / (d + 1) : 0)
                + (entry.Lexical is { } l ? (entry.Lane == "prose" ? 350d : 1200d) / (l + 1) : 0) + (entry.Dense is not null && entry.Lexical is not null ? 180 : 0))
            .ThenBy(entry => entry.Dense ?? int.MaxValue).ThenByDescending(entry => entry.Score).ThenBy(entry => Text(entry.Hit["source_family"] ?? entry.Hit["id"]), StringComparer.InvariantCulture).Select(entry => entry.Hit);
        var selected = new List<JsonObject>();
        var deferred = new List<JsonObject>();
        foreach (var row in ranked)
            if (selected.Any(existing => Overlap(row, existing, rawOnly: false) >= .6))
                deferred.Add(row);
            else
                selected.Add(row);
        return selected.Concat(deferred).Take(limit).ToArray();
    }
}
