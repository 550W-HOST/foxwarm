using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres;

// The file catalog's list, tree, count, group and activity queries. Order keys, keyset
// comparisons and batch limits are the SQLite ones; where SQLite names an index with INDEXED
// BY, the matching index exists and the catalog's EXPLAIN tests check that the plan uses it.
// Results the file catalog returns without an order (restart, approval and wait IDs, sequence
// rows) are in Session ID order here.
internal sealed partial class PgSessionCatalog
{
    // Builds positional parameters for one statement.
    private sealed class Arguments
    {
        private readonly List<object?> values = [];

        internal string Add(object? value)
        {
            values.Add(value);
            return "$" + values.Count;
        }

        internal object?[] ToArray() => values.ToArray();
    }

    private static readonly HashSet<string> IntegerOrderColumns =
    [
        "pinned_rank",
        "archived",
        "sidebar_order_missing",
    ];

    // Cursor key parts bound with the column's type, so the comparison stays an index
    // condition. A non-integral value for an integer column (never produced by a cursor this
    // catalog wrote) still compares numerically, as in SQLite.
    private static object?[] CursorArgs(JsonArray key, string[] columns) =>
        key.Select(
                (value, index) =>
                    index == key.Count - 1 ? (object?)Text(value)
                    : SessionCatalog.Number(value) is not { } number ? null
                    : IntegerOrderColumns.Contains(columns[index])
                    && number == Math.Floor(number)
                    && Math.Abs(number) < 9.0E18
                        ? (object)(long)number
                    : number
            )
            .ToArray();

    private static string Keyset(
        Arguments args,
        string[] columns,
        JsonArray after,
        string prefix = ""
    ) =>
        "("
        + string.Join(',', columns.Select(column => prefix + column))
        + ")>("
        + string.Join(',', CursorArgs(after, columns).Select(args.Add))
        + ")";

    public string[] RestartIds()
    {
        using (gate.Enter())
            return Read(tx =>
                    Strings(
                        tx,
                        "SELECT session_id FROM session_catalog WHERE busy=1 UNION SELECT session_id FROM session_catalog WHERE queue_length>0 UNION SELECT session_id FROM session_catalog WHERE managed_pending_count>0 ORDER BY session_id"
                    )
                )
                .ToArray();
    }

    public string[] PendingApprovalIds()
    {
        using (gate.Enter())
            return Read(tx =>
                    Strings(
                        tx,
                        "SELECT session_id FROM session_catalog WHERE question_open>0 AND question_approvals>0 ORDER BY session_id"
                    )
                )
                .ToArray();
    }

    public string[] RecentWaitIds(long activityCutoff)
    {
        using (gate.Enter())
            return Read(tx =>
                    Strings(
                        tx,
                        "SELECT session_id FROM session_catalog WHERE recent_rank<=$1 AND wait_present ORDER BY session_id",
                        -(double)activityCutoff
                    )
                )
                .ToArray();
    }

    public long Count(string? agent = null, string? parent = null)
    {
        if (!Storable(agent) || !Storable(parent))
            return 0;
        using (gate.Enter())
            return Read(tx =>
                Long(
                    parent is not null
                        ? tx.Scalar(
                            "SELECT session_count FROM catalog_parent_count WHERE parent_key=$1",
                            parent
                        ) ?? 0L
                    : agent is null
                        ? tx.Scalar("SELECT session_count FROM catalog_count") ?? 0L
                    : tx.Scalar(
                        "SELECT session_count FROM catalog_agent_count WHERE agent=$1",
                        agent
                    ) ?? 0L
                )
            );
    }

    public JsonObject[] OffsetPage(
        int limit,
        int offset,
        string? agent = null,
        string? parent = null
    )
    {
        if (!Storable(agent) || !Storable(parent))
            return [];
        using (gate.Enter())
        {
            var terms = new List<string>();
            var args = new Arguments();
            if (agent is not null)
                terms.Add("agent=" + args.Add(agent));
            if (parent is not null)
                terms.Add("parent_session_id=" + args.Add(parent));
            var sql =
                $"SELECT {Columns} FROM session_catalog"
                + (terms.Count > 0 ? " WHERE " + string.Join(" AND ", terms) : "")
                + " ORDER BY recent_rank,session_id LIMIT "
                + args.Add((long)limit)
                + " OFFSET "
                + args.Add((long)offset);
            return Read(tx => Rows(tx, sql, args.ToArray())).ToArray();
        }
    }

