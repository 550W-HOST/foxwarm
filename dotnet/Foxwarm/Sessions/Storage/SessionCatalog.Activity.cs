using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

// Sidebar tree activity. `subtree_time` is the maintained maximum of a row's own
// last_message_time and the subtree_time of every row whose real parent it is, so a Session
// with recently active descendants sorts by that activity in the tree modes. It never enters
// metadata_json or the displayed last-message time. Triggers keep it exact for every writer
// (publication, parent normalization, reparent/promote, delete, identity moves).
internal sealed partial class SessionCatalog
{
    // Recomputes the chain of ancestors starting at the row named by `start` (inclusive).
    // Each chain member's new value is the running maximum, from the start upward, of that
    // member's own time and the values of its children outside the chain, so one statement is
    // exact for both increases and decreases. The cycle guard only stops tolerated legacy
    // cycles from looping; values inside a cycle are not guaranteed exact.
    private static string RefreshSubtreeSql(string start) =>
        $"""
        UPDATE session_catalog SET subtree_time=(
          WITH RECURSIVE chain(id,parent,child,depth,trail) AS (
            SELECT session_id,parent_session_id,NULL,0,'|'||hex(session_id)||'|' FROM session_catalog WHERE session_id={start}
            UNION ALL
            SELECT p.session_id,p.parent_session_id,chain.id,chain.depth+1,chain.trail||hex(p.session_id)||'|'
              FROM chain JOIN session_catalog p ON p.session_id=chain.parent
              WHERE instr(chain.trail,'|'||hex(p.session_id)||'|')=0),
          own(id,depth,v) AS (
            SELECT chain.id,chain.depth,MAX(a.last_message_time,COALESCE(
              (SELECT k.subtree_time FROM session_catalog k
                 WHERE k.parent_session_id=chain.id AND k.session_id IS NOT chain.child
                 ORDER BY k.subtree_time DESC LIMIT 1),a.last_message_time))
              FROM chain JOIN session_catalog a ON a.session_id=chain.id),
          run(id,v) AS (SELECT id,max(v) OVER (ORDER BY depth) FROM own)
          SELECT v FROM run WHERE run.id=session_catalog.session_id)
        WHERE session_id IN (
          WITH RECURSIVE chain(id,parent,trail) AS (
            SELECT session_id,parent_session_id,'|'||hex(session_id)||'|' FROM session_catalog WHERE session_id={start}
            UNION ALL
            SELECT p.session_id,p.parent_session_id,chain.trail||hex(p.session_id)||'|'
              FROM chain JOIN session_catalog p ON p.session_id=chain.parent
              WHERE instr(chain.trail,'|'||hex(p.session_id)||'|')=0)
          SELECT id FROM chain);
        """;

    // Additive objects on the version-3 catalog, created on every open when missing.
    // Older Mains ignore the column and indexes; their writes still fire the triggers.
    private static readonly string ActivityObjectsSql = $"""
        CREATE INDEX IF NOT EXISTS idx_session_catalog_parent_subtree ON session_catalog(parent_session_id,subtree_time,session_id);
        CREATE INDEX IF NOT EXISTS idx_session_catalog_root_activity ON session_catalog(presentation_root,pinned_rank,archived,subtree_rank,session_id);
        CREATE INDEX IF NOT EXISTS idx_session_catalog_root_activity_default ON session_catalog(presentation_root,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,subtree_rank,session_id);
        CREATE INDEX IF NOT EXISTS idx_session_catalog_parent_activity ON session_catalog(parent_session_id,pinned,archived,subtree_rank,session_id);
        CREATE INDEX IF NOT EXISTS idx_session_catalog_parent_activity_default ON session_catalog(parent_session_id,pinned,archived,sidebar_order_missing,sidebar_order_value,subtree_rank,session_id);
        CREATE INDEX IF NOT EXISTS idx_session_catalog_agent_root_activity ON session_catalog(agent,archived,subtree_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
        CREATE INDEX IF NOT EXISTS idx_session_catalog_agent_root_activity_default ON session_catalog(agent,archived,sidebar_order_missing,sidebar_order_value,subtree_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
        CREATE INDEX IF NOT EXISTS idx_session_catalog_node_root_activity ON session_catalog(current_node,archived,subtree_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
        CREATE INDEX IF NOT EXISTS idx_session_catalog_node_root_activity_default ON session_catalog(current_node,archived,sidebar_order_missing,sidebar_order_value,subtree_rank,session_id) WHERE parent_session_id IS NULL AND pinned=0;
        CREATE TRIGGER IF NOT EXISTS session_catalog_subtree_insert AFTER INSERT ON session_catalog BEGIN
          {RefreshSubtreeSql("new.session_id")}
        END;
        CREATE TRIGGER IF NOT EXISTS session_catalog_subtree_update AFTER UPDATE OF last_message_time,parent_session_id ON session_catalog
        WHEN old.last_message_time<>new.last_message_time OR old.parent_session_id IS NOT new.parent_session_id BEGIN
          {RefreshSubtreeSql("new.session_id")}
          {RefreshSubtreeSql("CASE WHEN old.parent_session_id IS NOT new.parent_session_id THEN old.parent_session_id END")}
        END;
        CREATE TRIGGER IF NOT EXISTS session_catalog_subtree_delete AFTER DELETE ON session_catalog BEGIN
          {RefreshSubtreeSql("old.parent_session_id")}
        END;
        """;

