using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

// Maintained subtree activity: max of a row's own last_message_time and every descendant's.
public sealed class SessionCatalogActivityTests
{
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

    private static double Subtree(SessionCatalog catalog, string id) =>
        catalog.SubtreeTimes([id])[id];






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


}