    public CatalogPage Page(
        string mode,
        int limit,
        JsonArray? after,
        bool roots,
        string? agent,
        bool pinnedOnly = false
    )
    {
        if (!Storable(agent))
            return new([], false);
        using (gate.Enter())
        {
            var columns = SessionCatalog.OrderColumns(
                mode,
                false,
                mode != "flat-time" && agent is null
            );
            var terms = new List<string>();
            var args = new Arguments();
            var forest = agent is not null && roots;
            if (agent is not null)
                terms.Add("c.agent=" + args.Add(agent));
            if (pinnedOnly)
                // Grouped Sidebars list the pinned partition alone; every pinned row is a root.
                terms.Add("c.presentation_root=1 AND c.pinned_rank=0");
            else if (forest)
                terms.Add(
                    "(c.parent_session_id IS NULL OR parent.session_id IS NULL OR parent.agent<>c.agent)"
                );
            else if (roots && mode != "flat-time")
                terms.Add("c.presentation_root=1");
            if (after is not null)
                terms.Add(Keyset(args, columns, after, "c."));
            var sql =
                "SELECT c.metadata_json,c.busy,c.queue_length,c.managed_pending_count FROM session_catalog c"
                + (
                    forest
                        ? " LEFT JOIN session_catalog parent ON parent.session_id=c.parent_session_id"
                        : ""
                )
                + (terms.Count > 0 ? " WHERE " + string.Join(" AND ", terms) : "")
                + " ORDER BY "
                + string.Join(',', columns.Select(column => "c." + column))
                + " LIMIT "
                + args.Add((long)limit + 1);
            var rows = Read(tx => Rows(tx, sql, args.ToArray()));
            return new(rows.Take(limit).ToArray(), rows.Count > limit);
        }
    }

