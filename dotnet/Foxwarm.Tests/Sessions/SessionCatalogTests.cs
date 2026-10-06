using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionCatalogTests
{
    [Fact]
    public void Typed_queries_preserve_alias_ambiguity_raw_topology_counts_and_indexed_batches()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        var roots = new[]
        {
            Row("alpha/a", 30, "missing", "alpha", aliases: ["shared", "only-a"]),
            Row("alpha/b", 20, "alpha/a", "alpha", aliases: ["shared"]),
            Row("beta/c", 10, "alpha/a", "beta"),
            Row("self", 1, "self"),
            Row("cycle-a", 2, "cycle-b"),
            Row("cycle-b", 3, "cycle-a"),
        };
        roots[0]["busy"] = true;
        roots[1]["queueLength"] = 3;
        roots[2]["pinned"] = true;
        roots[0]["stats"] = new JsonObject { ["totalInputTokens"] = 17 };
        catalog.Upsert(roots);
        Assert.Equal("ambiguous", catalog.Resolve("shared")["kind"]!.GetValue<string>());
        Assert.Equal("alpha/a", catalog.Resolve("only-a")["sessionId"]!.GetValue<string>());
        Assert.Null(catalog.Presentation("alpha/a")!["parentSessionId"]);
        Assert.Equal("missing", catalog.Get("alpha/a")!["parentSessionId"]!.GetValue<string>());
        Assert.Null(catalog.Presentation("self")!["parentSessionId"]);
        Assert.Equal("self", catalog.Get("self")!["parentSessionId"]!.GetValue<string>());
        Assert.Equal(2, catalog.Paths(["cycle-a"])["cycle-a"].Length);
        Assert.Equal(6, catalog.Summary()["total"]!.GetValue<long>());
        Assert.Equal(1, catalog.Summary()["busy"]!.GetValue<long>());
        Assert.Equal(1, catalog.Summary()["queued"]!.GetValue<long>());
        Assert.Equal(17, catalog.Summary()["inputTokens"]!.GetValue<long>());
        Assert.Equal(1, catalog.ChildCounts(["alpha/a"])["alpha/a"]);
        Assert.Equal(1, catalog.ChildCounts(["alpha/a"], "beta")["alpha/a"]);
        Assert.Contains(
            catalog.Page("time", 20, null, true, "beta").Rows,
            row => row["id"]!.GetValue<string>() == "beta/c"
        );
        var update = Row("alpha/a", 40, null, "alpha", aliases: []);
        catalog.Upsert([update]);
        Assert.Equal("alias", catalog.Resolve("shared")["kind"]!.GetValue<string>());
        Assert.Equal(0, catalog.Summary()["busy"]!.GetValue<long>());
        Assert.Equal(0, catalog.Summary()["inputTokens"]!.GetValue<long>());
        Assert.Equal("missing", catalog.Resolve("only-a")["kind"]!.GetValue<string>());
        // An exact ID supersedes a previously ambiguous alias without rewriting its owners.
        catalog.Upsert([Row("shared", 0)]);
        Assert.Equal("exact", catalog.Resolve("shared")["kind"]!.GetValue<string>());
        catalog.Upsert(
            Enumerable.Range(0, 1500).Select(index => Row("child-" + index, index, "alpha/a"))
        );
        var observed = new List<(string Sql, int Rows)>();
        catalog.QueryObserved = (sql, rows) => observed.Add((sql, rows));
        var children = catalog.Children([("alpha/a", null), ("self", null)], "default", 4, null);
        Assert.Equal(1501, children[0].Total);
        Assert.Equal(4, children[0].Rows.Length);
        Assert.True(children[0].HasMore);
        var union = observed.Single(item =>
            item.Sql.Contains("UNION ALL", StringComparison.Ordinal)
        );
        Assert.InRange(union.Rows, 0, 10);
        var plan = catalog.Explain(
            "SELECT metadata_json FROM session_catalog INDEXED BY idx_session_catalog_parent_default WHERE parent_session_id=$p0 AND pinned=0 ORDER BY archived,sidebar_order_missing,sidebar_order_value,recent_rank,session_id LIMIT $p1",
            "alpha/a",
            5
        );
        Assert.Contains(
            plan,
            line =>
                line.Contains("SEARCH", StringComparison.Ordinal)
                && line.Contains("idx_session_catalog_parent_default", StringComparison.Ordinal)
        );
        Assert.DoesNotContain(plan, line => line.Contains("TEMP B-TREE", StringComparison.Ordinal));
        Assert.DoesNotContain(
            observed,
            item => item.Sql.Contains("ROW_NUMBER", StringComparison.Ordinal)
        );
    }

    [Fact]
    public void Projection_excludes_bodies_and_bounds_wait_without_erasing_ambiguity_or_valid_raw_settings()
    {
        var raw = Row("one", 4);
        raw["queue"] = new JsonArray(
            new JsonObject { ["type"] = "user", ["parts"] = new JsonArray("private queue") }
        );
        raw.Remove("queueLength");
        raw["history"] = new JsonArray("private history");
        raw["systemPromptFiles"] = new JsonArray("private files");
        raw["promptCacheKey"] = "private cache";
        raw["goalState"] = new JsonObject { ["goal"] = "private goal" };
        raw["indexingState"] = new JsonObject { ["secret"] = true };
        raw["effort"] = "none";
        raw["childEffortDefault"] = "max";
        raw["meta"]!["wait"] = new JsonObject
        {
            ["id"] = " wait ",
            ["reason"] = new string('r', 700),
            ["waitAnySessions"] = new JsonArray(
                Enumerable
                    .Range(0, 80)
                    .Select(index => (JsonNode?)JsonValue.Create("t" + index))
                    .ToArray()
            ),
            ["deferredQueue"] = new JsonArray("private deferred"),
        };
        raw["meta"]!["lastChannel"] = new JsonObject
        {
            ["platform"] = "source",
            ["conversationId"] = "room",
            ["message"] = "private channel",
        };
        raw["meta"]!["managedSession"] = new JsonObject
        {
            ["pendingInbox"] = new JsonArray("private inbox"),
        };
        var projected = SessionCatalog.Project(raw);
        Assert.DoesNotContain("private", projected.ToJsonString());
        Assert.Equal(1, projected["queueLength"]!.GetValue<double>());
        Assert.Equal(1, projected["managedPendingCount"]!.GetValue<double>());
        Assert.Equal(64, projected["meta"]!["wait"]!["waitAnySessions"]!.AsArray().Count);
        Assert.Equal(500, projected["meta"]!["wait"]!["reason"]!.GetValue<string>().Length);
        Assert.Equal("wait", projected["meta"]!["wait"]!["id"]!.GetValue<string>());
        Assert.Equal("none", projected["effort"]!.GetValue<string>());
        Assert.Equal("source", projected["meta"]!["lastChannel"]!["channelId"]!.GetValue<string>());
        raw["effort"] = null;
        Assert.Throws<InvalidDataException>(() => SessionCatalog.Project(raw));
    }

    [Fact]
    public async Task Metadata_queries_survive_owner_independence_and_clear_fork_use_actual_archive_counts()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new Foxwarm.Models.ResponsesClientOptions(
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
        var parent = await manager.CreateNamedAsync("main", "parent", "Before", null);
        await ForkClearLifecycleTests.AppendAsync(
            parent,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "one" }),
            }
        );
        var child = await manager.ForkAsync(parent, "copy");
        var runtime = new SessionRuntime(manager);
        var view = new SessionListQueries(runtime);
        runtime.SemanticOwnerLookupObserved = _ =>
            throw new InvalidOperationException(
                "Metadata request attempted semantic owner lookup."
            );
        Assert.Equal(
            child.Archive.ReadMessages().Count,
            view.Projection(child.Id)!["sequenceMessageCount"]!.GetValue<long>()
        );
        await manager.ClearAsync(parent);
        Assert.Equal(0, view.Projection(parent.Id)!["messageCount"]!.GetValue<int>());
        Assert.Equal(1, view.Projection(parent.Id)!["sequenceMessageCount"]!.GetValue<long>());
        var bytes = File.ReadAllBytes(Path.Combine(data, "state", "sessions", parent.Id + ".json"));
        await runtime.UpdateDisplayNameAsync(parent.Id, "After");
        Assert.Equal(
            bytes,
            File.ReadAllBytes(Path.Combine(data, "state", "sessions", parent.Id + ".json"))
        );
        // Real Main-only list requests remain valid without an active Owner/History lookup.
        File.Move(
            Path.Combine(data, "state", "sessions", parent.Id + ".json"),
            Path.Combine(data, "state", "sessions", parent.Id + ".held")
        );
        Assert.Equal(
            "After",
            view.Exact([parent.Id], true)["results"]![0]!["session"]![
                "displayName"
            ]!.GetValue<string>()
        );
        Assert.Equal(2, view.GlobalSummary()["total"]!.GetValue<long>());
        await parent.Entry.SaveLane.SaveStrictAsync();
        Assert.Equal("After", manager.Catalog.Get(parent.Id)!["displayName"]!.GetValue<string>());
        var rewritten = JsonNode.Parse(
            File.ReadAllText(Path.Combine(data, "state", "sessions", parent.Id + ".json"))
        )!;
        Assert.Equal("After", rewritten["displayName"]!.GetValue<string>());
        Assert.False(rewritten.AsObject().ContainsKey("pinned"));
    }

    [Theory]
    [InlineData("İSTANBUL", "i\u0307stanbul")]
    [InlineData("ΟΣ", "ος")]
    [InlineData("ΟΣΑ", "οσα")]
    [InlineData("ΟΣ'", "ος'")]
    [InlineData("ΟΣ\u0307Α", "οσ\u0307α")]
    [InlineData("\U00010400", "\U00010428")]
    public void Source_search_full_lowercase_is_locale_independent(string input, string expected) =>
        Assert.Equal(expected, SourceStringLower.Lower(input));

    internal static JsonObject Row(
        string id,
        int time,
        string? parent = null,
        string agent = "main",
        string[]? aliases = null
    )
    {
        var row = new JsonObject
        {
            ["id"] = id,
            ["agent"] = agent,
            ["aliases"] = new JsonArray(
                (aliases ?? []).Select(alias => (JsonNode?)JsonValue.Create(alias)).ToArray()
            ),
            ["busy"] = false,
            ["queueLength"] = 0,
            ["meta"] = new JsonObject { ["lastMessageTime"] = time, ["messageCount"] = 0 },
        };
        if (parent is not null)
            row["parentSessionId"] = parent;
        return row;
    }
}
