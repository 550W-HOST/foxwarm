using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Compares the hosted catalog with the file catalog over a copy of a real catalog. Set
/// FOXWARM_TEST_GOLDEN_CATALOG to a <c>catalog.sqlite</c>; the test copies it, imports its rows
/// into a disposable tenant as stored and compares every list, tree, group, descendant, summary and count
/// read, walking each paged read to its end with the cursors the list routes build. Without the
/// variable the test does nothing. Its output reports counts only.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PostgresSessionCatalogGoldenTests(ITestOutputHelper output)
{
    internal const string Variable = "FOXWARM_TEST_GOLDEN_CATALOG";

    private sealed class Comparison
    {
        internal int Checks;
        internal readonly List<string> Failures = [];

        internal void Same(string what, JsonNode? file, JsonNode? hosted)
        {
            Checks++;
            if (!JsonNode.DeepEquals(file, hosted))
                Failures.Add(what + " at " + Difference(file, hosted, "$"));
        }

        // The JSON path of the first difference, with array positions and without values,
        // so a report names the field without carrying the catalog's content.
        private static string Difference(JsonNode? file, JsonNode? hosted, string path)
        {
            if (file is JsonObject a && hosted is JsonObject b)
            {
                foreach (var key in a.Select(pair => pair.Key).Union(b.Select(pair => pair.Key)).Order(StringComparer.Ordinal))
                    if (!JsonNode.DeepEquals(a[key], b[key]))
                        return a.ContainsKey(key) != b.ContainsKey(key)
                            ? path + "." + key + (a.ContainsKey(key) ? " (only in file)" : " (only in hosted)")
                            : Difference(a[key], b[key], path + "." + key);
                return path + " (key order)";
            }
            if (file is JsonArray x && hosted is JsonArray y)
            {
                if (x.Count != y.Count)
                    return path + $" (length {x.Count} vs {y.Count})";
                for (var index = 0; index < x.Count; index++)
                    if (!JsonNode.DeepEquals(x[index], y[index]))
                        return Difference(x[index], y[index], path + $"[{index}]");
            }
            return path + $" ({file?.GetValueKind().ToString() ?? "null"} vs {hosted?.GetValueKind().ToString() ?? "null"})";
        }

        internal void SameItems<T>(string what, IEnumerable<T> file, IEnumerable<T> hosted)
        {
            Checks++;
            if (!file.SequenceEqual(hosted))
                Failures.Add(what);
        }
    }

    private static JsonArray Json(IEnumerable<JsonObject> rows) =>
        new(rows.Select(row => (JsonNode?)row.DeepClone()).ToArray());

    private static JsonNode Json<TValue>(IReadOnlyDictionary<string, TValue> values) =>
        new JsonObject(
            values
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .Select(pair => KeyValuePair.Create(pair.Key, JsonValueOf(pair.Value)))
        );

    private static JsonNode? JsonValueOf<TValue>(TValue value) =>
        value switch
        {
            JsonNode node => node.DeepClone(),
            string[] texts => new JsonArray(texts.Select(text => (JsonNode?)text).ToArray()),
            _ => JsonValue.Create(value),
        };

    [Fact]
    public void Every_read_over_a_real_catalog_matches_the_file_catalog()
    {
        var source = Environment.GetEnvironmentVariable(Variable);
        if (string.IsNullOrEmpty(source))
        {
            output.WriteLine($"{Variable} is not set; nothing compared.");
            return;
        }
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
        File.Copy(source, file);
        using var files = new SessionCatalog(temp.Path);
        files.Initialize();
        using var fixture = PostgresCatalogFixture.Open();
        var hosted = new PgSessionCatalog(fixture.Tenant);
        var all = files.List();
        foreach (var chunk in all.Chunk(200))
            hosted.Import(chunk);
        var ids = all.Select(row => row["id"]!.GetValue<string>()).ToArray();
        var compare = new Comparison();

        // The order key of one row as the list routes put it in a cursor: the order columns.
        using var keys = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
        keys.Open();
        JsonArray Cursor(JsonObject row, string[] columns)
        {
            using var command = keys.CreateCommand();
            command.CommandText =
                $"SELECT {string.Join(',', columns)} FROM session_catalog WHERE session_id=$id";
            command.Parameters.AddWithValue("$id", row["id"]!.GetValue<string>());
            using var reader = command.ExecuteReader();
            Assert.True(reader.Read());
            var key = new JsonArray();
            for (var index = 0; index < columns.Length - 1; index++)
                key.Add(reader.GetDouble(index));
            key.Add(reader.GetString(columns.Length - 1));
            return key;
        }

        // Rows, summaries and counts.
        compare.Same("list", Json(files.List()), Json(hosted.List()));
        compare.Same("summary", files.Summary(out var fileCost), hosted.Summary(out var hostedCost));
        compare.SameItems("summary cost count", [fileCost], [hostedCost]);
        compare.Same("agent counts", files.AgentCounts(), hosted.AgentCounts());
        compare.SameItems(
            "agent activity",
            files.AgentActivityCounts().OrderBy(pair => pair.Key, StringComparer.Ordinal),
            hosted.AgentActivityCounts().OrderBy(pair => pair.Key, StringComparer.Ordinal)
        );
        foreach (var by in new[] { "agent", "node" })
        foreach (var tree in new[] { true, false })
            compare.Same($"group counts {by}/{tree}", Json(files.GroupCounts(by, tree)), Json(hosted.GroupCounts(by, tree)));
        compare.SameItems("count", [files.Count()], [hosted.Count()]);
        var agents = all.Select(row => row["agent"]!.GetValue<string>()).Distinct().Order(StringComparer.Ordinal).ToArray();
        var nodes = all.Select(row => SessionCatalog.Text(row["currentNode"]) ?? "").Distinct().Order(StringComparer.Ordinal).ToArray();
        foreach (var agent in agents)
        {
            compare.SameItems("count agent", [files.Count(agent: agent)], [hosted.Count(agent: agent)]);
            compare.Same("offset page agent", Json(files.OffsetPage(5, 1, agent: agent)), Json(hosted.OffsetPage(5, 1, agent: agent)));
        }
        foreach (var id in ids)
            compare.SameItems("count parent", [files.Count(parent: id)], [hosted.Count(parent: id)]);
        foreach (var batch in ids.Chunk(100))
        {
            compare.Same("child counts", Json(files.ChildCounts(batch)), Json(hosted.ChildCounts(batch)));
            foreach (var agent in agents)
                compare.Same("child counts agent", Json(files.ChildCounts(batch, agent)), Json(hosted.ChildCounts(batch, agent)));
            compare.Same("subtree times", Json(files.SubtreeTimes(batch)), Json(hosted.SubtreeTimes(batch)));
            compare.Same("recent child counts", Json(files.RecentChildCounts(batch, 0, 5)), Json(hosted.RecentChildCounts(batch, 0, 5)));
            compare.Same("paths", Json(files.Paths(batch)), Json(hosted.Paths(batch)));
            compare.Same("scopes", Json(files.Scopes(batch)), Json(hosted.Scopes(batch)));
            compare.Same("resolve many", Json(files.ResolveMany(batch)), Json(hosted.ResolveMany(batch)));
            compare.Same("get many", Json(files.GetMany(batch)), Json(hosted.GetMany(batch)));
            compare.Same("group keys agent", Json(files.GroupKeys(batch, "agent")), Json(hosted.GroupKeys(batch, "agent")));
            compare.Same("group keys node", Json(files.GroupKeys(batch, "node")), Json(hosted.GroupKeys(batch, "node")));
            compare.Same("busy descendants", Json(files.BusyDescendants(batch, ids)), Json(hosted.BusyDescendants(batch, ids)));
        }
        // Selections without a defined order compare as sets.
        compare.SameItems("restart", files.RestartIds().Order(StringComparer.Ordinal), hosted.RestartIds());
        compare.SameItems("approvals", files.PendingApprovalIds().Order(StringComparer.Ordinal), hosted.PendingApprovalIds());
        compare.SameItems("waits", files.RecentWaitIds(0).Order(StringComparer.Ordinal), hosted.RecentWaitIds(0));
        compare.Same("questions", Json(files.QuestionRows(50)), Json(hosted.QuestionRows(50)));
        compare.SameItems(
            "sequence",
            files.SequenceSessions().OrderBy(row => row.Id, StringComparer.Ordinal),
            hosted.SequenceSessions()
        );
        foreach (var id in ids)
        {
            compare.Same("get", files.Get(id), hosted.Get(id));
            compare.Same("presentation", files.Presentation(id), hosted.Presentation(id));
            compare.SameItems("path ids", files.PathIds(id), hosted.PathIds(id));
            compare.Same("resolve", files.Resolve(id), hosted.Resolve(id));
            compare.Same("identity children", Json(files.IdentityChildren(id)), Json(hosted.IdentityChildren(id)));
            var fileTree = files.Descendants(id, 20);
            var hostedTree = hosted.Descendants(id, 20);
            compare.Same("descendants summary", fileTree.Summary, hostedTree.Summary);
            compare.Same("descendants rows", Json(fileTree.Rows), Json(hostedTree.Rows));
            compare.SameItems("descendants cost count", [fileTree.CostCount], [hostedTree.CostCount]);
            compare.SameItems(
                "filter descendants",
                files.FilterDescendants(id, ids).Order(StringComparer.Ordinal),
                hosted.FilterDescendants(id, ids).Order(StringComparer.Ordinal)
            );
            Exception? fileError = null,
                hostedError = null;
            DeleteSelection? fileSelection = null,
                hostedSelection = null;
            try { fileSelection = files.SelectDeletion(id, true); } catch (SessionPresentationException error) { fileError = error; }
            try { hostedSelection = hosted.SelectDeletion(id, true); } catch (SessionPresentationException error) { hostedError = error; }
            compare.SameItems("deletion error", [fileError?.Message], [hostedError?.Message]);
            if (fileSelection is not null && hostedSelection is not null)
            {
                compare.SameItems("deletion targets", fileSelection.Targets, hostedSelection.Targets);
                compare.SameItems("deletion post", fileSelection.Post, hostedSelection.Post);
                compare.SameItems("deletion direct", fileSelection.Direct, hostedSelection.Direct);
            }
        }

        // Paged reads, walked to the end with small pages.
        void Walk(string what, Func<JsonArray?, ISessionCatalogStore, CatalogPage> page, string[] columns)
        {
            JsonArray? after = null;
            var pages = 0;
            while (true)
            {
                var a = page(after, files);
                var b = page(after, hosted);
                compare.Same(what, Json(a.Rows), Json(b.Rows));
                compare.SameItems(what + " more", [a.HasMore], [b.HasMore]);
                if (!a.HasMore || a.Rows.Length == 0 || ++pages > 500)
                    break;
                after = Cursor(a.Rows[^1], columns);
            }
        }
        foreach (var mode in new[] { "default", "time", "flat-time" })
        {
            var activity = mode != "flat-time";
            Walk($"page {mode}", (after, store) => store.Page(mode, 7, after, mode != "flat-time", null), SessionCatalog.OrderColumns(mode, false, activity));
            Walk($"pinned {mode}", (after, store) => store.Page(mode, 3, after, true, null, pinnedOnly: true), SessionCatalog.OrderColumns(mode, false, activity));
            foreach (var agent in agents)
                Walk($"forest {mode}", (after, store) => store.Page(mode, 5, after, true, agent), SessionCatalog.OrderColumns(mode, false, false));
            foreach (var (by, keysOf) in new[] { ("agent", agents), ("node", nodes) })
            foreach (var key in keysOf)
            {
                var exclude = by == "agent" ? SessionCatalog.AgentMainId(key) : null;
                Walk($"group {by} {mode}", (after, store) => store.GroupPage(by, key, mode, 4, after, exclude), SessionCatalog.OrderColumns(mode, true, activity));
            }
            // Child windows for every row, in batches, each parent continued to its end.
            foreach (var batch in ids.Chunk(100))
            {
                var pending = batch.Select(id => (id, (JsonArray?)null)).ToList();
                for (var round = 0; pending.Count > 0 && round < 200; round++)
                {
                    var a = files.Children(pending, mode, 3, null);
                    var b = hosted.Children(pending, mode, 3, null);
                    var next = new List<(string, JsonArray?)>();
                    for (var index = 0; index < a.Length; index++)
                    {
                        compare.Same($"children {mode}", Json(a[index].Rows), Json(b[index].Rows));
                        compare.SameItems($"children {mode} total", [a[index].Total, a[index].HasMore ? 1 : 0], [b[index].Total, b[index].HasMore ? 1 : 0]);
                        if (a[index].HasMore && a[index].Rows.Length > 0)
                            next.Add((a[index].Parent, Cursor(a[index].Rows[^1], SessionCatalog.OrderColumns(mode, true, activity))));
                    }
                    pending = next;
                }
            }
        }
        foreach (var batch in ids.Chunk(100))
        foreach (var agent in agents)
        {
            var a = files.Children(batch.Select(id => (id, (JsonArray?)null)).ToArray(), "time", 5, agent);
            var b = hosted.Children(batch.Select(id => (id, (JsonArray?)null)).ToArray(), "time", 5, agent);
            for (var index = 0; index < a.Length; index++)
            {
                compare.Same("forest children", Json(a[index].Rows), Json(b[index].Rows));
                compare.SameItems("forest children total", [a[index].Total], [b[index].Total]);
            }
        }

        // The same presentation and deletion writes on both, then the rows and maintained counts.
        string Outcome(Func<object?> write)
        {
            try
            {
                return write() switch
                {
                    PresentationChange change => change.Result.ToJsonString() + string.Join(",", change.ChangedIds),
                    var value => value?.ToString() ?? "",
                };
            }
            catch (SessionPresentationException error)
            {
                return error.Code;
            }
            catch (InvalidDataException error)
            {
                return error.Message;
            }
        }
        var random = new Random(20261126);
        for (var step = 0; step < 120; step++)
        {
            var current = files.List().Select(row => row["id"]!.GetValue<string>()).ToArray();
            var id = current[random.Next(current.Length)];
            var other = current[random.Next(current.Length)];
            var flag = random.Next(2) == 0;
            Func<ISessionCatalogStore, object?> write = random.Next(7) switch
            {
                0 => store => store.Pin(id, flag),
                1 => store => store.Archive(id, flag, descendants: true),
                2 => store => store.Move(id, new JsonObject { ["position"] = flag ? "first" : "last" }),
                3 => store => store.Move(id, new JsonObject { ["afterSessionId"] = other }),
                4 => store => store.Move(id, new JsonObject(), promote: true),
                5 => store => store.SetParent(id, flag ? null : other),
                _ => store =>
                {
                    store.RemoveForDeletion(id);
                    return null;
                },
            };
            compare.SameItems("write outcome", [Outcome(() => write(files))], [Outcome(() => write(hosted))]);
        }
        compare.Same("list after writes", Json(files.List()), Json(hosted.List()));
        compare.Same("summary after writes", files.Summary(), hosted.Summary());
        compare.Same("agent counts after writes", files.AgentCounts(), hosted.AgentCounts());
        foreach (var by in new[] { "agent", "node" })
        foreach (var tree in new[] { true, false })
            compare.Same($"group counts after writes {by}/{tree}", Json(files.GroupCounts(by, tree)), Json(hosted.GroupCounts(by, tree)));
        var remaining = files.List().Select(row => row["id"]!.GetValue<string>()).ToArray();
        foreach (var batch in remaining.Chunk(100))
        {
            compare.Same("child counts after writes", Json(files.ChildCounts(batch)), Json(hosted.ChildCounts(batch)));
            compare.Same("subtree times after writes", Json(files.SubtreeTimes(batch)), Json(hosted.SubtreeTimes(batch)));
        }
        foreach (var mode in new[] { "default", "time", "flat-time" })
            compare.Same($"first page after writes {mode}", Json(files.Page(mode, 50, null, mode != "flat-time", null).Rows), Json(hosted.Page(mode, 50, null, mode != "flat-time", null).Rows));

        var kinds = compare.Failures.GroupBy(failure => failure).Select(group => $"{group.Key}: {group.Count()}");
        output.WriteLine($"{all.Length} rows, {compare.Checks} comparisons, {compare.Failures.Count} differences.");
        foreach (var kind in kinds)
            output.WriteLine("  " + kind);
        Assert.Empty(compare.Failures);
    }
}
