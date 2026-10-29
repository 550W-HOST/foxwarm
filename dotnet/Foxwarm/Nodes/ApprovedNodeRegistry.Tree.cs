using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class ApprovedNodeRegistry
{
    // Native admission, provider effects and administration share this existing registry owner.
    // The data lock remains short-lived; no monitor is held while a provider process runs.
    private readonly SemaphoreSlim mutations = new(1, 1);
    private Func<(int MaxDepth, int MaxChildren)> treeLimits = () => (16, 256);
    private Dictionary<string, string?> providerParents = new(StringComparer.Ordinal);

    internal sealed class Mutation(ApprovedNodeRegistry owner) : IDisposable
    {
        private ApprovedNodeRegistry? current = owner;

        internal void Require(ApprovedNodeRegistry expected)
        {
            if (!ReferenceEquals(current, expected))
                throw new InvalidOperationException("Node mutation scope is no longer active.");
        }

        public void Dispose() => Interlocked.Exchange(ref current, null)?.mutations.Release();
    }

    internal Mutation BeginMutation()
    {
        mutations.Wait();
        return new(this);
    }

    internal async Task<Mutation> BeginMutationAsync(CancellationToken token)
    {
        await mutations.WaitAsync(token);
        return new(this);
    }

    private Mutation? TryBeginMutation() => mutations.Wait(0) ? new(this) : null;

    internal void ConfigureLimits(Func<(int MaxDepth, int MaxChildren)> limits) =>
        treeLimits = limits;

    private static JsonObject ProviderNodes(JsonObject document) =>
        document["providerNodes"]!.AsObject();

    private static Dictionary<string, string?> Parents(JsonObject document)
    {
        var result = new Dictionary<string, string?>(StringComparer.Ordinal) { ["master"] = null };
        foreach (var (id, record) in Approved(document).Concat(ProviderNodes(document)))
        {
            if (record is not JsonObject value)
                throw new InvalidDataException("Invalid Node authorization record: " + id);
            var parent = SessionWait.Text(value["parentNode"]);
            if (
                value["parentNode"] is not null
                && (parent is null || parent.Length == 0 || parent != parent.Trim())
            )
                throw new InvalidDataException("Invalid Node authorization parent: " + id);
            if (parent is not null)
                NodeProviderRegistry.ValidateId(parent);
            result.Add(id, parent);
        }
        return result;
    }

    internal NodeAuthorizationForest Forest()
    {
        lock (gate)
            return new(Parents(data));
    }

    private static bool Reserved(JsonObject document, string id) =>
        Parents(document).ContainsKey(id)
        || Parents(document).Values.Contains(id, StringComparer.Ordinal);

    private static void RequireFresh(JsonObject document, string id)
    {
        if (Reserved(document, id))
            throw new InvalidDataException("Node id already exists.");
    }

    private static void RequireNoChildren(JsonObject document, string id)
    {
        if (Parents(document).Values.Contains(id, StringComparer.Ordinal))
            throw new InvalidDataException("Node has descendants.");
    }

    private void RequireAdmission(
        JsonObject document,
        string id,
        string? parent,
        bool changed = false
    )
    {
        var parents = Parents(document);
        if (parent is not null)
        {
            NodeProviderRegistry.ValidateId(parent);
            if (!parents.ContainsKey(parent))
                throw new InvalidDataException("Authorization parent Node not found: " + parent);
            if (
                Pending(document)
                    .Any(pair => SessionWait.Text(pair.Value?["approvedNodeId"]) == parent)
            )
                throw new InvalidDataException(
                    "An unclaimed pairing cannot be an authorization parent."
                );
        }
        var oldParent = parents.GetValueOrDefault(id);
        var existing = parents.ContainsKey(id);
        if (existing && oldParent == parent && !changed)
            return; // Lowering admission limits never invalidates an unchanged edge.
        parents[id] = parent;
        var forest = new NodeAuthorizationForest(parents);
        var limits = treeLimits();
        // Reparenting is administrative, and its complete existing subtree must remain a forest.
        foreach (var member in forest.Subtree(id))
            if (forest.Chain(member).Count - 1 > limits.MaxDepth)
                throw new InvalidDataException("Node tree maximum depth exceeded.");
        if (parent is not null && parents.Count(pair => pair.Value == parent) > limits.MaxChildren)
            throw new InvalidDataException("Node tree maximum direct-child count exceeded.");
    }

    internal void RequireNewNode(string? id, string? parent, Mutation mutation)
    {
        mutation.Require(this);
        lock (gate)
        {
            if (id is not null)
                RequireFresh(data, id);
            // A generated ID has exactly the same admission cost as an explicit fresh identity.
            var candidate = id ?? "@new-node";
            RequireAdmission(data, candidate, parent);
        }
    }

    internal void SetParent(string id, string? parent)
    {
        NodeProviderRegistry.ValidateId(id);
        if (id == "master" || id.Contains('/'))
            throw new InvalidDataException(
                "Native administration changes approved Nodes only; provider parents use configuration."
            );
        Change(next =>
        {
            var record =
                Approved(next)[id] as JsonObject
                ?? throw new InvalidDataException("Approved Node not found.");
            RequireAdmission(next, id, parent);
            record["parentNode"] = parent;
            record["updatedAt"] = Now;
            return true;
        });
    }

    internal void ConfigureProviders(JsonObject? configuration)
    {
        var parents = (configuration ?? new()).ToDictionary(
            pair => pair.Key,
            pair => SessionWait.Text(pair.Value?["parentNode"]),
            StringComparer.Ordinal
        );
        using var mutation = BeginMutation();
        lock (gate)
        {
            var next = (JsonObject)data.DeepClone();
            var changed = new List<string>();
            foreach (var (id, raw) in ProviderNodes(next).ToArray())
            {
                var provider = SessionWait.Text(raw?["provider"])!;
                if (!parents.ContainsKey(provider))
                    raw!["absent"] = true;
                if (
                    parents.TryGetValue(provider, out var parent)
                    && SessionWait.Text(raw?["parentNode"]) != parent
                )
                {
                    raw!["parentNode"] = parent;
                    changed.Add(id);
                }
            }
            PruneAbsent(next, id => SessionCatalog.Flag(ProviderNodes(next)[id]?["absent"]));
            foreach (var id in changed.Where(id => ProviderNodes(next).ContainsKey(id)))
                RequireAdmission(
                    next,
                    id,
                    SessionWait.Text(ProviderNodes(next)[id]?["parentNode"]),
                    changed: true
                );
            if (!JsonNode.DeepEquals(next, data))
                Change(
                    document =>
                    {
                        document["providerNodes"] = next["providerNodes"]!.DeepClone();
                        return true;
                    },
                    mutation
                );
        }
        providerParents = parents;
    }

    private static void PruneAbsent(JsonObject document, Func<string, bool> absent)
    {
        bool removed;
        do
        {
            removed = false;
            foreach (var (id, _) in ProviderNodes(document).ToArray())
                if (absent(id) && !Parents(document).Values.Contains(id, StringComparer.Ordinal))
                {
                    ProviderNodes(document).Remove(id);
                    removed = true;
                }
        } while (removed);
    }

    internal void ObserveProvider(string provider, JsonArray descriptors, Mutation? mutation = null)
    {
        using var owned = mutation is null ? TryBeginMutation() : null;
        if (mutation is null && owned is null)
            return; // Concurrent inspection never waits for an external mutation's receipt.
        var scope = mutation ?? owned!;
        scope.Require(this);
        lock (gate)
        {
            var next = (JsonObject)data.DeepClone();
            var records = ProviderNodes(next);
            var seen = descriptors
                .OfType<JsonObject>()
                .Select(value => SessionWait.Text(value["id"])!)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var descriptor in descriptors.OfType<JsonObject>())
            {
                var id = SessionWait.Text(descriptor["id"])!;
                if (!records.ContainsKey(id))
                {
                    RequireFresh(next, id);
                    var parent = providerParents.GetValueOrDefault(provider);
                    RequireAdmission(next, id, parent);
                    records[id] = new JsonObject
                    {
                        ["nodeId"] = id,
                        ["provider"] = provider,
                        ["parentNode"] = parent,
                    };
                }
                records[id]!.AsObject().Remove("absent");
                records[id]!["descriptor"] = descriptor.DeepClone();
            }
            foreach (var (id, record) in records)
                if (id.StartsWith(provider + "/", StringComparison.Ordinal) && !seen.Contains(id))
                    record!["absent"] = true;
            PruneAbsent(next, id => SessionCatalog.Flag(records[id]?["absent"]));
            if (!JsonNode.DeepEquals(next, data))
                Change(
                    document =>
                    {
                        document["providerNodes"] = next["providerNodes"]!.DeepClone();
                        return true;
                    },
                    scope
                );
        }
    }

    internal void RecordProviderNode(string provider, JsonObject descriptor, Mutation mutation)
    {
        mutation.Require(this);
        Change(
            next =>
            {
                var id = SessionWait.Text(descriptor["id"])!;
                if (!ProviderNodes(next).ContainsKey(id))
                {
                    RequireFresh(next, id);
                    var parent = providerParents.GetValueOrDefault(provider);
                    RequireAdmission(next, id, parent);
                    ProviderNodes(next)[id] = new JsonObject
                    {
                        ["nodeId"] = id,
                        ["provider"] = provider,
                        ["parentNode"] = parent,
                    };
                }
                ProviderNodes(next)[id]!.AsObject().Remove("absent");
                ProviderNodes(next)[id]!["descriptor"] = descriptor.DeepClone();
                return true;
            },
            mutation
        );
    }

    internal void RemoveProviderNode(string id, Mutation mutation) =>
        Change(
            next =>
            {
                RequireNoChildren(next, id);
                ProviderNodes(next).Remove(id);
                return true;
            },
            mutation
        );

    internal JsonArray ProviderRecords()
    {
        lock (gate)
            return new(ProviderNodes(data).Select(pair => pair.Value!.DeepClone()).ToArray());
    }
}

