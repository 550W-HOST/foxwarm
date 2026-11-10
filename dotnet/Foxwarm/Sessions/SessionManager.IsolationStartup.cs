using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Legacy isolation migration, R2: before the host accepts work, every Agent still marked
// isolated without a migration marker receives the generated local layer (or a layer that
// denies everything when that is not safe), R1 layers gain the current-Session status limit,
// and Sessions of bound Agents record the bound Node they ran on. Legacy isolation fields stay
// unchanged as the downgrade fence; nothing enforces them any longer.
internal sealed partial class SessionManager
{
    /// <summary>Report of the migration run at the last startup; null before it ran.</summary>
    internal JsonObject? StartupIsolationMigration { get; private set; }

    private async Task MigrateLegacyIsolationCatalogAsync()
    {
        var entries = new JsonArray();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await agents.MigrateMetadataAsync(next =>
        {
            var changed = false;
            foreach (var name in next.Select(pair => pair.Key).Order(StringComparer.Ordinal).ToArray())
            {
                if (next[name] is not JsonObject row)
                    continue;
                JsonObject? entry = null;
                if (row["legacyIsolation"] is JsonObject marker)
                    entry = UpgradeMigratedLayer(name, row, marker);
                else if (IsolatedToolCompatibility.Metadata(row).Isolated)
                    entry = MigrateIsolatedRow(name, row, next, now);
                if (entry is null)
                    continue;
                entries.Add(entry);
                changed = true;
            }
            return changed;
        });
        StartupIsolationMigration = new JsonObject
        {
            ["completedAt"] = now,
            ["agents"] = entries,
            ["placement"] = new JsonArray(),
        };
        foreach (var entry in entries.OfType<JsonObject>())
        {
            var outcome = SessionWait.Text(entry["outcome"]);
            var line =
                $"Legacy isolation migration: agent={SessionWait.Text(entry["agent"])}, outcome={outcome}"
                + (SessionWait.Text(entry["reason"]) is { } reason ? ", reason=" + reason : "");
            MainLog.Diagnostic(line, failure: outcome == "failClosed");
        }
    }

    // Migrates one isolated row in place. Unsafe cases receive a layer that denies everything.
    private JsonObject MigrateIsolatedRow(string name, JsonObject row, JsonObject snapshot, long now)
    {
        var isolation = IsolatedToolCompatibility.Metadata(row);
        var entry = new JsonObject { ["agent"] = name, ["node"] = isolation.RecordedNode };
        string? failure = null;
        IsolationMigrationPlan? plan = null;
        if (row["rules"] is JsonArray { Count: > 0 })
            failure = "The Agent already had local rules; they are kept in the migration marker for a manual merge.";
        else
        {
            try
            {
                _ = agents.NamedRuleLayers(name);
                plan = IsolationMigrationPlanFor(name, isolation);
                if (plan.Blockers.Count > 0)
                    failure = string.Join(" ", plan.Blockers);
            }
            catch (InvalidDataException error)
            {
                failure = error.Message;
            }
        }
        var rules = failure is null ? plan!.Rules : IsolationMigrationRules.FailClosedRules();
        var digest = new IsolationMigrationPlan(rules, [], []).Digest;
        var marker = new JsonObject
        {
            ["node"] = isolation.RecordedNode,
            ["migratedAt"] = now,
            ["generator"] = IsolationMigrationRules.GeneratorVersion,
            ["rulesDigest"] = digest,
            ["automatic"] = true,
        };
        if (failure is not null)
        {
            marker["failClosed"] = failure;
            if (row["rules"] is JsonArray { Count: > 0 } previous)
                marker["previousRules"] = previous.DeepClone();
        }
        row["rules"] = rules.DeepClone();
        var inheritors = agents.Inheritors(name);
        if (inheritors.Length == 0)
            row["inheritable"] = false;
        else
            entry["inheritors"] = Strings(inheritors);
        if (isolation.RecordedNode is { } node && node != "master")
        {
            var existing = SessionWait.Text(row["defaultNode"]);
            if (existing is null)
                row["defaultNode"] = node;
            else if (existing != node)
                entry["defaultNodeConflict"] = existing;
        }
        row["legacyIsolation"] = marker;
        entry["outcome"] = failure is null ? "migrated" : "failClosed";
        if (failure is not null)
            entry["reason"] = failure;
        entry["rulesDigest"] = digest;
        if (CreatorDescendants(name, snapshot) is { Length: > 0 } descendants)
            entry["creatorDescendants"] = Strings(descendants);
        if (plan is not null && failure is null)
            entry["notes"] = new JsonArray(
                plan.Notes.Select(note => (JsonNode?)note.ToJson()).ToArray()
            );
        return entry;
    }

