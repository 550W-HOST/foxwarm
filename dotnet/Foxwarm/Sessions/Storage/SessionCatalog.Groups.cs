using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

// Sidebar Agent/Node grouping. Groups are presentation only: membership comes from a row's
// own Agent or current Node, and real parent relations stay authoritative everywhere.
internal sealed partial class SessionCatalog
{
    // Objects of an earlier Sidebar design that grouped rows under their Agent's main
    // Session. They are retired: dropped on open, while their unused `sidebar_parent`
    // column stays so the schema version is unchanged.
    private const string RetiredSidebarSql = """
    DROP TRIGGER IF EXISTS session_catalog_sidebar_insert;
    DROP TRIGGER IF EXISTS session_catalog_sidebar_delete;
    DROP TRIGGER IF EXISTS session_catalog_sidebar_topology;
    DROP TRIGGER IF EXISTS session_catalog_sidebar_count_update;
    DROP INDEX IF EXISTS idx_session_catalog_sidebar_default;
    DROP INDEX IF EXISTS idx_session_catalog_sidebar_time;
    DROP TABLE IF EXISTS catalog_sidebar_count;
    DROP TABLE IF EXISTS catalog_sidebar_agent;
    DROP TABLE IF EXISTS catalog_sidebar_host;
    DROP TABLE IF EXISTS catalog_sidebar_dirty;
""";

    // Additive objects on the version-3 catalog. Older Mains ignore them, and their row
    // writes still fire the count triggers, so the maintained Node counts stay exact.
    // Group root pages use partial indexes over unpinned top-level rows.
    private const string GroupObjectsSql = """
    CREATE INDEX IF NOT EXISTS idx_session_catalog_agent_root_default ON session_catalog(agent,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
    CREATE INDEX IF NOT EXISTS idx_session_catalog_node_root_default ON session_catalog(current_node,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
    CREATE INDEX IF NOT EXISTS idx_session_catalog_node_root_time ON session_catalog(current_node,archived,recent_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
    CREATE INDEX IF NOT EXISTS idx_session_catalog_node_time ON session_catalog(current_node,archived,recent_rank,session_id) WHERE pinned=0;
    CREATE TABLE IF NOT EXISTS catalog_node_count (current_node TEXT PRIMARY KEY, session_count INTEGER NOT NULL, root_count INTEGER NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS session_catalog_node_count_insert AFTER INSERT ON session_catalog BEGIN
      INSERT INTO catalog_node_count(current_node,session_count,root_count)
        VALUES(new.current_node,1,CASE WHEN new.parent_session_id IS NULL THEN 1 ELSE 0 END)
        ON CONFLICT(current_node) DO UPDATE SET session_count=session_count+1,
          root_count=root_count+CASE WHEN new.parent_session_id IS NULL THEN 1 ELSE 0 END;
    END;
    CREATE TRIGGER IF NOT EXISTS session_catalog_node_count_delete AFTER DELETE ON session_catalog BEGIN
      UPDATE catalog_node_count SET session_count=session_count-1,
        root_count=root_count-CASE WHEN old.parent_session_id IS NULL THEN 1 ELSE 0 END
        WHERE current_node=old.current_node;
      DELETE FROM catalog_node_count WHERE current_node=old.current_node AND session_count=0;
    END;
    CREATE TRIGGER IF NOT EXISTS session_catalog_node_count_update AFTER UPDATE OF current_node,parent_session_id ON session_catalog
    WHEN old.current_node<>new.current_node OR (old.parent_session_id IS NULL)<>(new.parent_session_id IS NULL) BEGIN
      UPDATE catalog_node_count SET session_count=session_count-1,
        root_count=root_count-CASE WHEN old.parent_session_id IS NULL THEN 1 ELSE 0 END
        WHERE current_node=old.current_node;
      DELETE FROM catalog_node_count WHERE current_node=old.current_node AND session_count=0;
      INSERT INTO catalog_node_count(current_node,session_count,root_count)
        VALUES(new.current_node,1,CASE WHEN new.parent_session_id IS NULL THEN 1 ELSE 0 END)
        ON CONFLICT(current_node) DO UPDATE SET session_count=session_count+1,
          root_count=root_count+CASE WHEN new.parent_session_id IS NULL THEN 1 ELSE 0 END;
    END;
""";

    // The canonical main Session ID; a legacy invalid Agent name cannot have one.
    internal static string AgentMainId(string agent)
    {
        try
        {
            return SessionIdentity.Build(agent, "main");
        }
        catch (InvalidDataException)
        {
            return "\0";
        }
    }

    /// <summary>
    /// Retires the earlier Sidebar objects and adds the grouping objects when missing,
    /// filling the Node counts once when their table is created. Idempotent; the schema
    /// version is unchanged.
    /// </summary>
    private static void EnsureGroupObjects(SqliteConnection connection)
    {
        Execute(connection, "BEGIN IMMEDIATE");
        try
        {
            Execute(connection, RetiredSidebarSql);
            var counted =
                Scalar(
                    connection,
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_node_count'"
                )
                is not null;
            Execute(connection, GroupObjectsSql);
            if (!counted)
                Execute(
                    connection,
                    "INSERT INTO catalog_node_count(current_node,session_count,root_count) "
                        + "SELECT current_node,count(*),sum(CASE WHEN parent_session_id IS NULL THEN 1 ELSE 0 END) "
                        + "FROM session_catalog GROUP BY current_node"
                );
            Execute(connection, "COMMIT");
        }
        catch
        {
            Execute(connection, "ROLLBACK");
            throw;
        }
    }

