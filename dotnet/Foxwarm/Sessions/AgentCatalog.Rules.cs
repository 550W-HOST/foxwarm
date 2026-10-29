using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal string? CreatedBy(string name) => Creator(MetadataSnapshot(), name);
    internal string? DefaultNode(string name)
    {
        var value = MetadataSnapshot()[name]?["defaultNode"];
        if (value is null)
            return null;
        var node = SessionWait.Text(value) ?? throw new InvalidDataException("Agent default Node must be a string.");
        ValidateDefaultNode(node);
        return node;
    }

    private static string? Creator(JsonObject snapshot, string name)
    {
        var row = snapshot[name];
        if (row is null)
            return null;
        if (row is not JsonObject metadata)
            throw new InvalidDataException($"Agent '{name}' metadata must be an object.");
        if (metadata["createdBy"] is null)
            return null;
        var parent = SessionWait.Text(metadata["createdBy"])
            ?? throw new InvalidDataException("Agent creator must be a name or null.");
        ValidateName(parent);
        return parent;
    }

    private string[] CreatorChain(string name, JsonObject snapshot)
    {
        var chain = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string? current = name;
        while (current is not null)
        {
            if (!seen.Add(current))
                throw new InvalidDataException("Agent creator ancestry contains a cycle.");
            if (!Exists(current))
                throw new InvalidDataException($"Agent creator '{current}' does not exist.");
            chain.Insert(0, current);
            current = Creator(snapshot, current);
        }
        return chain.ToArray();
    }

    internal ToolAuthorizationPolicy[] RuleLayers(string name)
    {
        lock (stateGate)
        {
            var snapshot = MetadataSnapshot();
            return CreatorChain(name, snapshot)
                .Select(agent => AgentRulePolicy.Parse(
                    snapshot[agent] is JsonObject row && row.ContainsKey("rules")
                        ? row["rules"] : new JsonArray()))
                .ToArray();
        }
    }

    internal void RequireSessionTarget(string caller, string target)
    {
        lock (stateGate)
        {
            var snapshot = MetadataSnapshot();
            _ = CreatorChain(caller, snapshot);
            if (Creator(snapshot, caller) is null)
                return;
            if (!CreatorChain(target, snapshot).Contains(caller, StringComparer.Ordinal))
                throw new ToolAuthorizationDeniedException(
                    "A delegated Agent may create Sessions only in itself or its descendants.");
        }
    }

    private void ValidateCreatorAdmission(string? creator, JsonObject snapshot)
    {
        if (creator is null)
            return;
        var chain = CreatorChain(creator, snapshot);
        var limits = treeLimits();
        if (chain.Length > limits.MaxDepth)
            throw new InvalidDataException("Agent tree depth limit exceeded.");
        if (snapshot.Count(pair => Creator(snapshot, pair.Key) == creator) >= limits.MaxChildren)
            throw new InvalidDataException("Agent direct-child limit exceeded.");
    }

    private void ValidateCreatorInheritance(string name, string? inherit, string? creator = null)
    {
        if (inherit is null)
            return;
        var snapshot = MetadataSnapshot();
        creator ??= Creator(snapshot, name);
        if (creator is not null && !CreatorChain(creator, snapshot).Contains(inherit, StringComparer.Ordinal))
            throw new InvalidDataException("An Agent-created Agent may inherit only from strict creator ancestors.");
    }

    internal async Task SetRulesAsync(string name, JsonArray rules, string? caller = null, Func<Task>? authorize = null)
    {
        _ = AgentRulePolicy.Parse(rules);
        await createGate.WaitAsync();
        try
        {
            if (!Exists(name))
                throw new InvalidDataException("Agent not found.");
            var next = MetadataSnapshot();
            if (authorize is not null)
                await authorize();
            if (caller is not null && (caller == name || !CreatorChain(name, next).Contains(caller, StringComparer.Ordinal)))
                throw new ToolAuthorizationDeniedException("Only strict creator ancestors may replace an Agent's rules.");
            var row = next[name] as JsonObject ?? new JsonObject();
            next[name] = row;
            row["rules"] = rules.DeepClone();
            try
            {
                AtomicIndexWrite(indexPath, Payload(List().Where(id => id != "main"), next).ToJsonString());
            }
            catch (AuthorityCommittedException)
            {
                lock (stateGate)
                    metadata = next;
                throw;
            }
            lock (stateGate)
                metadata = next;
        }
        finally
        {
            createGate.Release();
        }
    }

    internal async Task SetDefaultNodeAsync(string name, string? node)
    {
        ValidateDefaultNode(node);
        await createGate.WaitAsync();
        try
        {
            if (!Exists(name))
                throw new InvalidDataException("Agent not found.");
            var next = MetadataSnapshot();
            var row = next[name] as JsonObject ?? new JsonObject();
            next[name] = row;
            if (node is null)
                row.Remove("defaultNode");
            else
                row["defaultNode"] = node;
            try
            {
                AtomicIndexWrite(indexPath, Payload(List().Where(id => id != "main"), next).ToJsonString());
            }
            catch (AuthorityCommittedException)
            {
                lock (stateGate)
                    metadata = next;
                throw;
            }
            lock (stateGate)
                metadata = next;
        }
        finally
        {
            createGate.Release();
        }
    }

    private static void ValidateDefaultNode(string? node)
    {
        if (node is not null)
            Foxwarm.Nodes.NodeProviderRegistry.ValidateId(node);
    }

    private void RequireNoCreatorChildren(string name)
    {
        var snapshot = MetadataSnapshot();
        if (snapshot.Any(pair => Creator(snapshot, pair.Key) == name))
            throw new InvalidDataException($"Agent '{name}' has creator descendants. Delete them first.");
    }
}