    // An R1 (generator 1) layer relied on the legacy check to keep `session` status on the
    // current Session. Add that limit to its status rules, edited or not.
    private static JsonObject? UpgradeMigratedLayer(string name, JsonObject row, JsonObject marker)
    {
        if (
            marker["generator"] is not JsonValue value
            || !value.TryGetValue<int>(out var generator)
            || generator >= IsolationMigrationRules.GeneratorVersion
            || marker.ContainsKey("failClosed")
        )
            return null;
        var entry = new JsonObject { ["agent"] = name, ["outcome"] = "upgraded" };
        if (row["rules"] is JsonArray rules)
        {
            var unchanged =
                new IsolationMigrationPlan(rules, [], []).Digest
                == SessionWait.Text(marker["rulesDigest"]);
            var count = IsolationMigrationRules.LimitSessionStatusToSelf(rules);
            entry["statusRulesLimited"] = count;
            if (unchanged)
                marker["rulesDigest"] = new IsolationMigrationPlan(rules, [], []).Digest;
            else
                entry["reason"] =
                    count == 0
                        ? "The local rules were edited and no generated session status rule remains; review session status manually."
                        : "The local rules were edited after migration; only the generated session status rules were changed.";
        }
        else
            entry["reason"] = "The Agent has no local rules.";
        marker["generator"] = IsolationMigrationRules.GeneratorVersion;
        return entry;
    }

    // Records the bound Node as the current Node of every Session of a migrated, bound Agent
    // that has none: it ran there through the retired binding fallback. Repeats at each
    // startup until every Session of the Agent succeeded once.
    private async Task MaterializeMigratedPlacementAsync(CancellationToken token = default)
    {
        var placement = new JsonArray();
        var settled = new List<string>();
        foreach (var (name, value) in agents.MetadataSnapshot())
        {
            if (
                value?["legacyIsolation"] is not JsonObject marker
                || SessionWait.Text(marker["node"]) is not { } node
                || node == "master"
                || marker["placementSettled"]?.GetValue<bool>() == true
            )
                continue;
            var result = await MaterializeAgentPlacementAsync(name, node, token);
            result["agent"] = name;
            placement.Add(result);
            if (result["failedSessions"]!.AsArray().Count == 0)
                settled.Add(name);
            else
                MainLog.Diagnostic(
                    $"Legacy isolation migration: agent={name}, sessions without a recorded Node={result["failedSessions"]!.AsArray().Count}",
                    failure: true
                );
        }
        if (settled.Count > 0)
            await agents.MigrateMetadataAsync(next =>
            {
                foreach (var name in settled)
                    if (next[name]?["legacyIsolation"] is JsonObject marker)
                        marker["placementSettled"] = true;
                return true;
            });
        StartupIsolationMigration ??= new JsonObject { ["agents"] = new JsonArray() };
        StartupIsolationMigration["placement"] = placement;
    }

    private async Task<JsonObject> MaterializeAgentPlacementAsync(
        string agent,
        string node,
        CancellationToken token
    )
    {
        var materialized = new JsonArray();
        var review = new JsonArray();
        var failed = new JsonArray();
        foreach (
            var id in Catalog
                .OffsetPage(int.MaxValue, 0, agent: agent)
                .Select(row => SessionCatalog.Text(row["id"]))
                .OfType<string>()
        )
        {
            try
            {
                var owner = await RequiredAsync(id);
                var current = await MaterializeCurrentNodeAsync(owner, node, token);
                if (current is null)
                    materialized.Add((JsonNode?)id);
                else if (current != node)
                    review.Add(new JsonObject { ["sessionId"] = id, ["currentNode"] = current });
            }
            catch (Exception error)
                when (error
                        is InvalidDataException
                            or InvalidOperationException
                            or IOException
                            or AuthorityCommittedException
                            or SessionAuthorityUnavailableException
                )
            {
                failed.Add(
                    new JsonObject { ["sessionId"] = id, ["error"] = MainLog.SafeFailure(error) }
                );
            }
        }
        return new JsonObject
        {
            ["materializedSessions"] = materialized,
            ["placementReview"] = review,
            ["failedSessions"] = failed,
        };
    }
}