    private static string GroupColumn(string by) =>
        by switch
        {
            "agent" => "agent",
            "node" => "current_node",
            _ => throw new InvalidDataException("Unknown Session group."),
        };

    /// <summary>
    /// Member counts of every non-empty group. Tree modes count unpinned top-level rows,
    /// Flat counts every unpinned row. Maintained counts minus the pinned rows, which
    /// form their own Sidebar section.
    /// </summary>
    internal Dictionary<string, long> GroupCounts(string by, bool tree)
    {
        var column = GroupColumn(by);
        lock (gate)
        {
            EnsureInitialized();
            var counts = new Dictionary<string, long>(StringComparer.Ordinal);
            var sql =
                by == "agent"
                    ? tree
                        ? "SELECT agent,session_count FROM catalog_parent_agent_count WHERE parent_key=''"
                        : "SELECT agent,session_count FROM catalog_agent_count"
                    : tree
                        ? "SELECT current_node,root_count FROM catalog_node_count"
                        : "SELECT current_node,session_count FROM catalog_node_count";
            using (var command = Command(db!, sql))
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    counts[reader.GetString(0)] = reader.GetInt64(1);
            QueryObserved?.Invoke(sql, counts.Count);
            // Every pinned row is a presentation root; the pinned range of this index is small.
            var pinned =
                $"SELECT {column},count(*) FROM session_catalog INDEXED BY idx_session_catalog_root_time "
                + "WHERE presentation_root=1 AND pinned_rank=0"
                + (tree ? " AND parent_session_id IS NULL" : "")
                + $" GROUP BY {column}";
            using (var command = Command(db!, pinned))
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    if (counts.TryGetValue(reader.GetString(0), out var total))
                        counts[reader.GetString(0)] = total - reader.GetInt64(1);
            QueryObserved?.Invoke(pinned, counts.Count);
            return counts.Where(pair => pair.Value > 0).ToDictionary(StringComparer.Ordinal);
        }
    }

    /// <summary>
    /// One keyset page of a group's members in Sidebar order: unpinned top-level rows in
    /// tree modes, every unpinned row in Flat. <paramref name="exclude"/> omits a row the
    /// caller places separately (an Agent's main Session).
    /// </summary>
    internal CatalogPage GroupPage(
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
        lock (gate)
        {
            var columns = OrderColumns(mode, true);
            var args = new List<object?>();
            string Param(object? value)
            {
                args.Add(value);
                return "$p" + (args.Count - 1);
            }
            var index = (by, mode) switch
            {
                ("agent", "default") => "idx_session_catalog_agent_root_default",
                ("agent", "time") => "idx_session_catalog_agent_root_time",
                ("agent", _) => "idx_session_catalog_agent_time",
                ("node", "default") => "idx_session_catalog_node_root_default",
                ("node", "time") => "idx_session_catalog_node_root_time",
                _ => "idx_session_catalog_node_time",
            };
            // Both term forms are stated so either the partial or the generated-column index applies.
            var terms = new List<string> { $"{column}={Param(key)}", "pinned=0", "pinned_rank=1" };
            if (tree)
                terms.Add("parent_session_id IS NULL AND presentation_root=1");
            if (exclude is not null)
                terms.Add("session_id<>" + Param(exclude));
            if (after is not null)
                terms.Add(
                    "("
                        + string.Join(',', columns)
                        + ")>("
                        + string.Join(',', CursorArgs(after).Select(Param))
                        + ")"
                );
            var sql =
                $"SELECT {Columns} FROM session_catalog INDEXED BY {index} WHERE "
                + string.Join(" AND ", terms)
                + " ORDER BY "
                + string.Join(',', columns)
                + " LIMIT "
                + Param(limit + 1);
            var rows = Rows(sql, args.ToArray());
            return new(rows.Take(limit).ToArray(), rows.Count > limit);
        }
    }

    /// <summary>The group key (Agent or current Node) of each existing row.</summary>
    internal Dictionary<string, string> GroupKeys(string[] ids, string by)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (ids.Length == 0)
            return result;
        if (ids.Length > 200)
            throw new InvalidDataException("Group key batch exceeds 200 IDs.");
        var column = GroupColumn(by);
        lock (gate)
        {
            EnsureInitialized();
            var sql =
                $"SELECT session_id,{column} FROM session_catalog WHERE session_id IN ({Parameters(ids.Length)})";
            using var command = Command(db!, sql, ids.Cast<object?>().ToArray());
            using var reader = command.ExecuteReader();
            while (reader.Read())
                result[reader.GetString(0)] = reader.GetString(1);
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }
}
