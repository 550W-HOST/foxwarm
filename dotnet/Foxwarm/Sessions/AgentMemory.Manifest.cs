using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed record AgentMemoryFile(
    string Path,
    string AbsolutePath,
    long Size,
    double ModifiedAt
);

internal sealed record AgentListEntry(
    string Id,
    string? Inherit,
    int SessionCount,
    int ActiveSessionCount,
    int QueuedSessionCount,
    string? CreatedBy,
    int RuleCount,
    string? DefaultNode,
    string? DefaultCwd
);

internal sealed record AgentMemoryManifest(string MemoryRoot, IReadOnlyList<AgentMemoryFile> Files);

internal sealed partial class AgentMemory
{
    internal AgentMemoryManifest Manifest(string agent)
    {
        // Throws when the Agent does not exist.
        var root = agents.MemoryDirectory(agent);
        var files = new List<AgentMemoryFile>();
        void Walk(string directory, int depth)
        {
            if (depth > 12 || files.Count >= 2000)
                return;
            foreach (
                var entry in this.files.List(agent, "memory" + directory)
                    .OrderBy(item => item.Name, StringComparer.CurrentCulture)
            )
            {
                if (files.Count >= 2000)
                    break;
                if (entry.IsLink)
                    continue;
                if (entry.IsDirectory)
                    Walk(directory + "/" + entry.Name, depth + 1);
                else if (entry.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                    files.Add(
                        new(
                            (directory + "/" + entry.Name)[1..],
                            entry.Locator,
                            entry.Length!.Value,
                            (entry.LastWriteUtc!.Value.Ticks - DateTime.UnixEpoch.Ticks) / 10000.0
                        )
                    );
            }
        }
        Walk("", 0);
        var priorities = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["00_SYSTEM.md"] = 0,
            ["MEMORY.md"] = 1,
            ["SOUL.md"] = 2,
            ["USER.md"] = 3,
        };
        return new(
            root,
            files
                .OrderBy(file => file.Path.StartsWith("archive/", StringComparison.Ordinal) ? 1 : 0)
                .ThenBy(file => file.Path.Count(character => character == '/'))
                .ThenBy(file => priorities.GetValueOrDefault(file.Path, 100))
                .ThenBy(file => file.Path, StringComparer.CurrentCulture)
                .ToArray()
        );
    }
}

internal sealed partial class SessionManager
{
    // The model-facing Agent list: Agents that own a listed Session or that an Agent-targeted
    // action might address, with counts of listed Sessions only. The caller's Agent is always
    // listed. Administrator surfaces use AgentListEntries unfiltered.
    internal JsonObject ListAgents(SessionOwner caller)
    {
        var visibility = SessionVisibilityFor(caller);
        var rows = AgentListEntries()
            .Select(row =>
                row with
                {
                    SessionCount = visibility.ListedCount(row.Id, row.SessionCount),
                }
            )
            .Where(row =>
                row.Id == caller.Agent
                || row.SessionCount > 0
                || visibility.AgentAddressable(row.Id)
            )
            .ToArray();
        var agentRows = new JsonArray();
        foreach (var row in rows)
        {
            var agent = new JsonObject
            {
                ["id"] = row.Id,
                ["sessionCount"] = row.SessionCount,
            };
            if (row.Inherit is not null)
                agent["inherit"] = row.Inherit;
            if (row.CreatedBy is not null)
                agent["createdBy"] = row.CreatedBy;
            agent["ruleCount"] = row.RuleCount;
            if (row.DefaultNode is not null)
                agent["defaultNode"] = row.DefaultNode;
            if (row.DefaultCwd is not null)
                agent["defaultCwd"] = row.DefaultCwd;
            agentRows.Add(agent);
        }
        return new JsonObject { ["agents"] = agentRows };
    }

