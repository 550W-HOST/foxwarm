using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionSidebarGroupsTests
{
    private static string[] Ids(IEnumerable<JsonObject> rows) =>
        rows.Select(row => row["id"]!.GetValue<string>()).ToArray();

    private static JsonObject Row(
        string id,
        int time,
        string? parent = null,
        string agent = "main",
        string node = "master",
        double? order = null
    )
    {
        var row = SessionCatalogTests.Row(id, time, parent, agent);
        row["currentNode"] = node;
        if (order is not null)
            row["sidebarOrder"] = order;
        return row;
    }

    private static string[] Page(
        SessionCatalog catalog,
        string by,
        string key,
        string mode,
        string? exclude = null
    ) => Ids(catalog.GroupPage(by, key, mode, 100, null, exclude).Rows);

    private static object? Scalar(string file, string sql)
    {
        using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    private static void Execute(string file, string sql)
    {
        using var db = new SqliteConnection($"Data Source={file};Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    // The maintained Node counts equal a full recount, in both directions.
    private static void AssertNodeCountsExact(string file) =>
        Assert.Equal(
            0L,
            Scalar(
                file,
                """
                SELECT (SELECT count(*) FROM (
                  SELECT current_node,session_count,root_count FROM catalog_node_count
                  EXCEPT SELECT current_node,count(*),sum(parent_session_id IS NULL) FROM session_catalog GROUP BY current_node))
                + (SELECT count(*) FROM (
                  SELECT current_node,count(*),sum(parent_session_id IS NULL) FROM session_catalog GROUP BY current_node
                  EXCEPT SELECT current_node,session_count,root_count FROM catalog_node_count))
                """
            )
        );

    private static SessionCatalog Fixture(TempDirectory temp)
    {
        var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            Row("main", 50),
            Row("0905_aaaaa", 40),
            Row("0905_child", 39, "0905_aaaaa", node: "box"),
            Row("alpha/main", 30, agent: "alpha", node: "box"),
            Row("alpha/loose", 31, agent: "alpha"),
            Row("alpha/nested", 28, "alpha/loose", "alpha", "box"),
            Row("alpha/pinned", 27, agent: "alpha", node: "box"),
            Row("beta/one", 20, "alpha/loose", "beta"),
            Row("beta/two", 21, agent: "beta", node: "gone"),
        ]);
        catalog.Pin("alpha/pinned", true);
        return catalog;
    }

    [Fact]
    public void Group_counts_and_pages_follow_own_agent_or_node_and_real_top_level_rows()
    {
        using var temp = new TempDirectory();
        using var catalog = Fixture(temp);

        // Tree modes count unpinned top-level rows; Flat counts every unpinned row.
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["main"] = 2,
                ["alpha"] = 2,
                ["beta"] = 1,
            },
            catalog.GroupCounts("agent", true)
        );
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["main"] = 3,
                ["alpha"] = 3,
                ["beta"] = 2,
            },
            catalog.GroupCounts("agent", false)
        );
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["master"] = 3,
                ["box"] = 1,
                ["gone"] = 1,
            },
            catalog.GroupCounts("node", true)
        );
        Assert.Equal(
            new Dictionary<string, long>
            {
                ["master"] = 4,
                ["box"] = 3,
                ["gone"] = 1,
            },
            catalog.GroupCounts("node", false)
        );

        // Children stay under their real parent and are not group members in tree modes,
        // even when they belong to another Agent or run on another Node.
        Assert.Equal(["alpha/loose", "alpha/main"], Page(catalog, "agent", "alpha", "time"));
        Assert.Equal(["beta/two"], Page(catalog, "agent", "beta", "default"));
        Assert.Equal(["alpha/main"], Page(catalog, "node", "box", "default"));
        Assert.Equal(
            ["main", "0905_aaaaa", "alpha/loose"],
            Page(catalog, "node", "master", "time")
        );
        // Flat members are every unpinned row of the group, by recency.
        Assert.Equal(
            ["alpha/loose", "alpha/main", "alpha/nested"],
            Page(catalog, "agent", "alpha", "flat-time")
        );
        Assert.Equal(
            ["0905_child", "alpha/main", "alpha/nested"],
            Page(catalog, "node", "box", "flat-time")
        );
        // The caller places an Agent main separately.
        Assert.Equal(["alpha/loose"], Page(catalog, "agent", "alpha", "time", "alpha/main"));

        // The pinned section is paged alone.
        Assert.Equal(
            ["alpha/pinned"],
            Ids(catalog.Page("default", 10, null, true, null, pinnedOnly: true).Rows)
        );
        Assert.Equal(
            ["alpha/pinned"],
            Ids(catalog.Page("flat-time", 10, null, true, null, pinnedOnly: true).Rows)
        );

        var keys = catalog.GroupKeys(["beta/one", "beta/two", "missing"], "node");
        Assert.Equal(
            new Dictionary<string, string> { ["beta/one"] = "master", ["beta/two"] = "gone" },
            keys
        );
    }

    [Fact]
    public void Default_group_pages_use_saved_order_and_continue_by_keyset()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            Row("gamma/a", 10, agent: "gamma", order: 2),
            Row("gamma/b", 20, agent: "gamma", order: 1),
            Row("gamma/c", 30, agent: "gamma"),
            Row("gamma/d", 40, agent: "gamma"),
        ]);
        Assert.Equal(
            ["gamma/b", "gamma/a", "gamma/d", "gamma/c"],
            Page(catalog, "agent", "gamma", "default")
        );
        Assert.Equal(
            ["gamma/d", "gamma/c", "gamma/b", "gamma/a"],
            Page(catalog, "agent", "gamma", "time")
        );
        var first = catalog.GroupPage("agent", "gamma", "default", 2, null, null);
        Assert.True(first.HasMore);
        var after = new JsonArray(0, 0, 2, -10, "gamma/a");
        var rest = catalog.GroupPage("agent", "gamma", "default", 2, after, null);
        Assert.Equal(["gamma/d", "gamma/c"], Ids(rest.Rows));
        Assert.False(rest.HasMore);
        // A start key below every member continues from the first row.
        var start = catalog.GroupPage(
            "agent",
            "gamma",
            "default",
            10,
            new JsonArray(-1, 0, 0, 0, ""),
            "gamma/b"
        );
        Assert.Equal(["gamma/a", "gamma/d", "gamma/c"], Ids(start.Rows));
    }

    [Fact]
    public void Node_counts_are_maintained_through_topology_changes_and_older_writers()
    {
        using var temp = new TempDirectory();
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
        using (var catalog = Fixture(temp))
        {
            AssertNodeCountsExact(file);
            catalog.SetParent("beta/two", "main");
            catalog.SetParent("alpha/nested", null);
            catalog.Upsert([Row("0905_aaaaa", 41, node: "box")]);
            catalog.RemoveForDeletion("beta/one");
            AssertNodeCountsExact(file);
            Assert.Equal(
                new Dictionary<string, long> { ["master"] = 2, ["box"] = 3 },
                catalog.GroupCounts("node", true)
            );
        }
        // A writer that never maintained the counts still fires the stored triggers.
        Execute(
            file,
            "UPDATE session_catalog SET current_node='other' WHERE session_id='main';"
                + "DELETE FROM session_catalog WHERE session_id='0905_child'"
        );
        AssertNodeCountsExact(file);
        // A catalog without the grouping objects gains them, with counts, on open.
        Execute(
            file,
            """
            DROP TRIGGER session_catalog_node_count_insert;
            DROP TRIGGER session_catalog_node_count_delete;
            DROP TRIGGER session_catalog_node_count_update;
            DROP TABLE catalog_node_count;
            DROP INDEX idx_session_catalog_node_time;
            """
        );
        using (var reopened = new SessionCatalog(temp.Path))
            Assert.Equal(
                new Dictionary<string, long>
                {
                    ["other"] = 1,
                    ["box"] = 3,
                    ["master"] = 1,
                    ["gone"] = 1,
                },
                reopened.GroupCounts("node", false)
            );
        AssertNodeCountsExact(file);
        Assert.Equal(3L, Scalar(file, "PRAGMA user_version"));
    }

    [Fact]
    public void Opening_retires_the_earlier_sidebar_objects_and_keeps_their_column()
    {
        using var temp = new TempDirectory();
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
        using (var catalog = new SessionCatalog(temp.Path))
            catalog.Upsert([Row("beta/main", 3, agent: "beta"), Row("beta/one", 2, agent: "beta")]);
        // The objects an earlier build maintained, including triggers that write its tables.
        Execute(
            file,
            """
            ALTER TABLE session_catalog ADD COLUMN sidebar_parent TEXT;
            UPDATE session_catalog SET sidebar_parent='beta/main' WHERE session_id='beta/one';
            CREATE TABLE catalog_sidebar_count (parent_key TEXT PRIMARY KEY, session_count INTEGER NOT NULL) STRICT;
            CREATE TABLE catalog_sidebar_agent (agent TEXT PRIMARY KEY, target TEXT) STRICT;
            CREATE TABLE catalog_sidebar_host (session_id TEXT PRIMARY KEY) STRICT;
            CREATE TABLE catalog_sidebar_dirty (session_id TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY(session_id,agent)) STRICT;
            CREATE TRIGGER session_catalog_sidebar_insert AFTER INSERT ON session_catalog BEGIN
              INSERT OR IGNORE INTO catalog_sidebar_dirty(session_id,agent) VALUES(new.session_id,new.agent); END;
            CREATE TRIGGER session_catalog_sidebar_delete AFTER DELETE ON session_catalog BEGIN
              INSERT OR IGNORE INTO catalog_sidebar_dirty(session_id,agent) VALUES(old.session_id,old.agent); END;
            CREATE TRIGGER session_catalog_sidebar_topology AFTER UPDATE OF agent,parent_session_id,pinned ON session_catalog BEGIN
              INSERT OR IGNORE INTO catalog_sidebar_dirty(session_id,agent) VALUES(new.session_id,new.agent); END;
            CREATE TRIGGER session_catalog_sidebar_count_update AFTER UPDATE OF sidebar_parent ON session_catalog BEGIN
              INSERT OR IGNORE INTO catalog_sidebar_count(parent_key,session_count) VALUES(new.sidebar_parent,1); END;
            CREATE INDEX idx_session_catalog_sidebar_default ON session_catalog(sidebar_parent,pinned_rank,archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id);
            CREATE INDEX idx_session_catalog_sidebar_time ON session_catalog(sidebar_parent,pinned_rank,archived,recent_rank,session_id);
            """
        );
        using (var reopened = new SessionCatalog(temp.Path))
        {
            // Real top-level rows are roots again, and writes need none of the retired objects.
            Assert.Equal(
                ["beta/main", "beta/one"],
                Ids(reopened.Page("time", 10, null, true, null).Rows)
            );
            reopened.Upsert([Row("beta/two", 4, "beta/main", "beta")]);
            reopened.RemoveForDeletion("beta/one");
            Assert.Equal(1, reopened.ChildCounts(["beta/main"])["beta/main"]);
        }
        Assert.Equal(
            0L,
            Scalar(
                file,
                "SELECT count(*) FROM sqlite_master WHERE name LIKE '%sidebar%' AND name NOT LIKE 'sqlite_%'"
            )
        );
        Assert.Equal(
            1L,
            Scalar(
                file,
                "SELECT count(*) FROM pragma_table_info('session_catalog') WHERE name='sidebar_parent'"
            )
        );
        Assert.Equal(3L, Scalar(file, "PRAGMA user_version"));
        // Reopening is idempotent.
        using (var again = new SessionCatalog(temp.Path))
            Assert.Equal(["beta/main"], Ids(again.Page("time", 10, null, true, null).Rows));
    }
}
