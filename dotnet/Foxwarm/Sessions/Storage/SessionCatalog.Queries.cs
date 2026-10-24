using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record CatalogPage(JsonObject[] Rows, bool HasMore);

internal sealed record CatalogChildren(string Parent, JsonObject[] Rows, long Total, bool HasMore);

internal sealed partial class SessionCatalog
{
    internal string[] RestartIds()
    {
        lock (gate)
        {
            EnsureInitialized();
            using var command = Command(
                db!,
                "SELECT session_id FROM session_catalog WHERE busy=1 UNION SELECT session_id FROM session_catalog WHERE queue_length>0 UNION SELECT session_id FROM session_catalog WHERE managed_pending_count>0"
            );
            using var reader = command.ExecuteReader();
            var ids = new List<string>();
            while (reader.Read())
                ids.Add(reader.GetString(0));
            return ids.ToArray();
        }
    }

    internal string[] RecentWaitIds(long activityCutoff)
    {
        lock (gate)
        {
            EnsureInitialized();
            const string sql =
                "SELECT session_id FROM session_catalog WHERE recent_rank<=-$p0 AND json_type(metadata_json,'$.meta.wait.id')='text'";
            using var command = Command(db!, sql, activityCutoff);
            using var reader = command.ExecuteReader();
            var ids = new List<string>();
            while (reader.Read())
                ids.Add(reader.GetString(0));
            QueryObserved?.Invoke(sql, ids.Count);
            return ids.ToArray();
        }
    }

    private static string[] OrderColumns(string mode, bool child = false) =>
        child
            ? mode == "default"
                ?
                [
                    "archived",
                    "sidebar_order_missing",
                    "sidebar_order_value",
                    "recent_rank",
                    "session_id",
                ]
                : ["archived", "recent_rank", "session_id"]
            : mode == "default"
                ?
                [
                    "pinned_rank",
                    "archived",
                    "sidebar_order_missing",
                    "sidebar_order_value",
                    "recent_rank",
                    "session_id",
                ]
                : ["pinned_rank", "archived", "recent_rank", "session_id"];

    private static object?[] CursorArgs(JsonArray key) =>
        key.Select((value, index) => index == key.Count - 1 ? (object?)Text(value) : Number(value))
            .ToArray();

    internal long Count(string? agent = null, string? parent = null)
    {
        lock (gate)
        {
            EnsureInitialized();
            return Convert.ToInt64(
                parent is not null
                    ? Scalar(
                        db!,
                        "SELECT session_count FROM catalog_parent_count WHERE parent_key=$p0",
                        parent
                    ) ?? 0
                : agent is null
                    ? Scalar(db!, "SELECT session_count FROM catalog_count WHERE singleton=1")
                : Scalar(
                    db!,
                    "SELECT session_count FROM catalog_agent_count WHERE agent=$p0",
                    agent
                ) ?? 0
            );
        }
    }

    internal JsonObject[] OffsetPage(
        int limit,
        int offset,
        string? agent = null,
        string? parent = null
    )
    {
        lock (gate)
        {
            var terms = new List<string>();
            var args = new List<object?>();
            string Param(object? value)
            {
                args.Add(value);
                return "$p" + (args.Count - 1);
            }
            if (agent is not null)
                terms.Add("agent=" + Param(agent));
            if (parent is not null)
                terms.Add("parent_session_id=" + Param(parent));
            return Rows(
                    $"SELECT {Columns} FROM session_catalog"
                        + (terms.Count > 0 ? " WHERE " + string.Join(" AND ", terms) : "")
                        + " ORDER BY recent_rank,session_id LIMIT "
                        + Param(limit)
                        + " OFFSET "
                        + Param(offset),
                    args.ToArray()
                )
                .ToArray();
        }
    }

    internal CatalogPage Page(string mode, int limit, JsonArray? after, bool roots, string? agent)
    {
        lock (gate)
        {
            var columns = OrderColumns(mode);
            var terms = new List<string>();
            var args = new List<object?>();
            string Param(object? value)
            {
                args.Add(value);
                return "$p" + (args.Count - 1);
            }
            var forest = agent is not null && roots;
            if (agent is not null)
                terms.Add("c.agent=" + Param(agent));
            if (forest)
                terms.Add(
                    "(c.parent_session_id IS NULL OR parent.session_id IS NULL OR parent.agent<>c.agent)"
                );
            else if (roots && mode != "flat-time")
                terms.Add("c.presentation_root=1");
            if (after is not null)
                terms.Add(
                    "("
                        + string.Join(',', columns.Select(column => "c." + column))
                        + ")>("
                        + string.Join(',', CursorArgs(after).Select(Param))
                        + ")"
                );
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
                + Param(limit + 1);
            var rows = Rows(sql, args.ToArray());
            return new(rows.Take(limit).ToArray(), rows.Count > limit);
        }
    }

