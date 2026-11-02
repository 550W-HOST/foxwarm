using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>Display name and online state of a Node shown as a Sidebar group.</summary>
internal sealed record SessionGroupNode(string Label, bool Online);

// Sidebar Agent/Node groups. A tree-mode group holds unpinned top-level Sessions, each with
// its real subtree; a Flat group holds every unpinned Session. Pinned rows keep their own
// section, and real parents stay authoritative for every action.
internal sealed partial class SessionListQueries
{
    public static string? Grouping(string? value) =>
        value is null ? null
        : value is "agent" or "node" ? value
        : throw new SessionListQueryException(
            "SESSION_LIST_GROUP_INVALID",
            "group must be agent or node."
        );

    private static bool InGroup(JsonObject row, string by, string key, string mode)
    {
        if (SessionCatalog.Flag(row["pinned"]))
            return false;
        if (mode != "flat-time" && SessionCatalog.Text(row["parentSessionId"]) is not null)
            return false;
        return (
                by == "agent"
                    ? SessionCatalog.Text(row["agent"])
                    : SessionCatalog.Text(row["currentNode"]) ?? "master"
            ) == key;
    }

    /// <summary>
    /// Non-empty groups with member counts: the main Agent or the master Node first, then
    /// by name. Nodes missing from the directory keep their ID as the name.
    /// </summary>
    public JsonArray Groups(
        string by,
        string mode,
        IReadOnlyDictionary<string, SessionGroupNode> nodes
    )
    {
        var first = by == "agent" ? "main" : "master";
        var groups = Catalog
            .GroupCounts(by, mode != "flat-time")
            .Select(pair =>
            {
                var node = by == "node" ? nodes.GetValueOrDefault(pair.Key) : null;
                return (
                    Key: pair.Key,
                    Label: node?.Label ?? pair.Key,
                    Count: pair.Value,
                    Online: node?.Online ?? false
                );
            })
            .OrderBy(group => group.Key == first ? 0 : 1)
            .ThenBy(group => group.Label, StringComparer.OrdinalIgnoreCase)
            .ThenBy(group => group.Label, StringComparer.Ordinal)
            .ThenBy(group => group.Key, StringComparer.Ordinal);
        return new JsonArray(
            groups
                .Select(group =>
                {
                    var item = new JsonObject
                    {
                        ["key"] = group.Key,
                        ["label"] = group.Label,
                        ["count"] = group.Count,
                    };
                    if (by == "node")
                        item["online"] = group.Online;
                    return (JsonNode?)item;
                })
                .ToArray()
        );
    }

    // A continuation key below every member, used when a first page holds only the Agent's
    // main Session.
    private static JsonArray StartKey(string mode) =>
        mode == "default" ? new JsonArray(-1, 0, 0, 0, "") : new JsonArray(-1, 0, "");

    /// <summary>
    /// Keyset pages of group members. An Agent group's main Session is the first row of its
    /// first page; continuations exclude it.
    /// </summary>
    public JsonObject GroupPages(
        (string Key, string? Cursor)[] requests,
        string by,
        string mode,
        int limit
    )
    {
        requests = requests
            .GroupBy(request => request.Key, StringComparer.Ordinal)
            .Select(group => group.Last())
            .ToArray();
        string Scope(string key) => $"group:{by}:{key}";
        var decoded = requests
            .Select(request => Decode(request.Cursor, mode, Scope(request.Key), true))
            .ToArray();
        var reset = decoded.Any(cursor =>
            cursor is not null && SessionCatalog.Text(cursor["revision"]) != Revision
        );
        var counts = Catalog.GroupCounts(by, mode != "flat-time");
        var reads = requests
            .Select(
                (request, index) =>
                {
                    var after = reset ? null : decoded[index]?["key"] as JsonArray;
                    var main = by == "agent" ? SessionCatalog.AgentMainId(request.Key) : null;
                    var page = Catalog.GroupPage(by, request.Key, mode, limit, after, main);
                    return (request.Key, After: after, Main: after is null ? main : null, page);
                }
            )
            .ToArray();
        var candidates = runtime.Projections(
            reads
                .SelectMany(read =>
                    read.page.Rows.Select(Id).Concat(read.Main is null ? [] : [read.Main])
                )
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            true
        );
        var groups = new JsonArray();
        foreach (var read in reads)
        {
            var members = candidates.Where(row => InGroup(row, by, read.Key, mode)).ToArray();
            var main = read.Main is null
                ? null
                : members.FirstOrDefault(row => Id(row) == read.Main);
            var excluded = by == "agent" ? SessionCatalog.AgentMainId(read.Key) : null;
            var others = members
                .Where(row => Id(row) != excluded)
                .Where(row => read.After is null || Compare(Key(row, mode, true), read.After) > 0)
                .OrderBy(row => Key(row, mode, true), Comparer<JsonArray>.Create(Compare))
                .ToArray();
            var room = limit - (main is null ? 0 : 1);
            var selected = others.Take(room).ToArray();
            var more = read.page.HasMore || others.Length > room;
            groups.Add(
                new JsonObject
                {
                    ["key"] = read.Key,
                    ["sessions"] = Array(main is null ? selected : [main, .. selected]),
                    ["total"] = counts.GetValueOrDefault(read.Key),
                    ["nextCursor"] = more
                        ? Encode(
                            new JsonObject
                            {
                                ["v"] = 1,
                                ["kind"] = "page",
                                ["mode"] = mode,
                                ["scope"] = Scope(read.Key),
                                ["revision"] = Revision,
                                ["key"] =
                                    selected.Length > 0
                                        ? Key(selected[^1], mode, true)
                                        : StartKey(mode),
                            }
                        )
                        : null,
                }
            );
        }
        return new JsonObject
        {
            ["version"] = 1,
            ["revision"] = Revision,
            ["reset"] = reset,
            ["groups"] = groups,
        };
    }

    /// <summary>
    /// The group of each Session the Sidebar may show outside a loaded group page: in tree
    /// modes the group of its top-level ancestor, in Flat its own.
    /// </summary>
    public JsonObject PresentationGroups(IEnumerable<string> ids, string by, string mode)
    {
        var requested = ids.Distinct(StringComparer.Ordinal).ToArray();
        var owners = requested.ToDictionary(id => id, id => id, StringComparer.Ordinal);
        if (mode != "flat-time")
            foreach (var chunk in requested.Chunk(100))
            foreach (var pair in Catalog.Paths(chunk))
                if (pair.Value.Length > 0)
                    owners[pair.Key] = pair.Value[0];
        var keys = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var chunk in owners.Values.Distinct(StringComparer.Ordinal).Chunk(200))
        foreach (var pair in Catalog.GroupKeys(chunk, by))
            keys[pair.Key] = pair.Value;
        var result = new JsonObject();
        foreach (var id in requested)
            if (keys.TryGetValue(owners[id], out var key))
                result[id] = key;
        return result;
    }
}
