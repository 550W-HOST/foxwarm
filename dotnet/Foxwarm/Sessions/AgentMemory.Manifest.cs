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
        var root = agents.MemoryDirectory(agent);
        var files = new List<AgentMemoryFile>();
        void Walk(string directory, int depth)
        {
            if (depth > 12 || files.Count >= 2000 || !Directory.Exists(directory))
                return;
            foreach (
                var entry in new DirectoryInfo(directory)
                    .GetFileSystemInfos()
                    .OrderBy(item => item.Name, StringComparer.CurrentCulture)
            )
            {
                if (files.Count >= 2000)
                    break;
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    continue;
                if (entry is DirectoryInfo)
                    Walk(entry.FullName, depth + 1);
                else if (
                    entry is FileInfo file
                    && file.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
                )
                    files.Add(
                        new(
                            Path.GetRelativePath(root, file.FullName)
                                .Replace(Path.DirectorySeparatorChar, '/'),
                            file.FullName,
                            file.Length,
                            (file.LastWriteTimeUtc.Ticks - DateTime.UnixEpoch.Ticks) / 10000.0
                        )
                    );
            }
        }
        Walk(root, 0);
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
        var lastActivity = Catalog.AgentLastActivity();
        var local = LocalProjections();
        var persisted = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200))
        foreach (var row in Catalog.GetMany(chunk))
            persisted[SessionCatalog.Text(row["id"])!] = row;
        foreach (var row in local)
        {
            var current = Metadata(row);
            // A live row can be newer than its persisted catalog entry.
            if (SessionCatalog.Number(row["lastMessageTime"]) is { } time && time > lastActivity.GetValueOrDefault(current.Agent))
                lastActivity[current.Agent] = time;
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
                    agents.ExpandedRuleCount(name),
                    agents.DefaultNode(name),
                    agents.DefaultCwd(name)
                );
            })
            .ToArray();
    }

    internal AgentMemoryManifest AgentManifest(string name) => memory.Manifest(name);

    // Root-first creator ancestry ending with the Agent, or null when it cannot be resolved.
    private JsonNode? CreatorChainOrNull(string name)
    {
        try
        {
            return JsonData.Node(agents.CreatorChainOf(name));
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }

    /// <summary>The installation additions file every Agent's prompt includes after the framework prompt.</summary>
    internal JsonObject PromptSources() =>
        new()
        {
            ["installation"] = new JsonObject
            {
                ["path"] = agents.FrameworkLocalPath,
                ["exists"] = File.Exists(agents.FrameworkLocalPath),
            },
        };

    /// <summary>
    /// The framework prompt text new Sessions receive, filtered for the installation's default
    /// model. Agents have no default model of their own, so the text is the same for every Agent;
    /// a virtual default model (failover, session hash) is followed to its first target.
    /// </summary>
    internal async Task<JsonObject> FrameworkPromptViewAsync(CancellationToken token)
    {
        string? defaultKey = null,
            modelKey = null;
        if (models.All.Count > 0)
        {
            var selected = models.Resolve(null);
            defaultKey = selected.Key;
            var concrete = selected;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (
                concrete.IsVirtual
                && concrete.Targets.Length > 0
                && seen.Add(concrete.Key)
                && models.Contains(concrete.Targets[0])
            )
                concrete = models.Resolve(concrete.Targets[0]);
            modelKey = concrete.IsVirtual ? null : concrete.Key;
        }
        var view = await memory.FrameworkPromptAsync(modelKey ?? "", token);
        return new JsonObject
        {
            ["text"] = view?.Text,
            ["modelDependent"] = view?.ModelDependent ?? false,
            ["model"] = modelKey,
            ["defaultModel"] = defaultKey,
        };
    }

    internal object[] AgentRegistry()
    {
        var counts = Catalog.AgentActivityCounts();
        var lastActivity = Catalog.AgentLastActivity();
        var local = LocalProjections();
        var persisted = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200))
        foreach (var row in Catalog.GetMany(chunk))
            persisted[SessionCatalog.Text(row["id"])!] = row;
        foreach (var row in local)
        {
            var current = Metadata(row);
            // A live row can be newer than its persisted catalog entry.
            if (SessionCatalog.Number(row["lastMessageTime"]) is { } time && time > lastActivity.GetValueOrDefault(current.Agent))
                lastActivity[current.Agent] = time;
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
                var rawRules = agents.MetadataSnapshot()[name]?["rules"];
                var (expandedRules, rulesError) = ExpandedLayer(name, rawRules);
                var row = new JsonObject
                {
                    ["id"] = name,
                    ["inherit"] = AgentInherit(name),
                    ["inheritanceChain"] = JsonData.Node(AgentChain(name)),
                    ["createdBy"] = agents.CreatedBy(name),
                    ["creatorChain"] = CreatorChainOrNull(name),
                    ["rules"] = rawRules?.DeepClone() ?? new JsonArray(),
                    ["expandedRules"] = expandedRules,
                    ["ruleCount"] = expandedRules.Count,
                    ["defaultNode"] = agents.DefaultNode(name),
                    ["defaultCwd"] = agents.DefaultCwd(name),
                    ["inheritable"] = agents.Inheritable(name),
                    ["restricted"] = RestrictedLayer(name, rawRules),
                    ["isolationMigration"] = IsolationMigrationSummary(name),
                    ["sessionCount"] = owned.Total,
                    ["lastActivity"] =
                        lastActivity.GetValueOrDefault(name) is > 0 and var last
                            ? last
                            : (double?)null,
                    ["activeSessionCount"] = owned.Active,
                    ["queuedSessionCount"] = owned.Queued,
                    ["memoryRoot"] = manifest.MemoryRoot,
                    ["memoryFileCount"] = manifest.Files.Count,
                    ["memoryLastModified"] =
                        manifest.Files.Count == 0
                            ? (double?)null
                            : manifest.Files.Max(file => file.ModifiedAt),
                };
                if (rulesError is not null)
                    row["rulesError"] = rulesError;
                return (object)row;
            })
            .ToArray();
    }

    private (JsonArray Rules, string? Error) ExpandedLayer(string name, JsonNode? rawRules)
    {
        if (rawRules is null)
            return (new JsonArray(), null);
        try
        {
            var policy = agents.ResolveCachedRuleLayer(name, rawRules);
            return (policy.PreviewRules, null);
        }
        catch (InvalidDataException error)
        {
            return (new JsonArray(), error.Message);
        }
    }


    // A layer that does not parse fails every call of the Agent, so it is restricted too.
    private bool RestrictedLayer(string name, JsonNode? rules)
    {
        if (rules is null)
            return false;
        try
        {
            var policy = agents.ResolveCachedRuleLayer(name, rules);
            var normalized = policy.Value["rules"] as JsonArray;
            return normalized?.LastOrDefault() is JsonObject last
                && !OperationRules.IsOperationRule(last)
                && last["enabled"]?.GetValue<bool>() == true
                && last["action"]?.GetValue<string>() == "deny"
                && last["match"] is JsonObject { Count: 0 };
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
