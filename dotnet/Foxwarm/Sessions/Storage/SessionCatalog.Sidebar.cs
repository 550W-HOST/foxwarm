using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

// Sidebar presentation parents. The real parent relation stays authoritative for every
// other consumer; this projection only decides where a row is shown in the Sidebar tree.
internal sealed partial class SessionCatalog
{
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

    // Additive objects on the version-3 catalog. An older Main ignores them; its row
    // changes still fire the triggers, and opening with this Main reconciles everything.
    private const string SidebarObjectsSql = """
    CREATE TABLE IF NOT EXISTS catalog_sidebar_count (parent_key TEXT PRIMARY KEY, session_count INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS catalog_sidebar_agent (agent TEXT PRIMARY KEY, target TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS catalog_sidebar_host (session_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS catalog_sidebar_dirty (session_id TEXT NOT NULL, agent TEXT NOT NULL,
      PRIMARY KEY(session_id,agent)) STRICT;
    CREATE TRIGGER IF NOT EXISTS session_catalog_sidebar_insert AFTER INSERT ON session_catalog BEGIN
      INSERT INTO catalog_sidebar_dirty(session_id,agent) SELECT new.session_id,new.agent WHERE NOT EXISTS(SELECT 1 FROM catalog_sidebar_dirty WHERE session_id=new.session_id AND agent=new.agent);
      INSERT INTO catalog_sidebar_count(parent_key,session_count) SELECT new.sidebar_parent,1
        WHERE new.sidebar_parent IS NOT NULL
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE TRIGGER IF NOT EXISTS session_catalog_sidebar_delete AFTER DELETE ON session_catalog BEGIN
      INSERT INTO catalog_sidebar_dirty(session_id,agent) SELECT old.session_id,old.agent WHERE NOT EXISTS(SELECT 1 FROM catalog_sidebar_dirty WHERE session_id=old.session_id AND agent=old.agent);
      UPDATE catalog_sidebar_count SET session_count=session_count-1 WHERE parent_key=old.sidebar_parent;
      DELETE FROM catalog_sidebar_count WHERE parent_key=old.sidebar_parent AND session_count=0;
    END;
    CREATE TRIGGER IF NOT EXISTS session_catalog_sidebar_topology AFTER UPDATE OF agent,parent_session_id,pinned ON session_catalog
    WHEN old.agent<>new.agent OR old.parent_session_id IS NOT new.parent_session_id OR old.pinned<>new.pinned BEGIN
      INSERT INTO catalog_sidebar_dirty(session_id,agent) SELECT old.session_id,old.agent WHERE NOT EXISTS(SELECT 1 FROM catalog_sidebar_dirty WHERE session_id=old.session_id AND agent=old.agent);
      INSERT INTO catalog_sidebar_dirty(session_id,agent) SELECT new.session_id,new.agent WHERE NOT EXISTS(SELECT 1 FROM catalog_sidebar_dirty WHERE session_id=new.session_id AND agent=new.agent);
    END;
    CREATE TRIGGER IF NOT EXISTS session_catalog_sidebar_count_update AFTER UPDATE OF sidebar_parent ON session_catalog
    WHEN old.sidebar_parent IS NOT new.sidebar_parent BEGIN
      UPDATE catalog_sidebar_count SET session_count=session_count-1 WHERE parent_key=old.sidebar_parent;
      DELETE FROM catalog_sidebar_count WHERE parent_key=old.sidebar_parent AND session_count=0;
      INSERT INTO catalog_sidebar_count(parent_key,session_count) SELECT new.sidebar_parent,1
        WHERE new.sidebar_parent IS NOT NULL
        ON CONFLICT(parent_key) DO UPDATE SET session_count=session_count+1;
    END;
    CREATE INDEX IF NOT EXISTS idx_session_catalog_sidebar_default ON session_catalog(sidebar_parent,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
    CREATE INDEX IF NOT EXISTS idx_session_catalog_sidebar_time ON session_catalog(sidebar_parent,pinned_rank,archived,recent_rank,session_id);
""";

