using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

// Maintained subtree activity: max of a row's own last_message_time and every descendant's.
public sealed class SessionCatalogActivityTests
{
    private static string[] Ids(IEnumerable<JsonObject> rows) =>
        rows.Select(row => row["id"]!.GetValue<string>()).ToArray();

    private static Dictionary<string, double> Maintained(string file)
    {
        using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT session_id,subtree_time FROM session_catalog";
        using var reader = command.ExecuteReader();
        var result = new Dictionary<string, double>(StringComparer.Ordinal);
        while (reader.Read())
            result[reader.GetString(0)] = reader.GetDouble(1);
        return result;
    }

    // Full recomputation from the canonical parent relation, independent of the triggers.
    private static Dictionary<string, double> Expected(string file)
    {
        using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText =
            "SELECT session_id,parent_session_id,last_message_time FROM session_catalog";
        var own = new Dictionary<string, double>(StringComparer.Ordinal);
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                own[reader.GetString(0)] = reader.GetDouble(2);
                parents[reader.GetString(0)] = reader.IsDBNull(1) ? null : reader.GetString(1);
            }
        var result = own.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        foreach (var (id, time) in own)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal) { id };
            var current = parents[id];
            while (current is not null && own.ContainsKey(current) && seen.Add(current))
            {
                result[current] = Math.Max(result[current], time);
                current = parents[current];
            }
        }
        return result;
    }

    private static void AssertExact(SessionCatalog catalog) =>
        Assert.Equal(
            Expected(catalog.FilePath).OrderBy(pair => pair.Key, StringComparer.Ordinal),
            Maintained(catalog.FilePath).OrderBy(pair => pair.Key, StringComparer.Ordinal)
        );

    // Whether following raw parent references from `from` meets `target`, which would make
    // `target` an ancestor of itself. Tolerated legacy cycles are outside the exactness claim.
    private static bool Reaches(SessionCatalog catalog, string from, string target)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (
            var current = from;
            current is not null && seen.Add(current);
            current = catalog.Get(current) is { } row
                ? SessionCatalog.Text(row["parentSessionId"])
                : null
        )
            if (current == target)
                return true;
        return false;
    }

    private static double Subtree(SessionCatalog catalog, string id) =>
        catalog.SubtreeTimes([id])[id];

    [Fact]
    public void A_deep_chain_carries_the_newest_descendant_time_to_every_ancestor()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("a", 10),
            SessionCatalogTests.Row("a/b", 20, "a"),
            SessionCatalogTests.Row("a/b/c", 30, "a/b"),
            SessionCatalogTests.Row("a/b/c/d", 40, "a/b/c"),
            SessionCatalogTests.Row("a/b/c/d/e", 50, "a/b/c/d"),
            SessionCatalogTests.Row("a/b/c/d/e/f", 60, "a/b/c/d/e"),
            SessionCatalogTests.Row("other", 25),
        ]);
        Assert.Equal(
            [60, 60, 60, 60, 60, 60],
            new[] { "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f" }
                .Select(id => Subtree(catalog, id))
                .ToArray()
        );
        Assert.Equal(25, Subtree(catalog, "other"));
        // Publication of a newer deep message propagates through the whole chain.
        catalog.Upsert([SessionCatalogTests.Row("a/b/c/d/e/f", 90, "a/b/c/d/e")]);
        Assert.Equal(90, Subtree(catalog, "a"));
        // The displayed own time is untouched by descendants.
        Assert.Equal(
            10,
            SessionCatalog.Number(catalog.Get("a")!["meta"]!["lastMessageTime"])
        );
        // An older descendant message lowers only what no other descendant still supports.
        catalog.Upsert([SessionCatalogTests.Row("a/b/c/d/e/f", 15, "a/b/c/d/e")]);
        Assert.Equal(
            [50, 50, 50, 50, 50, 15],
            new[] { "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f" }
                .Select(id => Subtree(catalog, id))
                .ToArray()
        );
        AssertExact(catalog);
    }

    [Fact]
    public void Siblings_keep_an_ancestor_current_when_one_branch_goes_quiet_or_leaves()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("root", 5),
            SessionCatalogTests.Row("left", 10, "root"),
            SessionCatalogTests.Row("left/leaf", 70, "left"),
            SessionCatalogTests.Row("right", 20, "root"),
            SessionCatalogTests.Row("right/leaf", 60, "right"),
        ]);
        Assert.Equal(70, Subtree(catalog, "root"));
        catalog.Upsert([SessionCatalogTests.Row("left/leaf", 30, "left")]);
        Assert.Equal(60, Subtree(catalog, "root"));
        Assert.Equal(30, Subtree(catalog, "left"));
        // Reparent the newest branch: the old chain drops it, the new chain gains it.
        catalog.SetParent("right", "left");
        Assert.Equal(60, Subtree(catalog, "left"));
        Assert.Equal(60, Subtree(catalog, "root"));
        catalog.SetParent("right", null);
        Assert.Equal(60, Subtree(catalog, "right"));
        Assert.Equal(30, Subtree(catalog, "left"));
        Assert.Equal(30, Subtree(catalog, "root"));
        catalog.SetParent("left", null);
        Assert.Equal(5, Subtree(catalog, "root"));
        Assert.Equal(30, Subtree(catalog, "left"));
        AssertExact(catalog);
    }

    [Fact]
    public void Deletion_recomputes_the_old_ancestors_and_detaches_children_as_roots()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("root", 1),
            SessionCatalogTests.Row("mid", 2, "root"),
            SessionCatalogTests.Row("hot", 99, "mid"),
            SessionCatalogTests.Row("warm", 40, "mid"),
            SessionCatalogTests.Row("sibling", 30, "root"),
        ]);
        Assert.Equal(99, Subtree(catalog, "root"));
        catalog.RemoveForDeletion("hot");
        Assert.Equal(40, Subtree(catalog, "mid"));
        Assert.Equal(40, Subtree(catalog, "root"));
        catalog.RemoveForDeletion("mid");
        Assert.Equal(30, Subtree(catalog, "root"));
        // The deleted row's children are roots again with their own value.
        Assert.Equal(40, Subtree(catalog, "warm"));
        AssertExact(catalog);
    }

    [Fact]
    public void A_child_published_before_its_parent_counts_once_the_parent_exists()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([SessionCatalogTests.Row("early", 80, "late")]);
        catalog.Upsert([SessionCatalogTests.Row("late", 3)]);
        Assert.Equal(80, Subtree(catalog, "late"));
        // An alias reference resolves to its owner and carries activity to it as well.
        catalog.Upsert([
            SessionCatalogTests.Row("owner", 4, aliases: ["via-alias"]),
            SessionCatalogTests.Row("aliased-child", 95, "via-alias"),
        ]);
        Assert.Equal(95, Subtree(catalog, "owner"));
        AssertExact(catalog);
    }

    [Fact]
    public void Randomized_publication_reparent_and_delete_stay_equal_to_a_full_recomputation()
    {
        var random = new Random(20261108);
        for (var trial = 0; trial < 25; trial++)
        {
            using var temp = new TempDirectory();
            using var catalog = new SessionCatalog(temp.Path);
            catalog.Initialize();
            var ids = Enumerable.Range(0, 14).Select(index => "s" + index).ToArray();
            for (var step = 0; step < 70; step++)
            {
                var existing = ids.Where(id => catalog.Get(id) is not null).ToArray();
                var action = random.Next(5);
                if (action <= 1 || existing.Length < 3)
                {
                    var missing = ids.Where(id => !existing.Contains(id)).ToArray();
                    if (missing.Length == 0)
                        continue;
                    var id = missing[random.Next(missing.Length)];
                    var parent = existing.Length > 0 && random.Next(4) > 0
                        ? existing[random.Next(existing.Length)]
                        : null;
                    if (parent is not null && Reaches(catalog, parent, id))
                        parent = null;
                    catalog.Upsert([SessionCatalogTests.Row(id, random.Next(1, 200), parent)]);
                }
                else if (action == 2)
                {
                    var id = existing[random.Next(existing.Length)];
                    var row = catalog.Get(id)!;
                    row["meta"]!["lastMessageTime"] = random.Next(1, 200);
                    catalog.Upsert([row]);
                }
                else if (action == 3)
                {
                    var id = existing[random.Next(existing.Length)];
                    var target = random.Next(4) == 0 ? null : existing[random.Next(existing.Length)];
                    try
                    {
                        catalog.SetParent(id, target);
                    }
                    catch (Exception error) when (error is InvalidDataException or InvalidOperationException)
                    {
                        // A rejected cycle or self parent leaves the catalog untouched.
                    }
                }
                else
                    catalog.RemoveForDeletion(existing[random.Next(existing.Length)]);
                AssertExact(catalog);
            }
        }
    }

    [Fact]
    public void Writers_that_know_nothing_of_the_column_still_leave_it_exact()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("p", 10),
            SessionCatalogTests.Row("c", 20, "p"),
        ]);
        catalog.Dispose();
        // A direct writer, such as an older Main, changes only the columns it knows.
        using (var db = new SqliteConnection($"Data Source={catalog.FilePath};Pooling=False"))
        {
            db.Open();
            foreach (
                var sql in new[]
                {
                    "UPDATE session_catalog SET last_message_time=500 WHERE session_id='c'",
                    "UPDATE session_catalog SET parent_session_id=NULL WHERE session_id='c'",
                    "UPDATE session_catalog SET parent_session_id='c' WHERE session_id='p'",
                    "DELETE FROM session_catalog WHERE session_id='c'",
                }
            )
            {
                using var command = db.CreateCommand();
                command.CommandText = sql;
                command.ExecuteNonQuery();
            }
        }
        Assert.Equal(10, Maintained(catalog.FilePath)["p"]);
        Assert.Equal(Expected(catalog.FilePath), Maintained(catalog.FilePath));
    }

    [Fact]
    public void Opening_an_existing_catalog_adds_the_column_backfills_it_and_reopens_idempotently()
    {
        using var temp = new TempDirectory();
        string file;
        using (var catalog = new SessionCatalog(temp.Path))
        {
            catalog.Initialize();
            catalog.Upsert([
                SessionCatalogTests.Row("root", 10),
                SessionCatalogTests.Row("a", 20, "root"),
                SessionCatalogTests.Row("a/deep", 77, "a"),
                SessionCatalogTests.Row("b", 30, "root"),
                SessionCatalogTests.Row("self", 5, "self"),
                SessionCatalogTests.Row("cycle-a", 8, "cycle-b"),
                SessionCatalogTests.Row("cycle-b", 9, "cycle-a"),
                SessionCatalogTests.Row("lonely", 3, "missing"),
            ]);
            file = catalog.FilePath;
        }
        // Return the file to its shape before the column existed.
        using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = """
                DROP TRIGGER session_catalog_subtree_insert;
                DROP TRIGGER session_catalog_subtree_update;
                DROP TRIGGER session_catalog_subtree_delete;
                DROP INDEX idx_session_catalog_parent_subtree;
                DROP INDEX idx_session_catalog_root_activity;
                DROP INDEX idx_session_catalog_root_activity_default;
                DROP INDEX idx_session_catalog_parent_activity;
                DROP INDEX idx_session_catalog_parent_activity_default;
                DROP INDEX idx_session_catalog_agent_root_activity;
                DROP INDEX idx_session_catalog_agent_root_activity_default;
                DROP INDEX idx_session_catalog_node_root_activity;
                DROP INDEX idx_session_catalog_node_root_activity_default;
                ALTER TABLE session_catalog DROP COLUMN subtree_rank;
                ALTER TABLE session_catalog DROP COLUMN subtree_time;
                """;
            command.ExecuteNonQuery();
        }
        using var reopened = new SessionCatalog(temp.Path);
        reopened.Initialize();
        var times = Maintained(file);
        Assert.Equal(77, times["root"]);
        Assert.Equal(77, times["a"]);
        Assert.Equal(30, times["b"]);
        Assert.Equal(5, times["self"]);
        Assert.Equal(9, times["cycle-b"]);
        Assert.Equal(3, times["lonely"]);
        // Triggers are live again after the upgrade.
        reopened.Upsert([SessionCatalogTests.Row("b", 400, "root")]);
        Assert.Equal(400, Subtree(reopened, "root"));
        reopened.Dispose();
        using var again = new SessionCatalog(temp.Path);
        again.Initialize();
        Assert.Equal(400, Subtree(again, "root"));
        Assert.Equal(77, Subtree(again, "a"));
    }

    [Fact]
    public void Tree_pages_and_children_use_the_activity_indexes_without_sorting()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert(
            Enumerable
                .Range(0, 60)
                .Select(index => SessionCatalogTests.Row("p" + index, index))
                .Concat(
                    Enumerable
                        .Range(0, 60)
                        .Select(index => SessionCatalogTests.Row("c" + index, index, "p1"))
                )
        );
        foreach (var (index, sql) in new[]
        {
            (
                "idx_session_catalog_parent_activity",
                "SELECT metadata_json FROM session_catalog INDEXED BY idx_session_catalog_parent_activity WHERE parent_session_id=$p0 AND pinned=0 ORDER BY archived,subtree_rank,session_id LIMIT $p1"
            ),
            (
                "idx_session_catalog_parent_activity_default",
                "SELECT metadata_json FROM session_catalog INDEXED BY idx_session_catalog_parent_activity_default WHERE parent_session_id=$p0 AND pinned=0 ORDER BY archived,sidebar_order_missing,sidebar_order_value,subtree_rank,session_id LIMIT $p1"
            ),
        })
        {
            var plan = catalog.Explain(sql, "p1", 5);
            Assert.Contains(plan, line => line.Contains(index, StringComparison.Ordinal));
            Assert.DoesNotContain(plan, line => line.Contains("TEMP B-TREE", StringComparison.Ordinal));
        }
        foreach (var mode in new[] { "default", "time" })
        {
            var plan = catalog.Explain(
                "SELECT metadata_json FROM session_catalog WHERE presentation_root=1 ORDER BY pinned_rank,archived,"
                    + (mode == "default" ? "sidebar_order_missing,sidebar_order_value," : "")
                    + "subtree_rank,session_id LIMIT $p0",
                5
            );
            Assert.Contains(
                plan,
                line => line.Contains("idx_session_catalog_root_activity", StringComparison.Ordinal)
            );
            Assert.DoesNotContain(
                plan,
                line => line.Contains("TEMP B-TREE", StringComparison.Ordinal)
            );
        }
        var observed = new List<(string Sql, int Rows)>();
        catalog.QueryObserved = (sql, rows) => observed.Add((sql, rows));
        Assert.Equal(5, catalog.RecentChildCounts(["p1"], 0, 5)["p1"]);
        Assert.Equal(0, catalog.RecentChildCounts(["p2"], 0, 5)["p2"]);
        Assert.Contains(
            observed,
            item => item.Sql.Contains("idx_session_catalog_parent_activity", StringComparison.Ordinal)
        );
    }

    [Fact]
    public void Catalog_pages_order_tree_modes_by_activity_and_flat_by_own_time()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        var ordered = SessionCatalogTests.Row("ordered", 1);
        ordered["sidebarOrder"] = 1;
        catalog.Upsert([
            ordered,
            SessionCatalogTests.Row("quiet-parent", 10),
            SessionCatalogTests.Row("quiet-parent/hot", 100, "quiet-parent"),
            SessionCatalogTests.Row("newer-alone", 50),
            SessionCatalogTests.Row("oldest", 2),
        ]);
        Assert.Equal(
            ["ordered", "quiet-parent", "newer-alone", "oldest"],
            Ids(catalog.Page("default", 10, null, true, null).Rows)
        );
        Assert.Equal(
            ["quiet-parent", "newer-alone", "oldest", "ordered"],
            Ids(catalog.Page("time", 10, null, true, null).Rows)
        );
        // Flat and Architecture keep each Session's own time.
        Assert.Equal(
            ["quiet-parent/hot", "newer-alone", "quiet-parent", "oldest", "ordered"],
            Ids(catalog.Page("flat-time", 10, null, false, null).Rows)
        );
        Assert.Equal(
            ["newer-alone", "quiet-parent", "oldest", "ordered"],
            Ids(catalog.Page("time", 10, null, true, "main").Rows)
        );
    }

    [Fact]
    public void Child_windows_take_per_parent_limits_and_order_by_activity()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("p", 1),
            SessionCatalogTests.Row("q", 1),
            SessionCatalogTests.Row("p/quiet", 20, "p"),
            SessionCatalogTests.Row("p/quiet/hot", 90, "p/quiet"),
            SessionCatalogTests.Row("p/newer", 50, "p"),
            SessionCatalogTests.Row("p/old", 5, "p"),
            SessionCatalogTests.Row("q/a", 8, "q"),
            SessionCatalogTests.Row("q/b", 9, "q"),
        ]);
        var groups = catalog.Children(
            [("p", null), ("q", null)],
            "time",
            5,
            null,
            new Dictionary<string, int> { ["p"] = 2, ["q"] = 1 }
        );
        Assert.Equal(["p/quiet", "p/newer"], Ids(groups[0].Rows));
        Assert.True(groups[0].HasMore);
        Assert.Equal(3, groups[0].Total);
        Assert.Equal(["q/b"], Ids(groups[1].Rows));
        Assert.True(groups[1].HasMore);
    }
}
