using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    public void OpenIdentityRecovery()
    {
        lock (gate)
        {
            if (!File.Exists(FilePath))
                throw new InvalidDataException(
                    "Identity recovery requires existing Main metadata."
                );
            Open();
        }
    }

    public JsonObject[] IdentityChildren(string id)
    {
        lock (gate)
            return Rows(
                    $"SELECT {Columns} FROM session_catalog WHERE parent_reference=$p0 ORDER BY session_id",
                    id
                )
                .ToArray();
    }

    public string[] RewriteIdentity(
        string from,
        string to,
        string agent,
        string[] aliases,
        bool requireSource = true
    )
    {
        lock (gate)
        {
            EnsureInitialized();
            var rewrite = SessionCatalogRules.RewriteIdentity(
                this,
                from,
                to,
                agent,
                aliases,
                requireSource
            );
            Execute(db!, "BEGIN IMMEDIATE");
            try
            {
                if (rewrite.HasSource)
                    Execute(db!, "DELETE FROM session_catalog WHERE session_id=$p0", from);
                WriteRowsLocked(rewrite.Rows);
                NormalizeParents(
                    db!,
                    new HashSet<string>(aliases, StringComparer.Ordinal) { from, to }
                );
                Execute(db!, "COMMIT");
                revision++;
            }
            catch
            {
                Execute(db!, "ROLLBACK");
                throw;
            }
            return rewrite.Direct;
        }
    }

    public string ValidateIdentityParent(string child, string parent)
    {
        lock (gate)
        {
            var id = Text(SessionCatalogRules.RequiredMain(this, parent, "parentSessionId")["id"])!;
            SessionCatalogRules.ValidateParent(this, child, id);
            return id;
        }
    }

    public void NotifyIdentityChanged() => Changed?.Invoke();
}

// Minimal metadata adapter for a pending source move before normal source-catalog migration.
// It selects one real metadata authority and never reads unrelated Session JSON.
internal sealed class SessionIdentityMetadata(string root, ISessionCatalogStore catalog)
{
    private JsonObject? legacy;
    private JsonObject? rows;
    private string? path;

    internal void Open()
    {
        if (catalog.Exists)
        {
            catalog.OpenIdentityRecovery();
            return;
        }
        path = Path.Combine(root, "state", "sessions.json");
        if (!File.Exists(path))
            throw new InvalidDataException(
                "Pending identity recovery has no existing Main metadata authority."
            );
        legacy =
            JsonNode.Parse(File.ReadAllText(path)) as JsonObject
            ?? throw new InvalidDataException("Main metadata must be an object.");
        rows = legacy["sessions"] as JsonObject ?? legacy;
        foreach (var (id, node) in rows)
        {
            if (id == "channelAttachments" && ReferenceEquals(rows, legacy))
                continue;
            if (node is not JsonObject row || SessionCatalog.Text(row["id"]) != id)
                throw new InvalidDataException("Main metadata identity is invalid.");
        }
    }

    internal JsonObject? Get(string id) => rows is null ? catalog.Get(id) : rows[id] as JsonObject;

    internal bool HasOtherAgentLifetime(string agent, string excluding) =>
        (rows is null ? catalog.List() : rows.Select(pair => pair.Value).OfType<JsonObject>()).Any(
            row =>
                SessionCatalog.Text(row["agent"]) == agent
                && SessionCatalog.Text(row["id"]) != excluding
        );

    internal string[] Rewrite(
        string from,
        string to,
        string agent,
        string[] aliases,
        bool requireSource = true
    )
    {
        if (rows is null)
            return catalog.RewriteIdentity(from, to, agent, aliases, requireSource);
        var source = Get(from);
        var target = Get(to);
        if (source is not null && target is not null)
            throw new InvalidDataException("Pending move has conflicting exact Main lifetimes.");
        if (source is null && (requireSource || target is null))
            throw new InvalidDataException("Pending move lacks its exact Main lifetime.");
        var row = source ?? target!;
        rows.Remove(from);
        rows.Remove(to);
        row["id"] = to;
        row["agent"] = agent;
        row["aliases"] = new JsonArray(
            aliases.Select(alias => (JsonNode?)JsonValue.Create(alias)).ToArray()
        );
        rows[to] = row;
        var children = rows.Where(pair =>
                pair.Value is JsonObject child
                && SessionCatalog.Text(child["parentSessionId"]) == from
            )
            .ToArray();
        foreach (var child in children)
            child.Value!["parentSessionId"] = to;
        new AtomicJsonFile(root, Path.GetRelativePath(root, path!)).WritePayload(legacy!);
        return children.Select(child => child.Key).ToArray();
    }
}