    // The presentation parent of every row once hosts and per-Agent targets are stored;
    // RefreshSidebar applies the same rule row by row.
    private const string SidebarParentSql = """
    CASE WHEN c.pinned=1 THEN NULL WHEN c.parent_session_id IS NOT NULL THEN c.parent_session_id
      WHEN EXISTS(SELECT 1 FROM catalog_sidebar_host h WHERE h.session_id=c.session_id) THEN NULL
      ELSE (SELECT NULLIF(a.target,c.session_id) FROM catalog_sidebar_agent a WHERE a.agent=c.agent) END
""";

    /// <summary>
    /// Adds the Sidebar objects when missing (the schema version is unchanged) and
    /// recomputes every presentation parent and count, repairing anything a Main
    /// that does not maintain them, or maintains them by other rules, wrote meanwhile.
    /// Runs inside the caller's transaction.
    /// </summary>
    private static void EnsureSidebar(SqliteConnection connection)
    {
        if (
            Scalar(
                connection,
                "SELECT 1 FROM pragma_table_info('session_catalog') WHERE name='sidebar_parent'"
            )
            is null
        )
            Execute(connection, "ALTER TABLE session_catalog ADD COLUMN sidebar_parent TEXT");
        Execute(connection, SidebarObjectsSql);
        Execute(
            connection,
            "DELETE FROM catalog_sidebar_dirty; DELETE FROM catalog_sidebar_host; DELETE FROM catalog_sidebar_agent"
        );
        foreach (var host in SidebarHosts(connection))
            Execute(connection, "INSERT INTO catalog_sidebar_host(session_id) VALUES($p0)", host);
        var agents = new List<string>();
        using (var command = Command(connection, "SELECT agent FROM catalog_agent_count"))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                agents.Add(reader.GetString(0));
        foreach (var agent in agents)
            Execute(
                connection,
                "INSERT INTO catalog_sidebar_agent(agent,target) VALUES($p0,$p1)",
                agent,
                SidebarTarget(connection, agent)
            );
        Execute(
            connection,
            $"UPDATE session_catalog AS c SET sidebar_parent={SidebarParentSql} WHERE c.sidebar_parent IS NOT {SidebarParentSql}"
        );
        Execute(
            connection,
            "DELETE FROM catalog_sidebar_count; INSERT INTO catalog_sidebar_count(parent_key,session_count) "
                + "SELECT sidebar_parent,count(*) FROM session_catalog WHERE sidebar_parent IS NOT NULL GROUP BY sidebar_parent"
        );
    }

    private static void EnsureSidebarTransaction(SqliteConnection connection)
    {
        Execute(connection, "BEGIN IMMEDIATE");
        try
        {
            EnsureSidebar(connection);
            Execute(connection, "COMMIT");
        }
        catch
        {
            Execute(connection, "ROLLBACK");
            throw;
        }
    }

    private static (string? Parent, bool Pinned, string Agent)? SidebarTopology(
        SqliteConnection connection,
        string id
    )
    {
        using var command = Command(
            connection,
            "SELECT parent_session_id,pinned,agent FROM session_catalog WHERE session_id=$p0",
            id
        );
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? (
                reader.IsDBNull(0) ? null : reader.GetString(0),
                reader.GetInt64(1) == 1,
                reader.GetString(2)
            )
            : null;
    }

    // A top-level row that contains an Agent's main Session in its displayed real
    // subtree stays top-level, so grouping under that main can never form a cycle.
    private static HashSet<string> SidebarHosts(SqliteConnection connection)
    {
        var hosts = new HashSet<string>(StringComparer.Ordinal);
        var agents = new List<string>();
        using (var command = Command(connection, "SELECT agent FROM catalog_agent_count"))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                agents.Add(reader.GetString(0));
        foreach (var agent in agents)
        {
            var main = AgentMainId(agent);
            var cursor = main;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (
                seen.Add(cursor)
                && seen.Count <= 128
                && SidebarTopology(connection, cursor) is { } node
            )
            {
                if (node.Pinned)
                    break;
                if (node.Parent is null)
                {
                    if (cursor != main)
                        hosts.Add(cursor);
                    break;
                }
                cursor = node.Parent;
            }
        }
        return hosts;
    }

    // The Agent main when it exists; otherwise the Agent's rows stay top-level.
    private static string? SidebarTarget(SqliteConnection connection, string agent)
    {
        var main = AgentMainId(agent);
        return
            Scalar(connection, "SELECT 1 FROM session_catalog WHERE session_id=$p0", main)
                is not null
            ? main
            : null;
    }