    // The single-pass backfill for catalogs written before the column existed. Each row's
    // value is the maximum own time over its descendant set; UNION also ends legacy cycles.
    private const string BackfillSubtreeSql = """
        UPDATE session_catalog SET subtree_time=(
          WITH RECURSIVE sub(id) AS (
            SELECT session_catalog.session_id
            UNION
            SELECT c.session_id FROM session_catalog c JOIN sub ON c.parent_session_id=sub.id)
          SELECT max(a.last_message_time) FROM session_catalog a JOIN sub ON a.session_id=sub.id);
        """;

    /// <summary>
    /// Adds the subtree activity column, its indexes and maintenance triggers when missing and
    /// backfills existing rows once. Idempotent; the schema version is unchanged.
    /// </summary>
    private static void EnsureActivityObjects(SqliteConnection connection)
    {
        Execute(connection, "BEGIN IMMEDIATE");
        try
        {
            var present =
                Scalar(
                    connection,
                    "SELECT 1 FROM pragma_table_info('session_catalog') WHERE name='subtree_time'"
                )
                is not null;
            if (!present)
            {
                Execute(
                    connection,
                    "ALTER TABLE session_catalog ADD COLUMN subtree_time REAL NOT NULL DEFAULT 0"
                );
                Execute(
                    connection,
                    "ALTER TABLE session_catalog ADD COLUMN subtree_rank REAL GENERATED ALWAYS AS(-subtree_time) VIRTUAL"
                );
                Execute(connection, BackfillSubtreeSql);
            }
            Execute(connection, ActivityObjectsSql);
            Execute(connection, "COMMIT");
        }
        catch
        {
            Execute(connection, "ROLLBACK");
            throw;
        }
    }

    /// <summary>Maintained subtree activity time of each existing row.</summary>
    internal Dictionary<string, double> SubtreeTimes(string[] ids)
    {
        var result = new Dictionary<string, double>(StringComparer.Ordinal);
        if (ids.Length == 0)
            return result;
        if (ids.Length > 200)
            throw new InvalidDataException("Subtree activity batch exceeds 200 IDs.");
        lock (gate)
        {
            EnsureInitialized();
            var sql =
                $"SELECT session_id,subtree_time FROM session_catalog WHERE session_id IN ({Parameters(ids.Length)})";
            using var command = Command(db!, sql, ids.Cast<object?>().ToArray());
            using var reader = command.ExecuteReader();
            while (reader.Read())
                result[reader.GetString(0)] = reader.GetDouble(1);
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }

    /// <summary>
    /// For each parent, how many unpinned, unarchived children have subtree activity at or
    /// after <paramref name="since"/>, counting at most <paramref name="cap"/> through one
    /// bounded indexed seek per parent.
    /// </summary>
    internal Dictionary<string, int> RecentChildCounts(string[] parents, double since, int cap)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        if (parents.Length == 0)
            return result;
        if (parents.Length > 100)
            throw new InvalidDataException("Recent child count batch exceeds 100 parents.");
        lock (gate)
        {
            EnsureInitialized();
            var args = new List<object?> { -since, cap };
            var branches = new List<string>();
            foreach (var parent in parents)
            {
                args.Add(parent);
                var name = "$p" + (args.Count - 1);
                branches.Add(
                    $"SELECT {name} AS parent,count(*) AS recent FROM (SELECT 1 FROM session_catalog INDEXED BY idx_session_catalog_parent_activity WHERE parent_session_id={name} AND pinned=0 AND archived=0 AND subtree_rank<=$p0 LIMIT $p1)"
                );
            }
            var sql = string.Join(" UNION ALL ", branches);
            using var command = Command(db!, sql, args.ToArray());
            using var reader = command.ExecuteReader();
            while (reader.Read())
                result[reader.GetString(0)] = reader.GetInt32(1);
            QueryObserved?.Invoke(sql, result.Count);
            return result;
        }
    }
}
