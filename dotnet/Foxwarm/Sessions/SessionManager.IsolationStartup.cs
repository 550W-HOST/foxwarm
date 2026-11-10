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
                    entry = ReconcileMigratedRow(name, row, marker, next, now);
                else if (IsolatedToolCompatibility.Metadata(row).Isolated)
                    entry = MigrateIsolatedRow(name, row, next, now);
                if (entry is null)
                    continue;
                entries.Add(entry);
                changed = true;
            }
            return changed;
        });
        // A layer that does not parse fails only its own Agent's calls, as before; report it.
        foreach (var (name, value) in agents.MetadataSnapshot())
        {
            if (value?["rules"] is not JsonArray rules)
                continue;
            try
            {
                _ = AgentRulePolicy.Parse(rules);
            }
            catch (InvalidDataException error)
            {
                entries.Add(
                    new JsonObject
                    {
                        ["agent"] = name,
                        ["outcome"] = "unreadableRules",
                        ["reason"] = error.Message,
                    }
                );
            }
        }
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
            MainLog.Diagnostic(
                line,
                failure: outcome is "failClosed" or "unreadableRules" or "fenceCleared"
            );
        }
    }

    // Brings an already migrated row in line with its legacy fence. Older releases still
    // write that fence and the rules, so after a downgrade and upgrade the Agent must not end
    // up less restricted than the fence it last had. The fence is the legacy `isolated`,
    // `isolatedNode` and `toolRules`; its digest is recorded whenever a layer is accepted.
    private JsonObject? ReconcileMigratedRow(
        string name,
        JsonObject row,
        JsonObject marker,
        JsonObject snapshot,
        long now
    )
    {
        // A layer that does not parse already fails every call of the Agent. Leave the row
        // unchanged; the scan after the write reports it.
        if (row["rules"] is JsonArray stored && !Parses(stored))
            return null;
        var isolation = IsolatedToolCompatibility.Metadata(row);
        if (!isolation.Isolated)
        {
            if (marker.ContainsKey("fenceCleared"))
                return null;
            marker["fenceCleared"] = now;
            return new JsonObject
            {
                ["agent"] = name,
                ["outcome"] = "fenceCleared",
                ["reason"] =
                    "An older release turned legacy isolation off after migration; the local rules are kept.",
            };
        }
        var fence = IsolationMigrationRules.FenceDigest(row);
        var original = (row["rules"] as JsonArray)?.DeepClone().AsArray();
        var digest = original is null ? null : IsolationMigrationRules.Digest(original);
        var generated = digest is not null && digest == SessionWait.Text(marker["rulesDigest"]);
        var confirmed =
            digest is not null && digest == SessionWait.Text(marker["confirmedDigest"]);
        var failClosed = marker.ContainsKey("failClosed");
        var markerNode = SessionWait.Text(marker["node"]);
        var nodeChanged = isolation.RecordedNode != markerNode;
        // Markers written before the fence digest can only show a Node change.
        var fenceChanged = SessionWait.Text(marker["fenceDigest"]) is { } recorded
            ? recorded != fence
            : nodeChanged;

        if (generated && !failClosed)
        {
            // An unedited generated layer always follows the current fence.
            var entry = UpgradeMigratedLayer(name, row, marker);
            var (plan, failure) = PlanFor(name, isolation);
            if (failure is not null)
                return FailClosedMigratedRow(name, row, marker, failure, markerNode, isolation, fence);
            var current = row["rules"] as JsonArray;
            if (current is not null && IsolationMigrationRules.Digest(current) == plan!.Digest)
            {
                if (entry is not null)
                    marker["fenceDigest"] = fence;
                return entry;
            }
            row["rules"] = plan.Rules.DeepClone();
            if (nodeChanged)
                RebindMarker(row, marker, markerNode, isolation.RecordedNode);
            marker["rulesDigest"] = plan.Digest;
            marker["generator"] = IsolationMigrationRules.GeneratorVersion;
            marker["fenceDigest"] = fence;
            marker.Remove("confirmedDigest");
            var regenerated = new JsonObject
            {
                ["agent"] = name,
                ["outcome"] = nodeChanged ? "rebound" : "regenerated",
                ["node"] = isolation.RecordedNode,
                ["rulesDigest"] = plan.Digest,
            };
            if (nodeChanged)
                regenerated["previousNode"] = markerNode;
            else
                regenerated["reason"] =
                    "An older release changed the Agent's legacy tool rules after migration; the layer was generated again from them.";
            return regenerated;
        }

        if (fenceChanged)
            return FailClosedMigratedRow(
                name,
                row,
                marker,
                failClosed && generated ? SessionWait.Text(marker["failClosed"])!
                : nodeChanged
                    ? "An older release changed the Agent's Node binding after migration, and its local rules had been edited; they are kept in the migration marker for a manual merge."
                : "An older release changed the Agent's legacy isolation settings after migration, and its local rules had been edited; they are kept in the migration marker for a manual merge.",
                markerNode,
                isolation,
                fence
            );
        if (generated || confirmed)
            return null;

        // Edited outside this release (an older release, or by hand). A layer of the Agent's
        // own that still ends in an enabled, unconditional deny is the administrator's; one
        // that does not is not trusted while the legacy fence still says isolated.
        var upgraded = failClosed ? null : UpgradeMigratedLayer(name, row, marker);
        if (!OwnLayerRestricts(row["rules"] as JsonArray))
            return FailClosedMigratedRow(
                name,
                row,
                marker,
                "The local rules no longer restrict this Agent; they are kept in the migration marker for a manual merge.",
                markerNode,
                isolation,
                fence,
                original
            );
        marker["confirmedDigest"] = IsolationMigrationRules.Digest(row["rules"]!.AsArray());
        marker["fenceDigest"] = fence;
        return upgraded
            ?? new JsonObject
            {
                ["agent"] = name,
                ["outcome"] = "edited",
                ["reason"] =
                    "The local rules were edited outside this release; they still end in a deny and are kept.",
            };
    }

    private static bool Parses(JsonArray rules)
    {
        try
        {
            _ = AgentRulePolicy.Parse(rules);
            return true;
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    // Whether the Agent's own layer ends in an enabled deny without selectors. A creator's
    // layer does not count: its allows can still reach the Agent.
    private static bool OwnLayerRestricts(JsonArray? rules)
    {
        try
        {
            return IsolationMigrationRules.EndsInDeny(rules);
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private static void RebindMarker(
        JsonObject row,
        JsonObject marker,
        string? previousNode,
        string? node
    )
    {
        marker["node"] = node;
        marker.Remove("placementSettled");
        if (SessionWait.Text(row["defaultNode"]) == previousNode)
        {
            if (node is null or "master")
                row.Remove("defaultNode");
            else
                row["defaultNode"] = node;
        }
    }

    private JsonObject FailClosedMigratedRow(
        string name,
        JsonObject row,
        JsonObject marker,
        string reason,
        string? markerNode,
        AgentIsolation isolation,
        string fence,
        JsonArray? previous = null
    )
    {
        previous ??= row["rules"] as JsonArray;
        marker["fenceDigest"] = fence;
        var rules = IsolationMigrationRules.FailClosedRules();
        var digest = IsolationMigrationRules.Digest(rules);
        if (
            previous is { Count: > 0 }
            && IsolationMigrationRules.Digest(previous) != digest
        )
            marker["previousRules"] = previous.DeepClone();
        row["rules"] = rules;
        if (isolation.RecordedNode != markerNode)
            RebindMarker(row, marker, markerNode, isolation.RecordedNode);
        marker["rulesDigest"] = digest;
        marker["generator"] = IsolationMigrationRules.GeneratorVersion;
        marker["failClosed"] = reason;
        marker.Remove("confirmedDigest");
        return new JsonObject
        {
            ["agent"] = name,
            ["outcome"] = "failClosed",
            ["reason"] = reason,
            ["node"] = isolation.RecordedNode,
            ["rulesDigest"] = digest,
        };
    }

    private (IsolationMigrationPlan? Plan, string? Failure) PlanFor(
        string name,
        AgentIsolation isolation
    )
    {
        try
        {
            _ = agents.NamedRuleLayers(name);
            var plan = IsolationMigrationPlanFor(name, isolation);
            return plan.Blockers.Count > 0 ? (null, string.Join(" ", plan.Blockers)) : (plan, null);
        }
        catch (InvalidDataException error)
        {
            return (null, error.Message);
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
            (plan, failure) = PlanFor(name, isolation);
        var rules = failure is null ? plan!.Rules : IsolationMigrationRules.FailClosedRules();
        var digest = new IsolationMigrationPlan(rules, [], []).Digest;
        var marker = new JsonObject
        {
            ["node"] = isolation.RecordedNode,
            ["migratedAt"] = now,
            ["generator"] = IsolationMigrationRules.GeneratorVersion,
            ["rulesDigest"] = digest,
            ["automatic"] = true,
            ["fenceDigest"] = IsolationMigrationRules.FenceDigest(row),
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
