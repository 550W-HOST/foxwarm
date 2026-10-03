using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    internal void OpenIdentityRecovery() { lock (gate) { if (!File.Exists(FilePath)) throw new InvalidDataException("Identity recovery requires existing Main metadata."); Open(); } }
    internal JsonObject[] IdentityChildren(string id)
    { lock (gate) return Rows($"SELECT {Columns} FROM session_catalog WHERE parent_reference=$p0 ORDER BY session_id", id).ToArray(); }
    internal string[] RewriteIdentity(string from, string to, string agent, string[] aliases, bool requireSource = true)
    {
        lock (gate)
        {
            EnsureInitialized(); var source = Get(from); var existing = Get(to);
            if (source is not null && existing is not null) throw new InvalidDataException("Identity recovery has conflicting exact Main lifetimes.");
            if (source is null && (requireSource || existing is null)) throw new InvalidDataException("Identity move lacks its exact Main lifetime.");
            var row = source ?? existing!; row["id"] = to; row["agent"] = agent;
            row["aliases"] = new JsonArray(aliases.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
            var direct = IdentityChildren(from); var children = direct.Where(child => Text(child["id"]) != from).ToArray();
            if (Text(row["parentSessionId"]) == from) row["parentSessionId"] = to;
            foreach (var child in children) child["parentSessionId"] = to;
            Execute(db!, "BEGIN IMMEDIATE");
            try
            {
                if (source is not null) Execute(db!, "DELETE FROM session_catalog WHERE session_id=$p0", from);
                WriteRowsLocked([Project(row), .. children.Select(Project)]);
                NormalizeParents(db!, new HashSet<string>(aliases, StringComparer.Ordinal) { from, to });
                Execute(db!, "COMMIT"); revision++;
            }
            catch { Execute(db!, "ROLLBACK"); throw; }
            return direct.Select(child => Text(child["id"]) == from ? to : Text(child["id"])!).ToArray();
        }
    }
    internal string ValidateIdentityParent(string child, string parent)
    { lock (gate) { var id = Text(RequiredMain(parent, "parentSessionId")["id"])!; ValidateParent(child, id); return id; } }
    internal void NotifyIdentityChanged() => Changed?.Invoke();
}

// Minimal metadata adapter for a pending source move before normal source-catalog migration.
// It selects one real metadata authority and never reads unrelated Session JSON.
internal sealed class SessionIdentityMetadata(string root, SessionCatalog catalog)
{
    private JsonObject? legacy;
    private JsonObject? rows;
    private string? path;
    internal void Open()
    {
        if (File.Exists(catalog.FilePath)) { catalog.OpenIdentityRecovery(); return; }
        path = Path.Combine(root, "state", "sessions.json");
        if (!File.Exists(path)) throw new InvalidDataException("Pending identity recovery has no existing Main metadata authority.");
        legacy = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new InvalidDataException("Main metadata must be an object.");
        rows = legacy["sessions"] as JsonObject ?? legacy;
        foreach (var (id, node) in rows)
        {
            if (id == "channelAttachments" && ReferenceEquals(rows, legacy)) continue;
            if (node is not JsonObject row || SessionCatalog.Text(row["id"]) != id) throw new InvalidDataException("Main metadata identity is invalid.");
        }
    }
    internal JsonObject? Get(string id) => rows is null ? catalog.Get(id) : rows[id] as JsonObject;
    internal bool HasOtherAgentLifetime(string agent, string excluding) => (rows is null ? catalog.List() : rows.Select(pair => pair.Value).OfType<JsonObject>())
        .Any(row => SessionCatalog.Text(row["agent"]) == agent && SessionCatalog.Text(row["id"]) != excluding);
    internal string[] Rewrite(string from, string to, string agent, string[] aliases, bool requireSource = true)
    {
        if (rows is null) return catalog.RewriteIdentity(from, to, agent, aliases, requireSource);
        var source = Get(from); var target = Get(to);
        if (source is not null && target is not null) throw new InvalidDataException("Pending move has conflicting exact Main lifetimes.");
        if (source is null && (requireSource || target is null)) throw new InvalidDataException("Pending move lacks its exact Main lifetime.");
        var row = source ?? target!; rows.Remove(from); rows.Remove(to); row["id"] = to; row["agent"] = agent;
        row["aliases"] = new JsonArray(aliases.Select(alias => (JsonNode?)JsonValue.Create(alias)).ToArray()); rows[to] = row;
        var children = rows.Where(pair => pair.Value is JsonObject child && SessionCatalog.Text(child["parentSessionId"]) == from).ToArray();
        foreach (var child in children) child.Value!["parentSessionId"] = to;
        new LinuxAtomicJsonFile(root, Path.GetRelativePath(root, path!)).WritePayload(legacy!);
        return children.Select(child => child.Key).ToArray();
    }
}