    public CatalogChildren[] Children(
        IReadOnlyList<(string Id, JsonArray? After)> requests,
        string mode,
        int limit,
        string? agent,
        IReadOnlyDictionary<string, int>? limits = null
    )
    {
        if (requests.Count == 0)
            return [];
        if (requests.Count > 100)
            throw new InvalidDataException("Catalog child batch exceeds 100 parents.");
        if (agent is not null && mode != "time")
            throw new InvalidDataException("Agent forest children require time mode.");
        int Take(string id) =>
            limits is not null && limits.TryGetValue(id, out var own) ? own : limit;
        using (gate.Enter())
        {
            var activity = agent is null && mode != "flat-time";
            var columns = SessionCatalog.OrderColumns(mode, true, activity);
            var args = new Arguments();
            var branches = new List<string>();
            var grouped = new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal);
            var totals = new Dictionary<string, long>(StringComparer.Ordinal);
            if (Storable(agent))
            {
                foreach (var request in requests.Where(request => Storable(request.Id)))
                {
                    // A per-parent limit sizes that parent's window; others use the shared limit.
                    var where =
                        "parent_session_id="
                        + args.Add(request.Id)
                        + (agent is null ? " AND pinned=0" : " AND agent=" + args.Add(agent));
                    if (request.After is not null)
                        where += " AND " + Keyset(args, columns, request.After);
                    branches.Add(
                        $"(SELECT {Columns},parent_session_id FROM session_catalog WHERE {where} ORDER BY {string.Join(',', columns)} LIMIT {args.Add((long)Take(request.Id) + 1)})"
                    );
                }
                if (branches.Count > 0)
                    Read(tx =>
                    {
                        using var command = Command(tx, 
                            string.Join(" UNION ALL ", branches),
                            args.ToArray()
                        );
                        using var reader = command.ExecuteReader();
                        while (reader.Read())
                        {
                            var parent = reader.GetString(4);
                            if (!grouped.TryGetValue(parent, out var group))
                                grouped[parent] = group = [];
                            group.Add(ReadRow(reader));
                        }
                        return true;
                    });
                totals = ChildCounts(requests.Select(request => request.Id).ToArray(), agent);
            }
            return requests
                .Select(request =>
                {
                    var group = grouped.GetValueOrDefault(request.Id) ?? [];
                    var take = Take(request.Id);
                    return new CatalogChildren(
                        request.Id,
                        group.Take(take).ToArray(),
                        totals.GetValueOrDefault(request.Id),
                        group.Count > take
                    );
                })
                .ToArray();
        }
    }

    public Dictionary<string, long> ChildCounts(string[] ids, string? agent = null)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        if (ids.Length == 0)
            return result;
        if (ids.Length > 4096)
            throw new InvalidDataException("Catalog child counts exceed 4096 IDs.");
        var keys = StorableIds(ids);
        if (keys.Length == 0 || !Storable(agent))
            return result;
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = agent is null
                    ? Command(tx, 
                        "SELECT parent_key,unpinned_session_count FROM catalog_parent_count WHERE parent_key = ANY($1)",
                        TextArray(keys)
                    )
                    : Command(tx, 
                        "SELECT parent_key,session_count FROM catalog_parent_agent_count WHERE agent=$1 AND parent_key = ANY($2)",
                        agent,
                        TextArray(keys)
                    );
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    result[reader.GetString(0)] = reader.GetInt64(1);
                return result;
            });
    }

    public Dictionary<string, JsonObject> Scopes(string[] ids)
    {
        var result = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        if (ids.Length == 0)
            return result;
        if (ids.Length > 200)
            throw new InvalidDataException("Scope batch exceeds 200 IDs.");
        var keys = StorableIds(ids);
        if (keys.Length == 0)
            return result;
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, 
                    "SELECT c.session_id,c.parent_session_id,parent.agent,c.pinned,c.agent FROM session_catalog c LEFT JOIN session_catalog parent ON parent.session_id=c.parent_session_id WHERE c.session_id = ANY($1)",
                    TextArray(keys)
                );
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    result[reader.GetString(0)] = new JsonObject
                    {
                        ["parentSessionId"] = reader.IsDBNull(1) ? null : reader.GetString(1),
                        ["parentAgent"] = reader.IsDBNull(2) ? null : reader.GetString(2),
                        ["pinned"] = reader.GetInt64(3) == 1,
                        ["agent"] = reader.GetString(4),
                    };
                return result;
            });
    }

    public Dictionary<string, JsonObject> ResolveMany(string[] ids)
    {
        if (ids.Length == 0)
            return new(StringComparer.Ordinal);
        if (ids.Length > 200)
            throw new InvalidDataException("Alias batch exceeds 200 IDs.");
        using (gate.Enter())
            return Read(tx =>
            {
                var exact = GetMany(ids)
                    .Select(row => Text(row["id"])!)
                    .ToHashSet(StringComparer.Ordinal);
                var result = ids.Distinct(StringComparer.Ordinal)
                    .ToDictionary(
                        id => id,
                        id =>
                            exact.Contains(id)
                                ? new JsonObject { ["kind"] = "exact", ["sessionId"] = id }
                                : new JsonObject { ["kind"] = "missing" },
                        StringComparer.Ordinal
                    );
                var keys = StorableIds(ids);
                if (keys.Length == 0)
                    return result;
                using var command = Command(tx, 
                    "SELECT alias,session_id FROM session_alias WHERE alias = ANY($1) ORDER BY alias,session_id",
                    TextArray(keys)
                );
                using var reader = command.ExecuteReader();
                var owners = new Dictionary<string, JsonArray>(StringComparer.Ordinal);
                while (reader.Read())
                {
                    var alias = reader.GetString(0);
                    if (!owners.TryGetValue(alias, out var owner))
                        owners[alias] = owner = new();
                    if (owner.Count < 2)
                        owner.Add((JsonNode?)reader.GetString(1));
                }
                foreach (var (alias, owner) in owners)
                    if (!exact.Contains(alias))
                        result[alias] =
                            owner.Count == 1
                                ? new JsonObject
                                {
                                    ["kind"] = "alias",
                                    ["sessionId"] = owner[0]!.DeepClone(),
                                }
                                : new JsonObject { ["kind"] = "ambiguous", ["sessionIds"] = owner };
                return result;
            });
    }

    public Dictionary<string, string[]> Paths(string[] ids)
    {
        if (ids.Length == 0)
            return new(StringComparer.Ordinal);
        if (ids.Length > 100)
            throw new InvalidDataException("Path batch exceeds 100 IDs.");
        var keys = StorableIds(ids);
        if (keys.Length == 0)
            return new(StringComparer.Ordinal);
        const string sql = """
            WITH RECURSIVE paths(focus_id,session_id,parent_session_id,depth,trail) AS (
            SELECT session_id,session_id,parent_session_id,0,ARRAY[session_id] FROM session_catalog WHERE session_id = ANY($1)
            UNION ALL SELECT paths.focus_id,parent.session_id,parent.parent_session_id,paths.depth+1,paths.trail||parent.session_id
            FROM paths JOIN session_catalog parent ON parent.session_id=paths.parent_session_id
            WHERE paths.depth<127 AND parent.session_id <> ALL(paths.trail))
            SELECT focus_id,session_id,depth FROM paths ORDER BY focus_id,depth DESC
            """;
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, sql, TextArray(keys));
                using var reader = command.ExecuteReader();
                var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                while (reader.Read())
                {
                    var focus = reader.GetString(0);
                    if (!result.TryGetValue(focus, out var path))
                        result[focus] = path = [];
                    path.Add(reader.GetString(1));
                }
                return result.ToDictionary(
                    pair => pair.Key,
                    pair => pair.Value.ToArray(),
                    StringComparer.Ordinal
                );
            });
    }

    public JsonObject Summary() => Summary(out _);

    public JsonObject Summary(out long costCount)
    {
        var keys = new[]
        {
            "total",
            "busy",
            "queued",
            "managed",
            "cachedTokens",
            "inputTokens",
            "outputTokens",
        };
        (long[] Counts, double Cost, long CostCount) values;
        using (gate.Enter())
            values = Read(tx =>
            {
                using var command = Command(tx, 
                    "SELECT session_count,busy_count,queued_count,managed_count,cached_tokens,input_tokens,output_tokens,cost,cost_count FROM catalog_count"
                );
                using var reader = command.ExecuteReader();
                // No row yet: the tenant never had a Session, like the file catalog's zero row.
                if (!reader.Read())
                    return (new long[keys.Length], 0d, 0L);
                return (
                    Enumerable.Range(0, keys.Length).Select(reader.GetInt64).ToArray(),
                    reader.GetDouble(7),
                    reader.GetInt64(8)
                );
            });
        var result = new JsonObject();
        for (var index = 0; index < keys.Length; index++)
            result[keys[index]] = values.Counts[index];
        costCount = values.CostCount;
        if (costCount > 0)
            result["cost"] = values.Cost;
        return result;
    }

    public Dictionary<string, (int Total, int Active, int Queued)> AgentActivityCounts()
    {
        using (gate.Enter())
            return Read(tx =>
            {
                var result = new Dictionary<string, (int Total, int Active, int Queued)>(
                    StringComparer.Ordinal
                );
                using (var command = Command(tx, "SELECT agent,session_count FROM catalog_agent_count"))
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        result[reader.GetString(0)] = (checked((int)reader.GetInt64(1)), 0, 0);
                using (
                    var command = Command(tx, 
                        "SELECT agent,COUNT(*) FROM session_catalog WHERE busy=1 GROUP BY agent"
                    )
                )
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                    {
                        var agent = reader.GetString(0);
                        var value = result[agent];
                        result[agent] = (value.Total, checked((int)reader.GetInt64(1)), value.Queued);
                    }
                using (
                    var command = Command(tx, 
                        "SELECT agent,COUNT(*) FROM session_catalog WHERE queue_length>0 GROUP BY agent"
                    )
                )
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                    {
                        var agent = reader.GetString(0);
                        var value = result[agent];
                        result[agent] = (value.Total, value.Active, checked((int)reader.GetInt64(1)));
                    }
                return result;
            });
    }

    public JsonArray AgentCounts()
    {
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, 
                    "SELECT agent,session_count FROM catalog_agent_count ORDER BY agent"
                );
                using var reader = command.ExecuteReader();
                var result = new JsonArray();
                while (reader.Read())
                    result.Add(
                        new JsonObject
                        {
                            ["agent"] = reader.GetString(0),
                            ["count"] = reader.GetInt64(1),
                        }
                    );
                return result;
            });
    }

    // UNION discards rows already produced, so a legacy cycle ends the recursion.
    private const string DescendantCte =
        "WITH RECURSIVE subtree(session_id) AS (SELECT $1::text COLLATE \"C\" UNION SELECT child.session_id FROM session_catalog child JOIN subtree ON child.parent_session_id=subtree.session_id) ";

    public (JsonObject Summary, JsonObject[] Rows, long CostCount) Descendants(
        string id,
        int limit
    )
    {
        var summary = new JsonObject
        {
            ["total"] = 0,
            ["busy"] = 0,
            ["queued"] = 0,
            ["cachedTokens"] = 0,
            ["inputTokens"] = 0,
            ["outputTokens"] = 0,
        };
        if (!Storable(id))
            return (summary, [], 0);
        var sql =
            DescendantCte
            + $"""
                , descendants AS (SELECT c.*,count(*) OVER() total,(sum(c.busy) OVER())::bigint busyTotal,
                (sum(CASE WHEN c.queue_length>0 THEN 1 ELSE 0 END) OVER())::bigint queuedTotal,
                (sum(c.cached_tokens) OVER())::bigint cachedTokens,(sum(c.input_tokens) OVER())::bigint inputTokens,(sum(c.output_tokens) OVER())::bigint outputTokens,
                sum(c.cost) OVER() costTotal,count(c.cost) OVER() costCount
                FROM session_catalog c JOIN subtree s ON s.session_id=c.session_id WHERE c.session_id<>$1)
                SELECT {Columns},total,busyTotal,queuedTotal,cachedTokens,inputTokens,outputTokens,costTotal,costCount FROM descendants ORDER BY recent_rank,session_id LIMIT $2
                """;
        var keys = summary.Select(pair => pair.Key).ToArray();
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, sql, id, (long)limit);
                using var reader = command.ExecuteReader();
                var rows = new List<JsonObject>();
                long costCount = 0;
                while (reader.Read())
                {
                    rows.Add(ReadRow(reader));
                    for (var index = 0; index < keys.Length; index++)
                        summary[keys[index]] = reader.GetInt64(index + 4);
                    costCount = reader.GetInt64(11);
                    if (costCount > 0)
                        summary["cost"] = reader.GetDouble(10);
                }
                return (summary, rows.ToArray(), costCount);
            });
    }

    public HashSet<string> FilterDescendants(string id, string[] candidates)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        var keys = StorableIds(candidates);
        if (keys.Length == 0 || !Storable(id))
            return result;
        using (gate.Enter())
            return Read(tx =>
            {
                result.UnionWith(
                    Strings(
                        tx,
                        DescendantCte
                            + "SELECT session_id FROM subtree WHERE session_id<>$1 AND session_id = ANY($2)",
                        id,
                        TextArray(keys)
                    )
                );
                return result;
            });
    }

    public Dictionary<string, int> BusyDescendants(string[] roots, string[] busy)
    {
        var result = roots.ToDictionary(id => id, _ => 0, StringComparer.Ordinal);
        var busyKeys = StorableIds(busy);
        var rootKeys = StorableIds(roots);
        if (rootKeys.Length == 0 || busyKeys.Length == 0)
            return result;
        const string sql = """
            WITH RECURSIVE ancestors(busy_id,session_id,parent_session_id,trail) AS (
            SELECT session_id,session_id,parent_session_id,ARRAY[session_id] FROM session_catalog WHERE session_id = ANY($1)
            UNION ALL SELECT a.busy_id,p.session_id,p.parent_session_id,a.trail||p.session_id FROM ancestors a JOIN session_catalog p ON p.session_id=a.parent_session_id
            WHERE p.session_id <> ALL(a.trail))
            SELECT session_id,count(DISTINCT busy_id) FROM ancestors WHERE session_id<>busy_id AND session_id = ANY($2) GROUP BY session_id
            """;
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, sql, TextArray(busyKeys), TextArray(rootKeys));
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    result[reader.GetString(0)] = checked((int)reader.GetInt64(1));
                return result;
            });
    }

    // ---- Groups -------------------------------------------------------------------------

    private static string GroupColumn(string by) =>
        by switch
        {
            "agent" => "agent",
            "node" => "current_node",
            _ => throw new InvalidDataException("Unknown Session group."),
        };

    public Dictionary<string, long> GroupCounts(string by, bool tree)
    {
        var column = GroupColumn(by);
        var sql =
            by == "agent"
                ? tree
                    ? "SELECT agent,session_count FROM catalog_parent_agent_count WHERE parent_key=''"
                    : "SELECT agent,session_count FROM catalog_agent_count"
                : tree
                    ? "SELECT current_node,root_count FROM catalog_node_count"
                    : "SELECT current_node,session_count FROM catalog_node_count";
        // Every pinned row is a presentation root; the pinned range of the root index is small.
        var pinned =
            $"SELECT {column},count(*) FROM session_catalog WHERE presentation_root=1 AND pinned_rank=0"
            + (tree ? " AND parent_session_id IS NULL" : "")
            + $" GROUP BY {column}";
        using (gate.Enter())
            return Read(tx =>
            {
                var counts = new Dictionary<string, long>(StringComparer.Ordinal);
                using (var command = Command(tx, sql))
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        counts[reader.GetString(0)] = reader.GetInt64(1);
                using (var command = Command(tx, pinned))
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        if (counts.TryGetValue(reader.GetString(0), out var total))
                            counts[reader.GetString(0)] = total - reader.GetInt64(1);
                return counts.Where(pair => pair.Value > 0).ToDictionary(StringComparer.Ordinal);
            });
    }

    public CatalogPage GroupPage(
        string by,
        string key,
        string mode,
        int limit,
        JsonArray? after,
        string? exclude
    )
    {
        var column = GroupColumn(by);
        var tree = mode != "flat-time";
        if (!Storable(key))
            return new([], false);
        using (gate.Enter())
        {
            // Tree modes order members by subtree activity, Flat by each Session's own time.
            var columns = SessionCatalog.OrderColumns(mode, true, tree);
            var args = new Arguments();
            // Both term forms are stated so either the partial or the generated-column index applies.
            var terms = new List<string> { $"{column}={args.Add(key)}", "pinned=0", "pinned_rank=1" };
            if (tree)
                terms.Add("parent_session_id IS NULL AND presentation_root=1");
            // A key PostgreSQL can't store (the main ID of an invalid Agent name) excludes nothing.
            if (exclude is not null && Storable(exclude))
                terms.Add("session_id<>" + args.Add(exclude));
            if (after is not null)
                terms.Add(Keyset(args, columns, after));
            var sql =
                $"SELECT {Columns} FROM session_catalog WHERE "
                + string.Join(" AND ", terms)
                + " ORDER BY "
                + string.Join(',', columns)
                + " LIMIT "
                + args.Add((long)limit + 1);
            var rows = Read(tx => Rows(tx, sql, args.ToArray()));
            return new(rows.Take(limit).ToArray(), rows.Count > limit);
        }
    }

    public Dictionary<string, string> GroupKeys(string[] ids, string by)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (ids.Length == 0)
            return result;
        if (ids.Length > 200)
            throw new InvalidDataException("Group key batch exceeds 200 IDs.");
        var column = GroupColumn(by);
        var keys = StorableIds(ids);
        if (keys.Length == 0)
            return result;
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, 
                    $"SELECT session_id,{column} FROM session_catalog WHERE session_id = ANY($1)",
                    TextArray(keys)
                );
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    result[reader.GetString(0)] = reader.GetString(1);
                return result;
            });
    }

    // ---- Activity -----------------------------------------------------------------------

    public Dictionary<string, double> SubtreeTimes(string[] ids)
    {
        var result = new Dictionary<string, double>(StringComparer.Ordinal);
        if (ids.Length == 0)
            return result;
        if (ids.Length > 200)
            throw new InvalidDataException("Subtree activity batch exceeds 200 IDs.");
        var keys = StorableIds(ids);
        if (keys.Length == 0)
            return result;
        using (gate.Enter())
            return Read(tx =>
            {
                using var command = Command(tx, 
                    "SELECT session_id,subtree_time FROM session_catalog WHERE session_id = ANY($1)",
                    TextArray(keys)
                );
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    result[reader.GetString(0)] = reader.GetDouble(1);
                return result;
            });
    }

    public Dictionary<string, int> RecentChildCounts(string[] parents, double since, int cap)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        if (parents.Length == 0)
            return result;
        if (parents.Length > 100)
            throw new InvalidDataException("Recent child count batch exceeds 100 parents.");
        var keys = StorableIds(parents);
        if (keys.Length == 0)
            return result;
        using (gate.Enter())
        {
            var args = new Arguments();
            var rank = args.Add(-since);
            var take = args.Add((long)cap);
            var branches = keys.Select(parent =>
            {
                var name = args.Add(parent);
                return $"SELECT {name}::text AS parent,(SELECT count(*) FROM (SELECT 1 FROM session_catalog WHERE parent_session_id={name} AND pinned=0 AND archived=0 AND subtree_rank<={rank} LIMIT {take}) recent) AS recent";
            });
            var sql = string.Join(" UNION ALL ", branches);
            return Read(tx =>
            {
                using var command = Command(tx, sql, args.ToArray());
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    result[reader.GetString(0)] = checked((int)reader.GetInt64(1));
                return result;
            });
        }
    }
}