    /// <summary>
    /// Recomputes Sidebar presentation parents for rows whose topology changed in the
    /// current transaction. Runs before every catalog commit; without topology changes it
    /// costs one indexed probe.
    /// </summary>
    private static void RefreshSidebar(SqliteConnection connection)
    {
        if (Scalar(connection, "SELECT 1 FROM catalog_sidebar_dirty LIMIT 1") is null)
            return;
        var dirty = new List<(string Id, string Agent)>();
        using (
            var command = Command(connection, "SELECT session_id,agent FROM catalog_sidebar_dirty")
        )
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                dirty.Add((reader.GetString(0), reader.GetString(1)));
        Execute(connection, "DELETE FROM catalog_sidebar_dirty");

        (string? Parent, bool Pinned, string Agent)? Topology(string id) =>
            SidebarTopology(connection, id);

        var hosts = SidebarHosts(connection);
        var previousHosts = new HashSet<string>(StringComparer.Ordinal);
        using (var command = Command(connection, "SELECT session_id FROM catalog_sidebar_host"))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                previousHosts.Add(reader.GetString(0));
        var affected = new HashSet<string>(dirty.Select(row => row.Id), StringComparer.Ordinal);
        var affectedAgents = new HashSet<string>(
            dirty.Select(row => row.Agent),
            StringComparer.Ordinal
        );
        foreach (var id in hosts.Except(previousHosts))
        {
            Execute(connection, "INSERT INTO catalog_sidebar_host(session_id) VALUES($p0)", id);
            affected.Add(id);
        }
        foreach (var id in previousHosts.Except(hosts))
        {
            Execute(connection, "DELETE FROM catalog_sidebar_host WHERE session_id=$p0", id);
            affected.Add(id);
        }
        foreach (var id in affected)
            if (Topology(id) is { } node)
                affectedAgents.Add(node.Agent);

        var targets = new Dictionary<string, string?>(StringComparer.Ordinal);
        string? Target(string agent)
        {
            if (targets.TryGetValue(agent, out var cached))
                return cached;
            return targets[agent] = SidebarTarget(connection, agent);
        }

        foreach (var agent in affectedAgents)
        {
            var exists =
                Scalar(connection, "SELECT 1 FROM catalog_agent_count WHERE agent=$p0", agent)
                is not null;
            if (!exists)
            {
                Execute(connection, "DELETE FROM catalog_sidebar_agent WHERE agent=$p0", agent);
                continue;
            }
            var target = Target(agent);
            var stored = Scalar(
                connection,
                "SELECT COALESCE(target,'') FROM catalog_sidebar_agent WHERE agent=$p0",
                agent
            );
            if (stored is string previous && (previous.Length == 0 ? null : previous) == target)
                continue;
            Execute(
                connection,
                "INSERT INTO catalog_sidebar_agent(agent,target) VALUES($p0,$p1) ON CONFLICT(agent) DO UPDATE SET target=excluded.target",
                agent,
                target
            );
            // The main appeared or disappeared: move every groupable top-level row of this Agent.
            Execute(
                connection,
                "UPDATE session_catalog SET sidebar_parent=$p1 WHERE agent=$p0 AND presentation_root=1 AND pinned_rank=1 AND session_id<>$p2 "
                    + "AND NOT EXISTS(SELECT 1 FROM catalog_sidebar_host h WHERE h.session_id=session_catalog.session_id) AND sidebar_parent IS NOT $p1",
                agent,
                target,
                AgentMainId(agent)
            );
        }

        foreach (var id in affected)
        {
            if (Topology(id) is not { } node)
                continue;
            var value =
                node.Pinned ? null
                : node.Parent is not null ? node.Parent
                : id == AgentMainId(node.Agent) || hosts.Contains(id) ? null
                : Target(node.Agent);
            Execute(
                connection,
                "UPDATE session_catalog SET sidebar_parent=$p0 WHERE session_id=$p1 AND sidebar_parent IS NOT $p0",
                value,
                id
            );
        }
    }

    /// <summary>Sidebar presentation paths, root first.</summary>
    internal Dictionary<string, string[]> SidebarPaths(string[] ids) =>
        Paths(ids, "sidebar_parent");
}