// Authorization ancestry describes delegated tool scope, never physical hosting or incoming access.
internal sealed class NodeAuthorizationForest(IReadOnlyDictionary<string, string?> parents)
{
    internal IEnumerable<string> Ids => parents.Keys;

    internal bool Contains(string id) => parents.ContainsKey(id);

    internal string? Parent(string id) => parents.GetValueOrDefault(id);

    internal IReadOnlyList<string> Chain(string id)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var current = id;
        while (true)
        {
            if (!seen.Add(current))
                throw new InvalidDataException("Node authorization ancestry contains a cycle.");
            if (!parents.TryGetValue(current, out var parent))
                throw new InvalidDataException(
                    "Node authorization ancestor is missing: " + current
                );
            result.Add(current);
            if (parent is null)
                return result;
            current = parent;
        }
    }

    internal IReadOnlyList<string> Subtree(string id)
    {
        _ = Chain(id);
        var result = new List<string> { id };
        for (var index = 0; index < result.Count; index++)
            foreach (var pair in parents.Where(pair => pair.Value == result[index]))
            {
                if (result.Contains(pair.Key, StringComparer.Ordinal))
                    throw new InvalidDataException("Node authorization ancestry contains a cycle.");
                result.Add(pair.Key);
            }
        return result;
    }
}
