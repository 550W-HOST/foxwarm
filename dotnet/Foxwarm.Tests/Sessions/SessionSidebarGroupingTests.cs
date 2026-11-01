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

    [Fact]
    public void A_v3_catalog_upgrades_and_backfills_sidebar_parents()
    {
        using var temp = new TempDirectory();
        using (var catalog = new SessionCatalog(temp.Path))
            catalog.Upsert([
                SessionCatalogTests.Row("alpha/main", 3, agent: "alpha"),
                SessionCatalogTests.Row("alpha/loose", 2, agent: "alpha"),
            ]);
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
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
                UPDATE catalog_metadata SET value='3' WHERE key='schema_version';
                PRAGMA user_version=3;
                """;
            command.ExecuteNonQuery();
        }
        using var upgraded = new SessionCatalog(temp.Path);
        Assert.Equal(["alpha/main"], Roots(upgraded));
        Assert.Equal(["alpha/loose"], Under(upgraded, "alpha/main"));
        using var check = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        check.Open();
        using var version = check.CreateCommand();
        version.CommandText = "PRAGMA user_version";
        Assert.Equal(4L, version.ExecuteScalar());
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
