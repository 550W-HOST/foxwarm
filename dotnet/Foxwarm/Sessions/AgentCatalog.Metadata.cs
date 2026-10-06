using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal JsonObject MetadataSnapshot()
    {
        lock (stateGate)
            return (JsonObject)metadata.DeepClone();
    }

    internal string? Inherit(string name)
    {
        lock (stateGate)
            return metadata[name] is JsonObject row ? SessionWait.Text(row["inherit"]) : null;
    }

    internal string[] InheritanceChain(string name) => Chain(name, MetadataSnapshot());

    private static string[] Chain(string name, JsonObject snapshot)
    {
        var chain = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string? current = name;
        while (!string.IsNullOrEmpty(current))
        {
            if (!seen.Add(current))
            {
                Console.Error.WriteLine(
                    $"Circular Agent inheritance detected for '{name}'; stopping at '{current}'."
                );
                break;
            }
            chain.Insert(0, current);
            current = snapshot[current] is JsonObject row ? SessionWait.Text(row["inherit"]) : null;
        }
        return chain.ToArray();
    }

    // Read-old missing sources contribute no directory contents; public mutations still require an existing Agent.
    internal string SourceDirectory(string name)
    {
        ValidateName(name);
        return name == "main" ? workspaceRoot : Path.Combine(agentRoot, name);
    }

    internal void ValidateInheritance(string name, string? inherit)
    {
        if (inherit is null)
            return;
        ValidateName(inherit);
        if (name == inherit)
            throw new InvalidDataException("Agent cannot inherit from itself.");
        if (!Exists(inherit) || !Directory.Exists(SourceDirectory(inherit)))
            throw new InvalidDataException($"Inherited Agent '{inherit}' does not exist.");
        if (InheritanceChain(inherit).Contains(name, StringComparer.Ordinal))
            throw new InvalidDataException("Circular Agent inheritance is not allowed.");
    }

    internal async Task SetInheritAsync(string name, string? inherit)
    {
        ValidateName(name);
        await createGate.WaitAsync();
        try
        {
            if (!Exists(name))
                throw new InvalidDataException($"Agent '{name}' does not exist.");
            ValidateInheritance(name, inherit);
            var next = MetadataSnapshot();
            var row = next[name] as JsonObject ?? new JsonObject();
            next[name] = row;
            if (inherit is null)
                row.Remove("inherit");
            else
                row["inherit"] = inherit;
            try
            {
                AtomicIndexWrite(
                    indexPath,
                    Payload(List().Where(id => id != "main"), next).ToJsonString()
                );
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

    private static JsonObject Payload(IEnumerable<string> names, JsonObject metadata) =>
        new()
        {
            ["version"] = 2,
            ["agents"] = new JsonArray(
                names.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()
            ),
            ["metadata"] = metadata,
        };
}
