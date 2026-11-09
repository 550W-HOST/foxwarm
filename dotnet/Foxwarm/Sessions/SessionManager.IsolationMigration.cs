using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Legacy isolation migration (R1): a read-only inventory and an explicit per-Agent apply.
// Applying installs the generated local layer while legacy isolation stays enforced; the
// legacy fields remain as the downgrade fence. Nothing here disables legacy isolation.
internal sealed partial class SessionManager
{
    private static readonly string[] TimerReportFields =
    [
        "id",
        "sessionId",
        "mode",
        "newSession",
        "agentName",
        "sessionPrefix",
        "cron",
        "at",
        "paused",
    ];

    private bool RetainedMainLayout(string agent) =>
        agent == "main"
        && Path.GetFullPath(agents.AgentDirectory(agent)) == Path.GetFullPath(toolWorkspace);

    internal IsolationMigrationPlan IsolationMigrationPlanFor(
        string agent,
        AgentIsolation isolation
    ) => IsolationMigrationRules.Generate(agent, isolation, RetainedMainLayout(agent));

    /// <summary>
    /// Read-only report of every isolated or migrated Agent (or one named Agent): its legacy
    /// state, dependants, Session placement, timers, global rules naming it and the
    /// candidate local layer. It never hydrates Sessions or changes state.
    /// </summary>
    internal JsonObject IsolationMigrationInventory(string? agent = null)
    {
        var snapshot = agents.MetadataSnapshot();
        string[] names;
        if (agent is not null)
        {
            if (!agents.Exists(agent))
                throw new InvalidDataException("Agent not found.");
            names = [agent];
        }
        else
            names = Agents()
                .Where(name =>
                    snapshot[name] is JsonObject row
                    && (SessionCatalog.Flag(row["isolated"]) || row.ContainsKey("legacyIsolation"))
                )
                .Order(StringComparer.Ordinal)
                .ToArray();
        ToolAuthorizationPolicy? global = null;
        string? policyError = null;
        try
        {
            global = authorization.Load();
        }
        catch (Exception error) when (error is InvalidDataException or IOException)
        {
            policyError = error.Message;
        }
        int? minimum = null;
        try
        {
            minimum = AgentCatalog.MinimumReaderVersion(agents.InstallationPath);
        }
        catch (Exception error) when (error is InvalidDataException or IOException) { }
        var result = new JsonObject
        {
            ["readerVersion"] = AgentCatalog.ReaderVersion,
            ["minimumReaderVersion"] = minimum,
            ["agents"] = new JsonArray(
                names
                    .Select(name => (JsonNode?)AgentMigrationReport(name, snapshot, global))
                    .ToArray()
            ),
            ["channelGuests"] = ChannelGuestReport(),
        };
        if (policyError is not null)
            result["policyError"] = policyError;
        return result;
    }

    private JsonObject AgentMigrationReport(
        string name,
        JsonObject snapshot,
        ToolAuthorizationPolicy? global
    )
    {
        var row = snapshot[name] as JsonObject ?? new JsonObject();
        var report = new JsonObject { ["agent"] = name };
        AgentIsolation isolation;
        try
        {
            isolation = IsolatedToolCompatibility.Metadata(row);
        }
        catch (InvalidDataException error)
        {
            report["error"] = error.Message;
            report["applicable"] = false;
            return report;
        }
        var node = isolation.RecordedNode;
        var expectedNode = node ?? "master";
        report["isolated"] = isolation.Isolated;
        report["node"] = node;
        report["toolRuleCount"] = isolation.Rules.Count;
        report["localRuleCount"] = (row["rules"] as JsonArray)?.Count ?? 0;
        report["createdBy"] = row["createdBy"]?.DeepClone();
        report["defaultNode"] = row["defaultNode"]?.DeepClone();
        report["inheritable"] = AgentCatalog.Inheritable(row);
        report["inheritors"] = Strings(agents.Inheritors(name));
        report["creatorDescendants"] = Strings(
            Agents()
                .Where(other => other != name && CreatorChainContains(snapshot, other, name))
                .Order(StringComparer.Ordinal)
        );
        report["retainedMainLayout"] = RetainedMainLayout(name);
        if (row["legacyIsolation"] is JsonObject marker)
            report["migrated"] = marker.DeepClone();

        var sessions = Catalog.OffsetPage(int.MaxValue, 0, agent: name);
        var sessionIds = sessions
            .Select(session => SessionCatalog.Text(session["id"]))
            .OfType<string>()
            .ToHashSet(StringComparer.Ordinal);
        report["sessionCount"] = sessionIds.Count;
        // The catalog shows an unset currentNode as master; apply checks the authority.
        report["placementReview"] = new JsonArray(
            sessions
                .Where(session =>
                    (SessionCatalog.Text(session["currentNode"]) ?? "master") != expectedNode
                )
                .Select(session =>
                    (JsonNode?)
                        new JsonObject
                        {
                            ["sessionId"] = session["id"]?.DeepClone(),
                            ["currentNode"] = session["currentNode"]?.DeepClone(),
                        }
                )
                .ToArray()
        );
        try
        {
            report["timers"] = new JsonArray(
                timers
                    .ListAll(sessionIds.Contains)
                    .OfType<JsonObject>()
                    .Select(timer =>
                    {
                        var view = new JsonObject();
                        foreach (var field in TimerReportFields)
                            if (timer.ContainsKey(field))
                                view[field] = timer[field]?.DeepClone();
                        return (JsonNode?)view;
                    })
                    .ToArray()
            );
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException)
        {
            report["timersError"] = error.Message;
        }
        if (global is not null)
            report["globalRules"] = Strings(GlobalRulesNaming(global, name));

        var blockers = new List<string>();
        if (row.ContainsKey("legacyIsolation"))
            blockers.Add("Agent isolation is already migrated.");
        if (row["rules"] is JsonArray { Count: > 0 })
            blockers.Add("Agent already has local rules; merge the generated layer manually.");
        if (agents.Inheritors(name) is { Length: > 0 } inheritors)
            blockers.Add(
                $"Agent '{name}' is inherited by {string.Join(", ", inheritors)}; change their inheritance first."
            );
        if (!row.ContainsKey("legacyIsolation"))
        {
            try
            {
                var plan = IsolationMigrationPlanFor(name, isolation);
                blockers.AddRange(plan.Blockers);
                report["candidate"] = new JsonObject
                {
                    ["rules"] = plan.Rules.DeepClone(),
                    ["rulesDigest"] = plan.Digest,
                    ["notes"] = new JsonArray(
                        plan.Notes.Select(note => (JsonNode?)note.ToJson()).ToArray()
                    ),
                };
            }
            catch (InvalidDataException error)
            {
                blockers.Add(error.Message);
            }
        }
        if (
            node is not null
            && SessionWait.Text(row["defaultNode"]) is { } existing
            && existing != node
        )
            report["defaultNodeConflict"] = existing;
        report["blockers"] = Strings(blockers);
        report["applicable"] = blockers.Count == 0;
        return report;
    }

