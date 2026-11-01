using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionSidebarGroupingTests
{
    private static string[] Ids(IEnumerable<JsonObject> rows) =>
        rows.Select(row => row["id"]!.GetValue<string>()).ToArray();

    // Catalog root pages hold Session rows; the list query merges virtual groups by key.
    private static string[] Roots(SessionCatalog catalog, string mode = "default") =>
        Ids(catalog.Page(mode, 100, null, true, null).Rows);

    private static string[] Groups(SessionCatalog catalog) =>
        catalog.SidebarGroups().Select(group => group.Key).ToArray();

    private static string[] Under(SessionCatalog catalog, string host, string mode = "default") =>
        Ids(catalog.Children([(host, null)], mode, 20, null)[0].Rows);

    private static string? SidebarParent(SessionCatalog catalog, string id) =>
        SessionCatalog.Text(catalog.Scopes([id])[id]["sidebarParentId"]);

    [Fact]
    public void Top_level_rows_are_shown_under_the_agent_main_or_a_virtual_group_without_changing_real_parents()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            SessionCatalogTests.Row("main", 50),
            SessionCatalogTests.Row("0905_aaaaa", 40),
            SessionCatalogTests.Row("alpha/main", 30, agent: "alpha"),
            SessionCatalogTests.Row("alpha/real", 29, "alpha/main", "alpha"),
            SessionCatalogTests.Row("alpha/loose", 31, agent: "alpha"),
            SessionCatalogTests.Row("alpha/nested", 28, "alpha/loose", "alpha"),
            SessionCatalogTests.Row("beta/one", 20, agent: "beta"),
            SessionCatalogTests.Row("beta/two", 21, agent: "beta"),
            SessionCatalogTests.Row("gamma/only", 10, agent: "gamma"),
        ]);

        Assert.Equal(["main", "alpha/main", "gamma/only"], Roots(catalog));
        Assert.Equal(["//agent/beta"], Groups(catalog));
        Assert.Equal(["main", "alpha/main", "gamma/only"], Roots(catalog, "time"));
        // Flat mode is unchanged and never contains virtual groups.
        Assert.Equal(9, Roots(catalog, "flat-time").Length);
        Assert.Equal(["0905_aaaaa"], Under(catalog, "main"));
        Assert.Equal(["alpha/loose", "alpha/real"], Under(catalog, "alpha/main", "time"));
        Assert.Equal(["alpha/nested"], Under(catalog, "alpha/loose"));
        Assert.Equal(["beta/two", "beta/one"], Under(catalog, "//agent/beta", "time"));
        Assert.Equal(2, catalog.ChildCounts(["alpha/main"])["alpha/main"]);
        Assert.Equal(2, catalog.ChildCounts(["//agent/beta"])["//agent/beta"]);
        var group = Assert.Single(catalog.SidebarGroups());
        Assert.Equal(("beta", 2L, 21d), (group.Agent, group.Count, group.LastMessageTime));

        // Real relations stay authoritative for every non-Sidebar consumer.
        Assert.Null(catalog.Get("alpha/loose")!["parentSessionId"]);
        Assert.Equal(1, catalog.ChildCounts(["alpha/main"], "alpha")["alpha/main"]);
        Assert.Equal(["alpha/real"], Ids(catalog.Descendants("alpha/main", 20).Rows));
        Assert.Equal(
            ["alpha/main", "alpha/real"],
            catalog.SelectDeletion("alpha/main", true).Targets
        );
        Assert.Contains("alpha/loose", Ids(catalog.Page("time", 100, null, true, "alpha").Rows));

        // Focus paths and collapsed activity follow presentation parents.
        var paths = catalog.SidebarPaths(["alpha/nested", "beta/one", "gamma/only"]);
        Assert.Equal(["alpha/main", "alpha/loose", "alpha/nested"], paths["alpha/nested"]);
        Assert.Equal(["//agent/beta", "beta/one"], paths["beta/one"]);
        Assert.Equal(["gamma/only"], paths["gamma/only"]);
        var busy = catalog.BusyDescendants(
            ["alpha/main", "//agent/beta", "alpha/loose"],
            ["alpha/nested", "beta/one"]
        );
        Assert.Equal(1, busy["alpha/main"]);
        Assert.Equal(1, busy["//agent/beta"]);
        Assert.Equal(1, busy["alpha/loose"]);
    }

    [Fact]
    public void Membership_follows_main_creation_deletion_pins_parents_and_the_group_threshold()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            SessionCatalogTests.Row("beta/one", 20, agent: "beta"),
            SessionCatalogTests.Row("other/root", 5, agent: "other"),
        ]);
        Assert.Equal(["beta/one", "other/root"], Roots(catalog));

        // Crossing the threshold creates the virtual group; dropping below removes it.
        catalog.Upsert([SessionCatalogTests.Row("beta/two", 21, agent: "beta")]);
        Assert.Equal(["other/root"], Roots(catalog));
        Assert.Equal(["//agent/beta"], Groups(catalog));
        catalog.SetParent("beta/two", "other/root");
        Assert.Equal(["beta/one", "other/root"], Roots(catalog));
        Assert.Empty(catalog.SidebarGroups());
        Assert.Equal("other/root", SidebarParent(catalog, "beta/two"));
        catalog.SetParent("beta/two", null);
        Assert.Equal(["other/root"], Roots(catalog));
        Assert.Equal(["//agent/beta"], Groups(catalog));

        // A pinned row is top-level in the pinned partition and leaves the group.
        catalog.Pin("beta/two", true);
        Assert.Equal(["beta/two", "beta/one", "other/root"], Roots(catalog));
        catalog.Pin("beta/two", false);

        // Creating the main Session moves every groupable row under it.
        catalog.Upsert([SessionCatalogTests.Row("beta/main", 1, agent: "beta")]);
        Assert.Equal(["other/root", "beta/main"], Roots(catalog));
        Assert.Empty(Groups(catalog));
        Assert.Equal(["beta/two", "beta/one"], Under(catalog, "beta/main", "time"));

        // A pinned main still hosts the group wherever it is shown.
        catalog.Pin("beta/main", true);
        Assert.Equal(["beta/main", "other/root"], Roots(catalog));
        Assert.Equal(["beta/two", "beta/one"], Under(catalog, "beta/main", "time"));

        // Deleting the main Session restores the virtual group.
        catalog.RemoveForDeletion("beta/main");
        Assert.Equal(["other/root"], Roots(catalog));
        Assert.Equal(["//agent/beta"], Groups(catalog));
        catalog.RemoveForDeletion("beta/two");
        Assert.Equal(["beta/one", "other/root"], Roots(catalog));
        Assert.Empty(Groups(catalog));
        Assert.Equal("beta/one", catalog.SidebarPaths(["beta/one"])["beta/one"].Single());
    }

    [Fact]
    public void A_main_with_a_real_ancestor_hosts_its_agent_rows_without_forming_a_cycle()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            SessionCatalogTests.Row("delta/root", 10, agent: "delta"),
            SessionCatalogTests.Row("delta/main", 9, "delta/root", "delta"),
            SessionCatalogTests.Row("delta/other", 8, agent: "delta"),
            SessionCatalogTests.Row("epsilon/x", 7, agent: "epsilon"),
            SessionCatalogTests.Row("epsilon/main", 6, "epsilon/x", "epsilon"),
        ]);
        // The real ancestor containing the main stays top-level; others are grouped below main.
        Assert.Equal(["delta/root", "epsilon/x"], Roots(catalog));
        Assert.Equal(["delta/main"], Under(catalog, "delta/root"));
        Assert.Equal(["delta/other"], Under(catalog, "delta/main"));
        Assert.Equal(
            ["delta/root", "delta/main", "delta/other"],
            catalog.SidebarPaths(["delta/other"])["delta/other"]
        );
        // Moving the main out of that subtree regroups its former host.
        catalog.SetParent("delta/main", null);
        Assert.Equal(["delta/main", "epsilon/x"], Roots(catalog));
        Assert.Equal(["delta/root", "delta/other"], Under(catalog, "delta/main", "time"));
    }

    private static object? Scalar(string file, string sql)
    {
        using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    private static void AssertSchemaVersion3(string file)
    {
        Assert.Equal(3L, Scalar(file, "PRAGMA user_version"));
        Assert.Equal(
            "3",
            Scalar(file, "SELECT value FROM catalog_metadata WHERE key='schema_version'")
        );
    }

    // Maintained counts must equal a full recount after every reopen.
    private static void AssertSidebarCountsExact(string file) =>
        Assert.Equal(
            0L,
            Scalar(
                file,
                """
                SELECT count(*) FROM (
                  SELECT parent_key,session_count FROM catalog_sidebar_count
                  EXCEPT SELECT sidebar_parent,count(*) FROM session_catalog WHERE sidebar_parent IS NOT NULL GROUP BY sidebar_parent
                  UNION ALL
                  SELECT sidebar_parent,count(*) FROM session_catalog WHERE sidebar_parent IS NOT NULL GROUP BY sidebar_parent
                  EXCEPT SELECT parent_key,session_count FROM catalog_sidebar_count)
                """
            )
        );

    [Fact]
    public void A_catalog_without_sidebar_objects_gains_them_without_a_version_change()
    {
        using var temp = new TempDirectory();
        using (var catalog = new SessionCatalog(temp.Path))
            catalog.Upsert([
                SessionCatalogTests.Row("alpha/main", 3, agent: "alpha"),
                SessionCatalogTests.Row("alpha/loose", 2, agent: "alpha"),
            ]);
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
        AssertSchemaVersion3(file);
        using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = """
                DROP TRIGGER session_catalog_sidebar_insert;
                DROP TRIGGER session_catalog_sidebar_delete;
                DROP TRIGGER session_catalog_sidebar_topology;
                DROP TRIGGER session_catalog_sidebar_count_update;
                DROP INDEX idx_session_catalog_sidebar_default;
                DROP INDEX idx_session_catalog_sidebar_time;
                DROP TABLE catalog_sidebar_count;
                DROP TABLE catalog_sidebar_agent;
                DROP TABLE catalog_sidebar_host;
                DROP TABLE catalog_sidebar_dirty;
                ALTER TABLE session_catalog DROP COLUMN sidebar_parent;
                """;
            command.ExecuteNonQuery();
        }
        using (var upgraded = new SessionCatalog(temp.Path))
        {
            Assert.Equal(["alpha/main"], Roots(upgraded));
            Assert.Equal(["alpha/loose"], Under(upgraded, "alpha/main"));
        }
        AssertSchemaVersion3(file);
        AssertSidebarCountsExact(file);
    }

    // The base Main's catalog writes: an explicit-column upsert without sidebar_parent,
    // its parent normalization update, and row deletion.
    private static void LegacyUpsert(
        SqliteConnection db,
        string template,
        string id,
        string agent,
        string? parent,
        bool pinned
    )
    {
        var columns = new List<string>();
        using (var info = db.CreateCommand())
        {
            info.CommandText =
                "SELECT name FROM pragma_table_xinfo('session_catalog') WHERE hidden=0 AND name<>'sidebar_parent'";
            using var reader = info.ExecuteReader();
            while (reader.Read())
                columns.Add(reader.GetString(0));
        }
        var values = columns.Select(column =>
            column switch
            {
                "session_id" => "$id",
                "agent" => "$agent",
                "parent_session_id" or "parent_reference" => "$parent",
                "pinned" => "$pinned",
                // The row JSON carries the same identity and topology as the columns.
                "metadata_json" =>
                    "json_set(CASE WHEN $pinned=1 THEN json_set(metadata_json,'$.pinned',json('true')) ELSE json_remove(metadata_json,'$.pinned') END,"
                        + "'$.id',$id,'$.agent',$agent,'$.parentSessionId',$parent)",
                _ => column,
            }
        );
        using var command = db.CreateCommand();
        command.CommandText =
            $"INSERT INTO session_catalog({string.Join(',', columns)}) SELECT {string.Join(',', values)} FROM session_catalog WHERE session_id=$template "
            + "ON CONFLICT(session_id) DO UPDATE SET "
            + string.Join(',', columns.Skip(1).Select(column => column + "=excluded." + column));
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$agent", agent);
        command.Parameters.AddWithValue("$parent", (object?)parent ?? DBNull.Value);
        command.Parameters.AddWithValue("$pinned", pinned ? 1 : 0);
        command.Parameters.AddWithValue("$template", template);
        Assert.Equal(1, command.ExecuteNonQuery());
    }

    [Fact]
    public void Topology_written_by_a_main_without_sidebar_support_is_repaired_on_reopen()
    {
        using var temp = new TempDirectory();
        using (var catalog = new SessionCatalog(temp.Path))
            catalog.Upsert([
                SessionCatalogTests.Row("main", 50),
                SessionCatalogTests.Row("alpha/main", 40, agent: "alpha"),
                SessionCatalogTests.Row("alpha/a", 39, agent: "alpha"),
                SessionCatalogTests.Row("alpha/b", 38, agent: "alpha"),
                SessionCatalogTests.Row("alpha/c", 37, agent: "alpha"),
                SessionCatalogTests.Row("beta/one", 30, agent: "beta"),
            ]);
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
        using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
        {
            db.Open();
            using (var begin = db.CreateCommand())
            {
                begin.CommandText = "BEGIN IMMEDIATE";
                begin.ExecuteNonQuery();
            }
            LegacyUpsert(db, "beta/one", "beta/two", "beta", null, false);
            LegacyUpsert(db, "main", "0901_aaaaa", "main", null, false);
            LegacyUpsert(db, "alpha/c", "alpha/d", "alpha", null, false);
            LegacyUpsert(db, "alpha/a", "alpha/a", "alpha", null, true);
            using var command = db.CreateCommand();
            command.CommandText = """
                UPDATE session_catalog SET parent_session_id='alpha/c' WHERE session_id='alpha/b' AND parent_session_id IS NOT 'alpha/c';
                DELETE FROM session_catalog WHERE session_id='alpha/main';
                COMMIT;
                """;
            command.ExecuteNonQuery();
        }
        // The triggers recorded the old binary's topology changes.
        Assert.True((long)Scalar(file, "SELECT count(*) FROM catalog_sidebar_dirty")! >= 6);
        AssertSchemaVersion3(file);

        using (var reopened = new SessionCatalog(temp.Path))
        {
            Assert.Equal(["alpha/a", "main"], Roots(reopened).Order(StringComparer.Ordinal));
            Assert.Equal(
                ["//agent/alpha", "//agent/beta"],
                Groups(reopened).Order(StringComparer.Ordinal)
            );
            Assert.Equal(
                ["alpha/c", "alpha/d"],
                Under(reopened, "//agent/alpha").Order(StringComparer.Ordinal)
            );
            Assert.Equal(
                ["beta/one", "beta/two"],
                Under(reopened, "//agent/beta").Order(StringComparer.Ordinal)
            );
            Assert.Equal(["alpha/b"], Under(reopened, "alpha/c"));
            Assert.Equal(["0901_aaaaa"], Under(reopened, "main"));
            var counts = reopened.ChildCounts(["//agent/alpha", "//agent/beta", "alpha/c", "main"]);
            Assert.Equal(
                (2L, 2L, 1L, 1L),
                (counts["//agent/alpha"], counts["//agent/beta"], counts["alpha/c"], counts["main"])
            );
            Assert.Null(SidebarParent(reopened, "alpha/a"));
        }
        Assert.Equal(0L, Scalar(file, "SELECT count(*) FROM catalog_sidebar_dirty"));
        AssertSidebarCountsExact(file);
        AssertSchemaVersion3(file);
    }

    [Fact]
    public async Task Grouped_rows_are_not_lifecycle_descendants_and_user_children_record_the_opening_notice()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a/wire",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        if (manager.Catalog.Get("main") is null)
            await manager.CreateNamedAsync("main", "main", null, null);
        var loose = await manager.CreateNamedAsync("main", "loose", null, null);
        var child = await manager.CreateUserChildAsync("main", "picked", "main");
        var view = new SessionListQueries(new SessionRuntime(manager));

        Assert.Equal("main", SidebarParent(manager.Catalog, loose.Id));
        Assert.Null(manager.Catalog.Get(loose.Id)!["parentSessionId"]);
        Assert.Equal("main", manager.Catalog.Get(child.Id)!["parentSessionId"]!.GetValue<string>());
        // Stop/delete previews and cascades of the host include only real descendants.
        var descendants = view.Descendants("main", 20);
        Assert.Equal(
            [child.Id],
            descendants["sessions"]!.AsArray().Select(row => row!["id"]!.GetValue<string>())
        );
        Assert.Equal(["main", child.Id], manager.Catalog.SelectDeletion("main", true).Targets);
        Assert.Equal(2, view.ProjectionRows(["main"])[0]!["childTotal"]!.GetValue<long>());

        var rows = child.Archive.ReadMessages();
        Assert.Equal(2, rows.Count);
        var opening = rows[0].Message["parts"]![0]!["system"]!.GetValue<string>();
        Assert.StartsWith(
            $"<foxwarm-system kind=\"session-boundary\" event=\"user-child-created\" parentSessionId=\"main\" currentSessionId=\"{child.Id}\" currentNode=\"",
            opening
        );
        Assert.EndsWith("\" />", opening);
        Assert.Equal(
            "This session was created by the user as a child of session `main`. The parent relationship organizes the session; it does not itself assign work or require a completion report. Follow the user's instructions in this session.",
            rows[1].Message["parts"]![0]!["system"]!.GetValue<string>()
        );
    }
}