    internal CatalogChildren[] Children(
        IReadOnlyList<(string Id, JsonArray? After)> requests,
        string mode,
        int limit,
        string? agent
    )
    {
        if (requests.Count == 0)
            return [];
        if (requests.Count > 100)
            throw new InvalidDataException("Catalog child batch exceeds 100 parents.");
        if (agent is not null && mode != "time")
            throw new InvalidDataException("Agent forest children require time mode.");
        lock (gate)
        {
            EnsureInitialized();
            var columns = OrderColumns(mode, true);
            var args = new List<object?>();
            var branches = new List<string>();
            string Param(object? value)
            {
                args.Add(value);
                return "$p" + (args.Count - 1);
            }
            var index =
                agent is not null ? "idx_session_catalog_parent_agent_architecture"
                : mode == "default" ? "idx_session_catalog_parent_default"
                : "idx_session_catalog_parent_time";
            foreach (var request in requests)
            {
                var where =
                    "parent_session_id="
                    + Param(request.Id)
                    + (agent is null ? " AND pinned=0" : " AND agent=" + Param(agent));
                if (request.After is not null)
                    where +=
                        " AND ("
                        + string.Join(',', columns)
                        + ")>("
                        + string.Join(',', CursorArgs(request.After).Select(Param))
                        + ")";
                branches.Add(
                    $"SELECT * FROM (SELECT {Columns},parent_session_id FROM session_catalog INDEXED BY {index} WHERE {where} ORDER BY {string.Join(',', columns)} LIMIT {Param(limit + 1)})"
                );
            }
            var sql = string.Join(" UNION ALL ", branches);
            var grouped = new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal);
            var count = 0;
            using (var command = Command(db!, sql, args.ToArray()))
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                {
                    var parent = reader.GetString(4);
                    if (!grouped.TryGetValue(parent, out var group))
                        grouped[parent] = group = [];
                    var row = JsonNode.Parse(reader.GetString(0))!.AsObject();
                    row["busy"] = reader.GetInt64(1) == 1;
                    row["queueLength"] = reader.GetInt64(2);
                    row["managedPendingCount"] = reader.GetInt64(3);
                    group.Add(row);
                    count++;
                }
            QueryObserved?.Invoke(sql, count);
            var totals = ChildCounts(requests.Select(request => request.Id).ToArray(), agent);
            return requests
                .Select(request =>
                {
                    var group = grouped.GetValueOrDefault(request.Id) ?? [];
                    return new CatalogChildren(
                        request.Id,
                        group.Take(limit).ToArray(),
                        totals.GetValueOrDefault(request.Id),
                        group.Count > limit
                    );
                })
                .ToArray();
        }
    }

    internal Dictionary<string, long> ChildCounts(string[] ids, string? agent = null)
    {
        if (ids.Length == 0)
            return new(StringComparer.Ordinal);
        if (ids.Length > 4096)
            throw new InvalidDataException("Catalog child counts exceed 4096 IDs.");
        lock (gate)
        {
            EnsureInitialized();
            var args = (
                agent is null ? ids.Cast<object?>() : new object?[] { agent }.Concat(ids)
            ).ToArray();
            var sql = agent is null
                ? $"SELECT parent_key,unpinned_session_count FROM catalog_parent_count WHERE parent_key IN ({Parameters(ids.Length)})"
                : $"SELECT parent_key,session_count FROM catalog_parent_agent_count WHERE agent=$p0 AND parent_key IN ({Parameters(ids.Length, 1)})";
            using var command = Command(db!, sql, args);
            using var reader = command.ExecuteReader();
            var result = new Dictionary<string, long>(StringComparer.Ordinal);
            while (reader.Read())
                result[reader.GetString(0)] = reader.GetInt64(1);
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }

    internal Dictionary<string, JsonObject> Scopes(string[] ids)
    {
        if (ids.Length == 0)
            return new(StringComparer.Ordinal);
        if (ids.Length > 200)
            throw new InvalidDataException("Scope batch exceeds 200 IDs.");
        lock (gate)
        {
            EnsureInitialized();
            var sql =
                $"SELECT c.session_id,c.parent_session_id,parent.agent,c.pinned,c.agent FROM session_catalog c LEFT JOIN session_catalog parent ON parent.session_id=c.parent_session_id WHERE c.session_id IN ({Parameters(ids.Length)})";
            using var command = Command(db!, sql, ids.Cast<object?>().ToArray());
            using var reader = command.ExecuteReader();
            var result = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            while (reader.Read())
                result[reader.GetString(0)] = new JsonObject
                {
                    ["parentSessionId"] = reader.IsDBNull(1) ? null : reader.GetString(1),
                    ["parentAgent"] = reader.IsDBNull(2) ? null : reader.GetString(2),
                    ["pinned"] = reader.GetInt64(3) == 1,
                    ["agent"] = reader.GetString(4),
                };
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }

    internal Dictionary<string, JsonObject> ResolveMany(string[] ids)
    {
        if (ids.Length == 0)
            return new(StringComparer.Ordinal);
        if (ids.Length > 200)
            throw new InvalidDataException("Alias batch exceeds 200 IDs.");
        lock (gate)
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
            var sql =
                $"SELECT alias,session_id FROM session_alias WHERE alias IN ({Parameters(ids.Length)}) ORDER BY alias,session_id";
            using var command = Command(db!, sql, ids.Cast<object?>().ToArray());
            using var reader = command.ExecuteReader();
            var owners = new Dictionary<string, JsonArray>(StringComparer.Ordinal);
            var count = 0;
            while (reader.Read())
            {
                var alias = reader.GetString(0);
                if (!owners.TryGetValue(alias, out var owner))
                    owners[alias] = owner = new();
                if (owner.Count < 2)
                    owner.Add(reader.GetString(1));
                count++;
            }
            QueryObserved?.Invoke(sql, count);
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
        }
    }

    internal Dictionary<string, string[]> Paths(string[] ids)
    {
        if (ids.Length == 0)
            return new(StringComparer.Ordinal);
        if (ids.Length > 100)
            throw new InvalidDataException("Path batch exceeds 100 IDs.");
        lock (gate)
        {
            EnsureInitialized();
            var sql = $"""
WITH RECURSIVE paths(focus_id,session_id,parent_session_id,depth,trail) AS (
SELECT session_id,session_id,parent_session_id,0,'|'||hex(session_id)||'|' FROM session_catalog WHERE session_id IN ({Parameters(
                    ids.Length
                )})
UNION ALL SELECT paths.focus_id,parent.session_id,parent.parent_session_id,paths.depth+1,paths.trail||hex(parent.session_id)||'|'
FROM paths JOIN session_catalog parent ON parent.session_id=paths.parent_session_id
WHERE paths.depth<127 AND instr(paths.trail,'|'||hex(parent.session_id)||'|')=0)
SELECT focus_id,session_id,depth FROM paths ORDER BY focus_id,depth DESC
""";
            using var command = Command(db!, sql, ids.Cast<object?>().ToArray());
            using var reader = command.ExecuteReader();
            var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var count = 0;
            while (reader.Read())
            {
                var focus = reader.GetString(0);
                if (!result.TryGetValue(focus, out var path))
                    result[focus] = path = [];
                path.Add(reader.GetString(1));
                count++;
            }
            QueryObserved?.Invoke(sql, count);
            return result.ToDictionary(
                pair => pair.Key,
                pair => pair.Value.ToArray(),
                StringComparer.Ordinal
            );
        }
    }

    internal JsonObject Summary()
    {
        lock (gate)
        {
            EnsureInitialized();
            var sql =
                "SELECT session_count,busy_count,queued_count,managed_count,cached_tokens,input_tokens,output_tokens FROM catalog_count WHERE singleton=1";
            using var command = Command(db!, sql);
            using var reader = command.ExecuteReader();
            reader.Read();
            var result = new JsonObject();
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
            for (var index = 0; index < keys.Length; index++)
                result[keys[index]] = reader.GetInt64(index);
            QueryObserved?.Invoke(sql, 1);
            return result;
        }
    }

    internal Dictionary<string, (int Total, int Active, int Queued)> AgentActivityCounts()
    {
        lock (gate)
        {
            EnsureInitialized();
            var result = new Dictionary<string, (int Total, int Active, int Queued)>(
                StringComparer.Ordinal
            );
            using (
                var command = Command(db!, "SELECT agent,session_count FROM catalog_agent_count")
            )
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    result[reader.GetString(0)] = (reader.GetInt32(1), 0, 0);
            using (
                var command = Command(
                    db!,
                    "SELECT agent,COUNT(*) FROM session_catalog WHERE busy=1 GROUP BY agent"
                )
            )
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                {
                    var agent = reader.GetString(0);
                    var value = result[agent];
                    result[agent] = (value.Total, reader.GetInt32(1), value.Queued);
                }
            using (
                var command = Command(
                    db!,
                    "SELECT agent,COUNT(*) FROM session_catalog WHERE queue_length>0 GROUP BY agent"
                )
            )
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                {
                    var agent = reader.GetString(0);
                    var value = result[agent];
                    result[agent] = (value.Total, value.Active, reader.GetInt32(1));
                }
            return result;
        }
    }

    internal JsonArray AgentCounts()
    {
        lock (gate)
        {
            EnsureInitialized();
            const string sql = "SELECT agent,session_count FROM catalog_agent_count ORDER BY agent";
            using var command = Command(db!, sql);
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
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }

    private const string DescendantCte =
        "WITH RECURSIVE subtree(session_id) AS (VALUES($p0) UNION SELECT child.session_id FROM session_catalog child JOIN subtree ON child.parent_session_id=subtree.session_id) ";

    internal (JsonObject Summary, JsonObject[] Rows) Descendants(string id, int limit)
    {
        lock (gate)
        {
            EnsureInitialized();
            var sql =
                DescendantCte
                + $"""
, descendants AS (SELECT c.*,count(*) OVER() total,sum(c.busy) OVER() busyTotal,
sum(CASE WHEN c.queue_length>0 THEN 1 ELSE 0 END) OVER() queuedTotal,
sum(c.cached_tokens) OVER() cachedTokens,sum(c.input_tokens) OVER() inputTokens,sum(c.output_tokens) OVER() outputTokens
FROM session_catalog c JOIN subtree s ON s.session_id=c.session_id WHERE c.session_id<>$p0)
SELECT {Columns},total,busyTotal,queuedTotal,cachedTokens,inputTokens,outputTokens FROM descendants ORDER BY recent_rank,session_id LIMIT $p1
""";
            using var command = Command(db!, sql, id, limit);
            using var reader = command.ExecuteReader();
            var rows = new List<JsonObject>();
            var summary = new JsonObject
            {
                ["total"] = 0,
                ["busy"] = 0,
                ["queued"] = 0,
                ["cachedTokens"] = 0,
                ["inputTokens"] = 0,
                ["outputTokens"] = 0,
            };
            var keys = summary.Select(pair => pair.Key).ToArray();
            while (reader.Read())
            {
                var row = JsonNode.Parse(reader.GetString(0))!.AsObject();
                row["busy"] = reader.GetInt64(1) == 1;
                row["queueLength"] = reader.GetInt64(2);
                row["managedPendingCount"] = reader.GetInt64(3);
                rows.Add(row);
                for (var index = 0; index < keys.Length; index++)
                    summary[keys[index]] = reader.GetInt64(index + 4);
            }
            QueryObserved?.Invoke(sql, rows.Count);
            return (summary, rows.ToArray());
        }
    }

    internal HashSet<string> FilterDescendants(string id, string[] candidates)
    {
        if (candidates.Length == 0)
            return new(StringComparer.Ordinal);
        lock (gate)
        {
            EnsureInitialized();
            var sql =
                DescendantCte
                + $"SELECT session_id FROM subtree WHERE session_id<>$p0 AND session_id IN ({Parameters(candidates.Length, 1)})";
            using var command = Command(
                db!,
                sql,
                new object?[] { id }
                    .Concat(candidates)
                    .ToArray()
            );
            using var reader = command.ExecuteReader();
            var result = new HashSet<string>(StringComparer.Ordinal);
            while (reader.Read())
                result.Add(reader.GetString(0));
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }

    internal Dictionary<string, int> BusyDescendants(string[] roots, string[] busy)
    {
        var result = roots.ToDictionary(id => id, _ => 0, StringComparer.Ordinal);
        if (roots.Length == 0 || busy.Length == 0)
            return result;
        lock (gate)
        {
            EnsureInitialized();
            var sql = $"""
WITH RECURSIVE ancestors(busy_id,session_id,parent_session_id,trail) AS (
SELECT session_id,session_id,parent_session_id,'|'||hex(session_id)||'|' FROM session_catalog WHERE session_id IN ({Parameters(
                    busy.Length
                )})
UNION ALL SELECT a.busy_id,p.session_id,p.parent_session_id,a.trail||hex(p.session_id)||'|' FROM ancestors a JOIN session_catalog p ON p.session_id=a.parent_session_id
WHERE instr(a.trail,'|'||hex(p.session_id)||'|')=0)
SELECT session_id,count(DISTINCT busy_id) FROM ancestors WHERE session_id<>busy_id AND session_id IN ({Parameters(
                    roots.Length,
                    busy.Length
                )}) GROUP BY session_id
""";
            using var command = Command(db!, sql, busy.Cast<object?>().Concat(roots).ToArray());
            using var reader = command.ExecuteReader();
            while (reader.Read())
                result[reader.GetString(0)] = reader.GetInt32(1);
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }
}
