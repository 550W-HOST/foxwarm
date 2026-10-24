using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionListQueries
{
    private static void AdjustSummary(
        JsonObject summary,
        JsonObject[] live,
        JsonObject[] persisted,
        long costCount
    )
    {
        var byId = persisted.ToDictionary(Id, StringComparer.Ordinal);
        foreach (var row in live)
        {
            if (!byId.TryGetValue(Id(row), out var old))
                continue;
            var cost = SessionCatalog.Number(row["tokenUsage"]?["cost"]);
            var oldCost = SessionCatalog.Number(old["stats"]?["totalCost"]);
            costCount += (cost.HasValue ? 1 : 0) - (oldCost.HasValue ? 1 : 0);
            summary["cost"] =
                (SessionCatalog.Number(summary["cost"]) ?? 0) + ((cost ?? 0) - (oldCost ?? 0));
            void Add(string key, double difference) =>
                summary[key] = (SessionCatalog.Number(summary[key]) ?? 0) + difference;
            Add(
                "busy",
                (SessionCatalog.Flag(row["busy"]) ? 1 : 0)
                    - (SessionCatalog.Flag(old["busy"]) ? 1 : 0)
            );
            Add(
                "queued",
                (SessionCatalog.Number(row["queueLength"]) > 0 ? 1 : 0)
                    - (SessionCatalog.Number(old["queueLength"]) > 0 ? 1 : 0)
            );
            foreach (
                var (key, oldKey) in new[]
                {
                    ("cachedTokens", "totalCachedTokens"),
                    ("inputTokens", "totalInputTokens"),
                    ("outputTokens", "totalOutputTokens"),
                }
            )
                Add(
                    key,
                    (SessionCatalog.Number(row["tokenUsage"]?[key]) ?? 0)
                        - (SessionCatalog.Number(old["stats"]?[oldKey]) ?? 0)
                );
        }
        if (costCount == 0)
            summary.Remove("cost");
    }

    private JsonObject[] Persisted(string[] ids) =>
        ids.Chunk(200).SelectMany(chunk => Catalog.GetMany(chunk)).ToArray();

    public JsonObject GlobalSummary()
    {
        var summary = Catalog.Summary(out var costCount);
        var local = runtime.LocalProjections();
        var live = runtime.Projections(local.Select(Id).ToArray());
        AdjustSummary(summary, live, Persisted(live.Select(Id).ToArray()), costCount);
        return summary;
    }

    public JsonArray AgentCounts() => Catalog.AgentCounts();

    public Dictionary<string, int> DescendantActivity(string[] ids)
    {
        var local = runtime.LocalProjections();
        var busy = local.Where(row => SessionCatalog.Flag(row["busy"])).Select(Id).ToArray();
        // Every busy Main-local owner is maintained in the visible overlay; no owner scan.
        return Catalog.BusyDescendants(ids.Distinct(StringComparer.Ordinal).ToArray(), busy);
    }

    public JsonObject Descendants(string requested, int limit)
    {
        var resolution = Catalog.Resolve(requested);
        var kind = SessionCatalog.Text(resolution["kind"]);
        if (kind == "missing")
            throw new SessionListQueryException("SESSION_NOT_FOUND", "Session not found.");
        if (kind == "ambiguous")
            throw new SessionListQueryException(
                "SESSION_ALIAS_AMBIGUOUS",
                "Session alias is ambiguous."
            );
        var id = SessionCatalog.Text(resolution["sessionId"])!;
        var baseRows = Catalog.Descendants(id, limit);
        var projections = runtime.Projections(baseRows.Rows.Select(Id).ToArray(), true);
        var descendants = Catalog.FilterDescendants(id, projections.Select(Id).ToArray());
        AdjustSummary(
            baseRows.Summary,
            projections.Where(row => descendants.Contains(Id(row))).ToArray(),
            Persisted(descendants.ToArray()),
            baseRows.CostCount
        );
        var previewIds = baseRows.Rows.Select(Id).ToHashSet(StringComparer.Ordinal);
        var result = baseRows.Summary;
        result["version"] = 1;
        result["sessionId"] = id;
        result["previewOnly"] = true;
        result["sessions"] = Array(projections.Where(row => previewIds.Contains(Id(row))));
        return result;
    }

    public JsonObject Search(string query, int limit)
    {
        // Source-defined explicit search is a metadata candidate scan, not a typed root-page seek.
        var term = SourceStringLower.Lower(query);
        var candidates = runtime.ListSessions();
        var matches = candidates
            .Where(row =>
                new[]
                {
                    "displayName",
                    "id",
                    "agent",
                    "currentNode",
                    "cwd",
                    "model",
                    "modelKey",
                    "defaultModelKey",
                    "childModelDefault",
                    "effectiveChildModelKey",
                }
                    .Select(key => SessionCatalog.Text(row[key]))
                    .Concat((row["aliases"] as JsonArray ?? []).Select(SessionCatalog.Text))
                    .OfType<string>()
                    .Any(text =>
                        SessionCatalog.Trim(text).Length > 0
                        && SourceStringLower.Lower(text).Contains(term, StringComparison.Ordinal)
                    )
            )
            .ToArray();
        return new JsonObject
        {
            ["version"] = 1,
            ["query"] = query,
            ["sessions"] = Array(matches.Take(limit)),
            ["hasMore"] = matches.Length > limit,
            ["candidateCount"] = candidates.Length,
        };
    }
}