    private static bool CreatorChainContains(JsonObject snapshot, string agent, string ancestor)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var current = agent;
        while (
            snapshot[current] is JsonObject row
            && SessionWait.Text(row["createdBy"]) is { } creator
            && seen.Add(creator)
        )
        {
            if (creator == ancestor)
                return true;
            current = creator;
        }
        return false;
    }

    private static IEnumerable<string> GlobalRulesNaming(
        ToolAuthorizationPolicy policy,
        string agent
    )
    {
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var selector = rule["match"]?["agent"];
            var names = selector is JsonArray list
                ? list.Select(SessionWait.Text)
                : new[] { SessionWait.Text(selector) };
            if (names.Contains(agent, StringComparer.Ordinal))
                yield return SessionWait.Text(rule["id"]) ?? "";
        }
    }

    private JsonArray ChannelGuestReport()
    {
        var result = new JsonArray();
        JsonObject? channels;
        try
        {
            channels = models.ConfigurationOwner?.CurrentChannels();
        }
        catch (Exception error) when (error is InvalidDataException or IOException)
        {
            return result;
        }
        foreach (var (instance, value) in channels ?? new JsonObject())
            if (value?["guestAgent"] is JsonObject guest)
                result.Add(
                    new JsonObject
                    {
                        ["instance"] = instance,
                        ["agentId"] = guest["agentId"]?.DeepClone(),
                        ["mode"] = guest["mode"]?.DeepClone(),
                        ["isolated"] = guest["isolated"]?.GetValue<bool>() != false,
                        ["node"] = guest["node"]?.DeepClone(),
                    }
                );
        return result;
    }

    private static JsonArray Strings(IEnumerable<string> values) =>
        new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());

    /// <summary>
    /// Applies the generated migration to one isolated Agent, then records the bound Node
    /// as the current Node of its Sessions that have none. Legacy isolation stays enforced.
    /// </summary>
    internal async Task<JsonObject> ApplyIsolationMigrationAsync(
        string agent,
        CancellationToken token = default
    )
    {
        IsolationMigrationPlan? applied = null;
        var conflict = await agents.ApplyIsolationMigrationAsync(
            agent,
            isolation => applied = IsolationMigrationPlanFor(agent, isolation),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        );
        var node = RecordedIsolationNode(agent);
        var materialized = new JsonArray();
        var review = new JsonArray();
        var failed = new JsonArray();
        if (node is not null)
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
                        materialized.Add(id);
                    else if (current != node)
                        review.Add(
                            new JsonObject { ["sessionId"] = id, ["currentNode"] = current }
                        );
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or InvalidOperationException
                                or IOException
                                or AuthorityCommittedException
                    )
                {
                    failed.Add(new JsonObject { ["sessionId"] = id, ["error"] = error.Message });
                }
            }
        var result = new JsonObject
        {
            ["agent"] = agent,
            ["applied"] = true,
            ["ruleCount"] = applied!.Rules.Count,
            ["rulesDigest"] = applied.Digest,
            ["notes"] = new JsonArray(
                applied.Notes.Select(note => (JsonNode?)note.ToJson()).ToArray()
            ),
            ["materializedSessions"] = materialized,
            ["placementReview"] = review,
            ["failedSessions"] = failed,
        };
        if (conflict is not null)
            result["defaultNodeConflict"] = conflict;
        return result;
    }

    // Returns the Session's existing currentNode, or null after recording `node` for a
    // Session that had none (it already executed there through the binding fallback).
    private async Task<string?> MaterializeCurrentNodeAsync(
        SessionOwner owner,
        string node,
        CancellationToken token
    )
    {
        await WaitForIdentityMutationAsync(owner.Id, token);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Session owner changed during migration.");
        var current = owner.Entry.WithState(state =>
            SessionWait.Text(state.AuthorityEnvelope["currentNode"])
        );
        if (!string.IsNullOrWhiteSpace(current))
            return current;
        await owner.Entry.SaveLane.CommitNodeAsync(node, clearCwd: false);
        return null;
    }
}