    internal AgentListEntry[] AgentListEntries()
    {
        var counts = Catalog.AgentActivityCounts();
        var local = LocalProjections();
        var persisted = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200))
        foreach (var row in Catalog.GetMany(chunk))
            persisted[SessionCatalog.Text(row["id"])!] = row;
        foreach (var row in local)
        {
            var current = Metadata(row);
            var previous = persisted.GetValueOrDefault(current.Id) is { } old
                ? Metadata(old)
                : null;
            var count = counts.GetValueOrDefault(current.Agent);
            counts[current.Agent] = (
                count.Total + (previous is null ? 1 : 0),
                count.Active + (current.Busy ? 1 : 0) - (previous?.Busy == true ? 1 : 0),
                count.Queued
                    + (current.QueueLength > 0 ? 1 : 0)
                    - (previous?.QueueLength > 0 ? 1 : 0)
            );
        }
        return Agents()
            .Select(name =>
            {
                var owned = counts.GetValueOrDefault(name);
                return new AgentListEntry(
                    name,
                    AgentInherit(name),
                    owned.Total,
                    owned.Active,
                    owned.Queued,
                    agents.CreatedBy(name),
                    (agents.MetadataSnapshot()[name]?["rules"] as JsonArray)?.Count ?? 0,
                    agents.DefaultNode(name),
                    agents.DefaultCwd(name)
                );
            })
            .ToArray();
    }

    internal AgentMemoryManifest AgentManifest(string name) => memory.Manifest(name);

    internal object[] AgentRegistry()
    {
        var counts = Catalog.AgentActivityCounts();
        var local = LocalProjections();
        var persisted = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200))
        foreach (var row in Catalog.GetMany(chunk))
            persisted[SessionCatalog.Text(row["id"])!] = row;
        foreach (var row in local)
        {
            var current = Metadata(row);
            var previous = persisted.GetValueOrDefault(current.Id) is { } old
                ? Metadata(old)
                : null;
            var count = counts.GetValueOrDefault(current.Agent);
            counts[current.Agent] = (
                count.Total + (previous is null ? 1 : 0),
                count.Active + (current.Busy ? 1 : 0) - (previous?.Busy == true ? 1 : 0),
                count.Queued
                    + (current.QueueLength > 0 ? 1 : 0)
                    - (previous?.QueueLength > 0 ? 1 : 0)
            );
        }
        return Agents()
            .Select(name =>
            {
                var manifest = AgentManifest(name);
                var owned = counts.GetValueOrDefault(name);
                return (object)
                    new JsonObject
                    {
                        ["id"] = name,
                        ["inherit"] = AgentInherit(name),
                        ["inheritanceChain"] = JsonData.Node(AgentChain(name)),
                        ["createdBy"] = agents.CreatedBy(name),
                        ["ruleCount"] =
                            (agents.MetadataSnapshot()[name]?["rules"] as JsonArray)?.Count ?? 0,
                        ["defaultNode"] = agents.DefaultNode(name),
                        ["defaultCwd"] = agents.DefaultCwd(name),
                        ["inheritable"] = agents.Inheritable(name),
                        ["restricted"] = RestrictedLayer(
                            agents.MetadataSnapshot()[name]?["rules"] as JsonArray
                        ),
                        ["isolationMigration"] = IsolationMigrationSummary(name),
                        ["sessionCount"] = owned.Total,
                        ["activeSessionCount"] = owned.Active,
                        ["queuedSessionCount"] = owned.Queued,
                        ["memoryRoot"] = manifest.MemoryRoot,
                        ["memoryFileCount"] = manifest.Files.Count,
                        ["memoryLastModified"] =
                            manifest.Files.Count == 0
                                ? (double?)null
                                : manifest.Files.Max(file => file.ModifiedAt),
                    };
            })
            .ToArray();
    }


    // A layer that does not parse fails every call of the Agent, so it is restricted too.
    private static bool RestrictedLayer(JsonArray? rules)
    {
        try
        {
            return IsolationMigrationRules.EndsInDeny(rules);
        }
        catch (InvalidDataException)
        {
            return true;
        }
    }

    // What the legacy isolation migration did to this Agent, for administrators. A layer that
    // denies everything is reported only while it is still the installed one.
    private JsonObject? IsolationMigrationSummary(string name)
    {
        var row = agents.MetadataSnapshot()[name] as JsonObject;
        if (row?["legacyIsolation"] is not JsonObject marker)
            return null;
        var summary = new JsonObject
        {
            ["migratedAt"] = marker["migratedAt"]?.DeepClone(),
            ["automatic"] = marker["automatic"]?.GetValue<bool>() == true,
            ["node"] = marker["node"]?.DeepClone(),
        };
        if (
            SessionWait.Text(marker["failClosed"]) is { } reason
            && row["rules"] is JsonArray rules
            && new IsolationMigrationPlan(rules, [], []).Digest
                == SessionWait.Text(marker["rulesDigest"])
        )
            summary["failClosed"] = reason;
        return summary;
    }
}
