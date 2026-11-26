using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

/// <summary>
/// Observable behavior every <see cref="ISessionCatalogStore"/> shares: projection, aliases and
/// topology, maintained counts and subtree activity, list, tree and group pages, presentation
/// mutations, identity rewrites and deletion. The checks of maintained values compare the
/// stored tables, read with SQL both backends accept, against a recomputation. File-only
/// behavior (SQLite plans and statements, migration and upgrade of earlier layouts, direct
/// SQLite writers) stays in the <c>SessionCatalog*Tests</c> classes.
/// </summary>
public abstract class SessionCatalogContractTests(ITestOutputHelper output)
{
    private protected abstract CatalogUnderTest Create();

    /// <summary>One catalog's storage; <see cref="Reopen"/> opens a new store over it.</summary>
    private protected sealed class CatalogUnderTest(
        Func<ISessionCatalogStore> open,
        Func<string, List<object?[]>> query,
        Action dispose
    ) : IDisposable
    {
        private ISessionCatalogStore store = open();

        internal ISessionCatalogStore Store => store;

        internal ISessionCatalogStore Reopen()
        {
            store.Dispose();
            store = open();
            return store;
        }

        /// <summary>Rows of a plain SELECT over the catalog tables.</summary>
        internal List<object?[]> Query(string sql) => query(sql);

        public void Dispose()
        {
            store.Dispose();
            dispose();
        }
    }

    private static JsonObject Row(
        string id,
        int time,
        string? parent = null,
        string agent = "main",
        string[]? aliases = null
    ) => SessionCatalogTests.Row(id, time, parent, agent, aliases);

    private static JsonObject NodeRow(
        string id,
        int time,
        string? parent = null,
        string agent = "main",
        string node = "master",
        double? order = null
    )
    {
        var row = Row(id, time, parent, agent);
        row["currentNode"] = node;
        if (order is not null)
            row["sidebarOrder"] = order;
        return row;
    }

    private static string[] Ids(IEnumerable<JsonObject> rows) =>
        rows.Select(row => row["id"]!.GetValue<string>()).ToArray();

    private static double Subtree(ISessionCatalogStore catalog, string id) =>
        catalog.SubtreeTimes([id])[id];

    private static long Integer(object? value) => Convert.ToInt64(value);

    private static double Real(object? value) => Convert.ToDouble(value);

    // Every maintained value against a full recomputation from the stored rows: the summary
    // row, the Agent, parent, parent-Agent and Node counts, and subtree activity.
    private static void AssertMaintained(CatalogUnderTest subject)
    {
        var rows = subject
            .Query(
                "SELECT session_id,agent,parent_session_id,pinned,busy,queue_length,managed_pending_count,"
                    + "cached_tokens,input_tokens,output_tokens,cost,current_node,last_message_time,subtree_time FROM session_catalog"
            )
            .Select(values => new
            {
                Id = (string)values[0]!,
                Agent = (string)values[1]!,
                Parent = values[2] as string,
                Pinned = Integer(values[3]) == 1,
                Busy = Integer(values[4]),
                Queue = Integer(values[5]),
                Managed = Integer(values[6]),
                Cached = Integer(values[7]),
                Input = Integer(values[8]),
                Output = Integer(values[9]),
                Cost = values[10] is null ? (double?)null : Real(values[10]),
                Node = (string)values[11]!,
                Time = Real(values[12]),
                Subtree = Real(values[13]),
            })
            .ToArray();
        static string[] Sorted(IEnumerable<string> values) =>
            values.OrderBy(value => value, StringComparer.Ordinal).ToArray();
        string[] Table(string sql) =>
            Sorted(subject.Query(sql).Select(values => string.Join("|", values.Select(Format))));
        static string Format(object? value) =>
            value switch
            {
                null => "null",
                double number => number.ToString("R", System.Globalization.CultureInfo.InvariantCulture),
                float number => ((double)number).ToString("R", System.Globalization.CultureInfo.InvariantCulture),
                _ => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)!,
            };
        Assert.Equal(
            Sorted(rows.GroupBy(row => row.Agent, StringComparer.Ordinal).Select(group => $"{group.Key}|{group.Count()}")),
            Table("SELECT agent,session_count FROM catalog_agent_count")
        );
        Assert.Equal(
            Sorted(
                rows.GroupBy(row => row.Parent ?? "", StringComparer.Ordinal)
                    .Select(group => $"{group.Key}|{group.Count()}|{group.Count(row => !row.Pinned)}")
            ),
            Table("SELECT parent_key,session_count,unpinned_session_count FROM catalog_parent_count")
        );
        Assert.Equal(
            Sorted(
                rows.GroupBy(row => (row.Parent ?? "") + "|" + row.Agent, StringComparer.Ordinal)
                    .Select(group => $"{group.Key}|{group.Count()}")
            ),
            Table("SELECT parent_key,agent,session_count FROM catalog_parent_agent_count")
        );
        Assert.Equal(
            Sorted(
                rows.GroupBy(row => row.Node, StringComparer.Ordinal)
                    .Select(group => $"{group.Key}|{group.Count()}|{group.Count(row => row.Parent is null)}")
            ),
            Table("SELECT current_node,session_count,root_count FROM catalog_node_count")
        );
        var summary = subject.Query(
            "SELECT session_count,busy_count,queued_count,managed_count,cached_tokens,input_tokens,output_tokens,cost_count,positive_cost_count FROM catalog_count"
        );
        var expected = new long[]
        {
            rows.Length,
            rows.Sum(row => row.Busy),
            rows.Count(row => row.Queue > 0),
            rows.Count(row => row.Managed > 0),
            rows.Sum(row => row.Cached),
            rows.Sum(row => row.Input),
            rows.Sum(row => row.Output),
            rows.Count(row => row.Cost is not null),
            rows.Count(row => row.Cost > 0),
        };
        // A backend without a summary row yet has never held a Session.
        Assert.Equal(expected, summary.Count == 0 ? new long[expected.Length] : summary[0].Select(Integer).ToArray());
        // Subtree activity: own time raised by every descendant reachable through real parents.
        var own = rows.ToDictionary(row => row.Id, row => row.Time, StringComparer.Ordinal);
        var parents = rows.ToDictionary(row => row.Id, row => row.Parent, StringComparer.Ordinal);
        var activity = new Dictionary<string, double>(own, StringComparer.Ordinal);
        foreach (var (id, time) in own)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal) { id };
            var current = parents[id];
            while (current is not null && own.ContainsKey(current) && seen.Add(current))
            {
                activity[current] = Math.Max(activity[current], time);
                current = parents[current];
            }
        }
        Assert.Equal(
            activity.OrderBy(pair => pair.Key, StringComparer.Ordinal),
            rows.ToDictionary(row => row.Id, row => row.Subtree, StringComparer.Ordinal)
                .OrderBy(pair => pair.Key, StringComparer.Ordinal)
        );
    }

    // Whether following raw parent references from `from` meets `target`. Tolerated legacy
    // cycles are outside the exactness claim.
    private static bool Reaches(ISessionCatalogStore catalog, string from, string target)
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

    [Fact]
    public void Typed_queries_preserve_alias_ambiguity_raw_topology_counts_and_batches()
    {
        using var subject = Create();
        var catalog = subject.Store;
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
        Assert.Equal(
            ["alpha/a", "alpha/b"],
            catalog.Resolve("shared")["sessionIds"]!.AsArray().Select(id => id!.GetValue<string>())
        );
        Assert.Equal("alpha/a", catalog.Resolve("only-a")["sessionId"]!.GetValue<string>());
        Assert.Null(catalog.Presentation("alpha/a")!["parentSessionId"]);
        Assert.Equal("missing", catalog.Get("alpha/a")!["parentSessionId"]!.GetValue<string>());
        Assert.Null(catalog.Presentation("self")!["parentSessionId"]);
        Assert.Equal("self", catalog.Get("self")!["parentSessionId"]!.GetValue<string>());
        Assert.Equal(2, catalog.Paths(["cycle-a"])["cycle-a"].Length);
        Assert.Equal(["alpha/a", "alpha/b"], catalog.PathIds("alpha/b"));
        Assert.Equal(6, catalog.Summary()["total"]!.GetValue<long>());
        Assert.Equal(1, catalog.Summary()["busy"]!.GetValue<long>());
        Assert.Equal(1, catalog.Summary()["queued"]!.GetValue<long>());
        Assert.Equal(17, catalog.Summary()["inputTokens"]!.GetValue<long>());
        Assert.Equal(1, catalog.ChildCounts(["alpha/a"])["alpha/a"]);
        Assert.Equal(1, catalog.ChildCounts(["alpha/a"], "beta")["alpha/a"]);
        Assert.Equal(3, catalog.Count(agent: "main"));
        Assert.Equal(2, catalog.Count(parent: "alpha/a"));
        Assert.Equal(["alpha/a", "alpha/b"], catalog.RestartIds());
        Assert.Contains(
            catalog.Page("time", 20, null, true, "beta").Rows,
            row => row["id"]!.GetValue<string>() == "beta/c"
        );
        AssertMaintained(subject);
        var update = Row("alpha/a", 40, null, "alpha", aliases: []);
        catalog.Upsert([update]);
        Assert.Equal("alias", catalog.Resolve("shared")["kind"]!.GetValue<string>());
        Assert.Equal(0, catalog.Summary()["busy"]!.GetValue<long>());
        Assert.Equal(0, catalog.Summary()["inputTokens"]!.GetValue<long>());
        Assert.Equal("missing", catalog.Resolve("only-a")["kind"]!.GetValue<string>());
        // An exact ID supersedes a previously ambiguous alias without rewriting its owners.
        catalog.Upsert([Row("shared", 0)]);
        Assert.Equal("exact", catalog.Resolve("shared")["kind"]!.GetValue<string>());
        catalog.Upsert(Enumerable.Range(0, 150).Select(index => Row("child-" + index, index, "alpha/a")));
        var children = catalog.Children([("alpha/a", null), ("self", null)], "default", 4, null);
        Assert.Equal(151, children[0].Total);
        Assert.Equal(4, children[0].Rows.Length);
        Assert.True(children[0].HasMore);
        Assert.Equal(["child-149", "child-148", "child-147", "child-146"], Ids(children[0].Rows));
        Assert.Empty(children[1].Rows);
        Assert.False(children[1].HasMore);
        var next = catalog.Children(
            [("alpha/a", new JsonArray(0, -146, "child-146"))],
            "flat-time",
            2,
            null
        );
        Assert.Equal(["child-145", "child-144"], Ids(next[0].Rows));
        AssertMaintained(subject);
    }

    [Fact]
    public void Batch_lookups_resolve_exact_alias_ambiguous_and_missing_keys_and_reject_oversized_batches()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Upsert([
            Row("one", 1, aliases: ["first", "shared"]),
            Row("two", 2, "first", aliases: ["shared"]),
            Row("three", 3, "two", "beta"),
        ]);
        var resolved = catalog.ResolveMany(["one", "first", "shared", "absent", "one"]);
        Assert.Equal("exact", resolved["one"]["kind"]!.GetValue<string>());
        Assert.Equal("one", resolved["first"]["sessionId"]!.GetValue<string>());
        Assert.Equal("ambiguous", resolved["shared"]["kind"]!.GetValue<string>());
        Assert.Equal("missing", resolved["absent"]["kind"]!.GetValue<string>());
        Assert.Equal(["three", "one"], Ids(catalog.GetMany(["three", "absent", "one", "three"])));
        var scopes = catalog.Scopes(["three", "one"]);
        Assert.Equal("main", scopes["three"]["parentAgent"]!.GetValue<string>());
        Assert.Null(scopes["one"]["parentSessionId"]);
        Assert.Equal(["one", "two", "three"], catalog.Paths(["three"])["three"]);
        Assert.Equal(["three", "two"], catalog.FilterDescendants("one", ["two", "three", "one", "absent"]).Order(StringComparer.Ordinal));
        Assert.Equal(
            new Dictionary<string, int> { ["one"] = 1, ["two"] = 1, ["three"] = 0 },
            catalog.BusyDescendants(["one", "two", "three"], ["three"])
        );
        Assert.Equal(["two"], Ids(catalog.IdentityChildren("first")));
        Assert.Equal(
            "[{\"agent\":\"beta\",\"count\":1},{\"agent\":\"main\",\"count\":2}]",
            catalog.AgentCounts().ToJsonString()
        );
        Assert.Equal((2, 0, 0), catalog.AgentActivityCounts()["main"]);
        Assert.Equal(["one", "three", "two"], catalog.SequenceSessions().Select(row => row.Id).Order(StringComparer.Ordinal));
        Assert.Throws<InvalidDataException>(() =>
            catalog.GetMany(Enumerable.Range(0, 201).Select(index => "s" + index))
        );
        Assert.Throws<InvalidDataException>(() =>
            catalog.Children(Enumerable.Range(0, 101).Select(index => ("s" + index, (JsonArray?)null)).ToArray(), "time", 1, null)
        );
        Assert.Throws<InvalidDataException>(() =>
            catalog.Children([("one", null)], "default", 1, "main")
        );
        Assert.Throws<InvalidDataException>(() => catalog.GroupCounts("other", true));
    }

    [Fact]
    public void Keys_no_row_can_hold_read_as_missing()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Upsert([Row("one", 1)]);
        const string nul = "on\0e";
        Assert.Null(catalog.Get(nul));
        Assert.Equal("missing", catalog.Resolve(nul)["kind"]!.GetValue<string>());
        Assert.Equal("missing", catalog.ResolveMany([nul])[nul]["kind"]!.GetValue<string>());
        Assert.Empty(catalog.GetMany([nul]));
        Assert.Null(catalog.Presentation(nul));
        Assert.Empty(catalog.PathIds(nul));
        Assert.Empty(catalog.Paths([nul]));
        Assert.Empty(catalog.Scopes([nul]));
        Assert.Equal(0, catalog.Count(agent: nul));
        Assert.Empty(catalog.ChildCounts([nul]));
        var children = Assert.Single(catalog.Children([(nul, null)], "time", 5, null));
        Assert.Empty(children.Rows);
        Assert.Equal(0, children.Total);
        Assert.Empty(catalog.Page("time", 5, null, true, nul).Rows);
        Assert.Equal(["one"], Ids(catalog.GroupPage("agent", "main", "time", 5, null, "\0").Rows));
        Assert.Empty(catalog.GroupPage("agent", nul, "time", 5, null, null).Rows);
        Assert.Empty(catalog.SubtreeTimes([nul]));
        Assert.Throws<SessionPresentationException>(() => catalog.Pin(nul, true));
    }

    [Fact]
    public void Cost_projection_summaries_keep_fractional_known_zero_and_all_unknown_distinct_across_updates_and_deletion()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        var root = Row("root", 0);
        var unknown = Row("unknown", 1, "root");
        var zero = Row("zero", 2, "root");
        zero["stats"] = new JsonObject
        {
            ["totalCost"] = 0,
            ["lastUsage"] = new JsonObject { ["cost"] = 0 },
        };
        var priced = Row("priced", 3, "root");
        priced["stats"] = new JsonObject
        {
            ["totalCost"] = .125,
            ["lastUsage"] = new JsonObject { ["cost"] = .125 },
        };
        catalog.Upsert([root, unknown]);
        Assert.Null(catalog.Summary()["cost"]);
        Assert.Null(catalog.Descendants("root", 10).Summary["cost"]);
        var other = Row("other", 4, "root");
        other["stats"] = new JsonObject { ["totalCost"] = .25 };
        unknown["meta"]!["lastMessageTime"] = 5;
        catalog.Upsert([zero, priced, other, unknown]);
        Assert.Equal(.375, SessionCatalog.Number(catalog.Summary()["cost"]));
        Assert.Equal(.375, SessionCatalog.Number(catalog.Descendants("root", 1).Summary["cost"]));
        Assert.Equal(
            0,
            SessionCatalog.Number(catalog.Get("zero")?["stats"]?["lastUsage"]?["cost"])
        );
        Assert.Null(catalog.Get("unknown")?["stats"]?["totalCost"]);
        priced["stats"]!["totalCost"] = .375;
        catalog.Upsert([priced]);
        Assert.Equal(.625, SessionCatalog.Number(catalog.Summary()["cost"]));
        Assert.Equal(.625, SessionCatalog.Number(catalog.Descendants("root", 1).Summary["cost"]));
        var descendants = catalog.Descendants("root", 2);
        Assert.Equal(4, descendants.Summary["total"]!.GetValue<long>());
        Assert.Equal(3, descendants.CostCount);
        Assert.Equal(["unknown", "other"], Ids(descendants.Rows));
        catalog.RemoveForDeletion("priced");
        Assert.Equal(.25, SessionCatalog.Number(catalog.Summary()["cost"]));
        catalog.RemoveForDeletion("other");
        Assert.Equal(0, SessionCatalog.Number(catalog.Summary()["cost"]));
        catalog.RemoveForDeletion("zero");
        Assert.Null(catalog.Summary()["cost"]);
        Assert.Null(catalog.Descendants("root", 10).Summary["cost"]);
        AssertMaintained(subject);
        var reopened = subject.Reopen();
        reopened.Initialize();
        Assert.Null(reopened.Summary()["cost"]);
    }

    [Theory]
    [InlineData(.1, .2)]
    [InlineData(.7, .1)]
    public void Removing_paid_rows_resets_known_zero_subtotals_without_rounding_saved_costs(
        double first,
        double second
    )
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        JsonObject PricedRow(string id, double rate)
        {
            var model = HostModels
                .Parse(
                    new JsonObject
                    {
                        ["providers"] = new JsonObject
                        {
                            ["p"] = new JsonObject
                            {
                                ["pricing"] = new JsonObject
                                {
                                    ["cached"] = 0,
                                    ["input"] = rate,
                                    ["output"] = 0,
                                },
                            },
                        },
                    },
                    new JsonObject()
                )
                .Resolve("p");
            var usage = ModelUsageCost.Complete(
                model,
                new ChatResult(
                    null,
                    new JsonObject
                    {
                        ["cachedTokens"] = 0,
                        ["inputTokens"] = 1_000_000,
                        ["outputTokens"] = 0,
                    }
                )
            )!;
            var row = Row(id, 1, "root");
            row["stats"] = new JsonObject
            {
                ["totalCost"] = usage["cost"]!.DeepClone(),
                ["lastUsage"] = usage.DeepClone(),
            };
            return row;
        }
        var zero = PricedRow("zero", 0);
        var firstRow = PricedRow("first", first);
        var secondRow = PricedRow("second", second);
        catalog.Upsert([Row("root", 0), zero, firstRow, secondRow]);
        Assert.Equal(first, SessionCatalog.Number(catalog.Get("first")?["stats"]?["totalCost"]));
        Assert.Equal(second, SessionCatalog.Number(catalog.Get("second")?["stats"]?["totalCost"]));
        Assert.Equal(first + second, SessionCatalog.Number(catalog.Summary()["cost"]));
        catalog.RemoveForDeletion("first");
        catalog.RemoveForDeletion("second");
        Assert.Equal(0, SessionCatalog.Number(catalog.Summary()["cost"]));
        Assert.Equal(0, SessionCatalog.Number(catalog.Descendants("root", 1).Summary["cost"]));
        var reopened = subject.Reopen();
        reopened.Initialize();
        Assert.Equal(0, SessionCatalog.Number(reopened.Summary()["cost"]));
        Assert.Equal(
            0,
            SessionCatalog.Number(reopened.Get("zero")?["stats"]?["lastUsage"]?["cost"])
        );
        var tiny = PricedRow("tiny", 1e-20);
        reopened.Upsert([tiny]);
        Assert.Equal(1e-20, SessionCatalog.Number(reopened.Summary()["cost"]));
        Assert.Equal(1e-20, SessionCatalog.Number(reopened.Get("tiny")?["stats"]?["totalCost"]));
        tiny["stats"]!["totalCost"] = 0;
        reopened.Upsert([tiny]);
        Assert.Equal(0, SessionCatalog.Number(reopened.Summary()["cost"]));
        reopened.RemoveForDeletion("zero");
        reopened.RemoveForDeletion("tiny");
        Assert.Null(reopened.Summary()["cost"]);
        AssertMaintained(subject);
    }

    [Fact]
    public void Startup_selections_read_restart_approval_wait_and_question_projections()
    {
        using var subject = Create();
        var catalog = subject.Store;
        var busy = Row("busy", 10);
        busy["busy"] = true;
        var queued = Row("queued", 20);
        queued["queueLength"] = 2;
        var managed = Row("managed", 30);
        managed["managedPendingCount"] = 1;
        var waiting = Row("waiting", 40);
        waiting["meta"]!["wait"] = new JsonObject { ["id"] = "w1", ["startedAt"] = 1 };
        var asking = Row("asking", 50);
        asking["meta"]!["questions"] = new JsonObject { ["open"] = 2, ["revision"] = 3 };
        var approving = Row("approving", 60);
        approving["meta"]!["questions"] = new JsonObject { ["open"] = 1, ["revision"] = 1, ["approvals"] = 1 };
        var old = Row("old-wait", 5);
        old["meta"]!["wait"] = new JsonObject { ["id"] = "w2" };
        catalog.Upsert([busy, queued, managed, waiting, asking, approving, old, Row("idle", 70)]);
        Assert.Equal(["busy", "managed", "queued"], catalog.RestartIds());
        Assert.Equal(["approving"], catalog.PendingApprovalIds());
        Assert.Equal(["approving", "asking"], Ids(catalog.QuestionRows(10)));
        Assert.Equal(["approving"], Ids(catalog.QuestionRows(1)));
        Assert.Equal(["waiting"], catalog.RecentWaitIds(30));
        Assert.Equal(["old-wait", "waiting"], catalog.RecentWaitIds(0).Order(StringComparer.Ordinal));
        Assert.Equal(
            ["idle", "approving", "asking", "waiting", "managed", "queued", "busy", "old-wait"],
            Ids(catalog.List())
        );
        Assert.Equal(["asking", "waiting"], Ids(catalog.List(2, 2)));
        Assert.Equal(["queued", "busy"], Ids(catalog.OffsetPage(2, 5, agent: "main")));
        var summary = catalog.Summary();
        Assert.Equal(1, summary["busy"]!.GetValue<long>());
        Assert.Equal(1, summary["queued"]!.GetValue<long>());
        Assert.Equal(1, summary["managed"]!.GetValue<long>());
        AssertMaintained(subject);
    }

    [Fact]
    public void Publication_overlays_Main_fields_and_rejects_stale_membership()
    {
        using var subject = Create();
        var catalog = subject.Store;
        var changes = 0;
        catalog.Changed += () => changes++;
        Assert.Throws<InvalidOperationException>(() => catalog.PublishAuthority(Row("new", 1)));
        Assert.Null(catalog.Get("new"));
        var revision = catalog.Revision;
        catalog.PublishAuthority(Row("new", 1, aliases: ["n"]), allowInsert: true);
        Assert.NotEqual(revision, catalog.Revision);
        catalog.Pin("new", true);
        catalog.Rename("new", "Shown");
        var authority = Row("new", 9, "elsewhere", "other", aliases: ["ignored"]);
        authority["displayName"] = "Authority";
        authority["meta"]!["lastChannel"] = new JsonObject { ["channelId"] = "x", ["channelUserId"] = "y" };
        catalog.PublishAuthority(authority);
        var row = catalog.Get("new")!;
        Assert.True(row["pinned"]!.GetValue<bool>());
        Assert.Equal("Shown", row["displayName"]!.GetValue<string>());
        Assert.Equal("main", row["agent"]!.GetValue<string>());
        Assert.Equal(["n"], row["aliases"]!.AsArray().Select(alias => alias!.GetValue<string>()));
        Assert.Null(row["parentSessionId"]);
        Assert.Null(row["meta"]!["lastChannel"]);
        Assert.Equal(9, SessionCatalog.Number(row["meta"]!["lastMessageTime"]));
        Assert.False(catalog.RenameIfUnnamed("new", "Later"));
        catalog.Rename("new", null);
        Assert.True(catalog.RenameIfUnnamed("new", "Later"));
        Assert.Equal("Later", catalog.Get("new")!["displayName"]!.GetValue<string>());
        Assert.False(catalog.RenameIfUnnamed("absent", "x"));
        Assert.Throws<InvalidDataException>(() => catalog.Rename("absent", "x"));
        var channel = catalog.SetLastChannel("new", new JsonObject { ["channelId"] = "c", ["channelUserId"] = "u" });
        Assert.Equal(["new"], channel.ChangedIds);
        Assert.Equal("c", catalog.Get("new")!["meta"]!["lastChannel"]!["channelId"]!.GetValue<string>());
        Assert.Equal(7, changes);
        AssertMaintained(subject);
    }

    [Fact]
    public void Identity_rewrite_moves_the_lifetime_its_children_and_aliases()
    {
        using var subject = Create();
        var catalog = subject.Store;
        FirstReads(catalog);
        catalog.Upsert([
            Row("parent", 0, aliases: ["alias"]),
            Row("child", 0, "alias"),
            Row("direct", 0, "parent"),
        ]);
        Assert.Equal("parent", catalog.Presentation("child")!["parentSessionId"]!.GetValue<string>());
        Assert.Equal(["direct"], Ids(catalog.IdentityChildren("parent")));
        Assert.Throws<InvalidDataException>(() =>
            catalog.RewriteIdentity("absent", "elsewhere", "main", [])
        );
        var direct = catalog.RewriteIdentity("parent", "beta/renamed", "beta", ["parent", "alias"]);
        Assert.Equal(["direct"], direct);
        Assert.Null(catalog.Get("parent"));
        Assert.Equal("beta", catalog.Get("beta/renamed")!["agent"]!.GetValue<string>());
        Assert.Equal("beta/renamed", catalog.Resolve("alias")["sessionId"]!.GetValue<string>());
        Assert.Equal("beta/renamed", catalog.Resolve("parent")["sessionId"]!.GetValue<string>());
        Assert.Equal("beta/renamed", catalog.Presentation("child")!["parentSessionId"]!.GetValue<string>());
        Assert.Equal("beta/renamed", catalog.Get("direct")!["parentSessionId"]!.GetValue<string>());
        // Recovery of an already moved lifetime rewrites it in place.
        Assert.Empty(catalog.RewriteIdentity("parent", "beta/renamed", "beta", ["parent", "alias"], requireSource: false));
        Assert.Equal("beta/renamed", catalog.Resolve("alias")["sessionId"]!.GetValue<string>());
        Assert.Equal("beta/renamed", catalog.ValidateIdentityParent("x", "parent"));
        Assert.Throws<SessionPresentationException>(() => catalog.ValidateIdentityParent("beta/renamed", "parent"));
        AssertMaintained(subject);
        var reopened = subject.Reopen();
        Assert.NotNull(reopened.Get("beta/renamed"));
        reopened.RemoveForDeletion("beta/renamed");
        Assert.Equal("missing", reopened.Resolve("parent")["kind"]!.GetValue<string>());
        Assert.Null(reopened.Presentation("child")!["parentSessionId"]);
        Assert.Null(reopened.Presentation("direct")!["parentSessionId"]);
        Assert.Throws<InvalidDataException>(() => reopened.RemoveForDeletion("beta/renamed"));
        Assert.Equal("exact", reopened.Resolve("child")["kind"]!.GetValue<string>());
        AssertMaintained(subject);

        static void FirstReads(ISessionCatalogStore catalog) =>
            Task.WhenAll(
                    Enumerable.Range(0, 8).Select(_ => Task.Run(() => Assert.Null(catalog.Get("parent"))))
                )
                .GetAwaiter()
                .GetResult();
    }

    [Fact]
    public void Deletion_selection_follows_resolved_parents_in_source_order()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Upsert([
            Row("root", 0, aliases: ["r"]),
            Row("b", 1, "root"),
            Row("a", 2, "r"),
            Row("a/x", 3, "a"),
            Row("other", 4),
        ]);
        var single = catalog.SelectDeletion("r", recursive: false);
        Assert.Equal("root", single.Root);
        Assert.Equal(["a", "b"], single.Direct);
        var tree = catalog.SelectDeletion("root", recursive: true);
        Assert.Equal(["root", "a", "a/x", "b"], tree.Targets);
        Assert.Equal(["a", "b"], tree.Direct);
        Assert.Equal(["a/x", "a", "b", "root"], tree.Post);
        Assert.Throws<SessionPresentationException>(() => catalog.SelectDeletion("absent", true));
    }

    [Fact]
    public void A_deep_chain_carries_the_newest_descendant_time_to_every_ancestor()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([
            Row("a", 10),
            Row("a/b", 20, "a"),
            Row("a/b/c", 30, "a/b"),
            Row("a/b/c/d", 40, "a/b/c"),
            Row("a/b/c/d/e", 50, "a/b/c/d"),
            Row("a/b/c/d/e/f", 60, "a/b/c/d/e"),
            Row("other", 25),
        ]);
        string[] chain = ["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f"];
        Assert.Equal([60, 60, 60, 60, 60, 60], chain.Select(id => Subtree(catalog, id)).ToArray());
        Assert.Equal(25, Subtree(catalog, "other"));
        // Publication of a newer deep message propagates through the whole chain.
        catalog.Upsert([Row("a/b/c/d/e/f", 90, "a/b/c/d/e")]);
        Assert.Equal(90, Subtree(catalog, "a"));
        // The displayed own time is untouched by descendants.
        Assert.Equal(10, SessionCatalog.Number(catalog.Get("a")!["meta"]!["lastMessageTime"]));
        // An older descendant message lowers only what no other descendant still supports.
        catalog.Upsert([Row("a/b/c/d/e/f", 15, "a/b/c/d/e")]);
        Assert.Equal([50, 50, 50, 50, 50, 15], chain.Select(id => Subtree(catalog, id)).ToArray());
        AssertMaintained(subject);
    }

    [Fact]
    public void Siblings_keep_an_ancestor_current_when_one_branch_goes_quiet_or_leaves()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([
            Row("root", 5),
            Row("left", 10, "root"),
            Row("left/leaf", 70, "left"),
            Row("right", 20, "root"),
            Row("right/leaf", 60, "right"),
        ]);
        Assert.Equal(70, Subtree(catalog, "root"));
        catalog.Upsert([Row("left/leaf", 30, "left")]);
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
        AssertMaintained(subject);
    }

    [Fact]
    public void Deletion_recomputes_the_old_ancestors_and_detaches_children_as_roots()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([
            Row("root", 1),
            Row("mid", 2, "root"),
            Row("hot", 99, "mid"),
            Row("warm", 40, "mid"),
            Row("sibling", 30, "root"),
        ]);
        Assert.Equal(99, Subtree(catalog, "root"));
        catalog.RemoveForDeletion("hot");
        Assert.Equal(40, Subtree(catalog, "mid"));
        Assert.Equal(40, Subtree(catalog, "root"));
        catalog.RemoveForDeletion("mid");
        Assert.Equal(30, Subtree(catalog, "root"));
        // The deleted row's children are roots again with their own value.
        Assert.Equal(40, Subtree(catalog, "warm"));
        AssertMaintained(subject);
    }

    [Fact]
    public void A_child_published_before_its_parent_counts_once_the_parent_exists()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([Row("early", 80, "late")]);
        catalog.Upsert([Row("late", 3)]);
        Assert.Equal(80, Subtree(catalog, "late"));
        // An alias reference resolves to its owner and carries activity to it as well.
        catalog.Upsert([Row("owner", 4, aliases: ["via-alias"]), Row("aliased-child", 95, "via-alias")]);
        Assert.Equal(95, Subtree(catalog, "owner"));
        AssertMaintained(subject);
    }

    [Fact]
    public void Randomized_publication_reparent_and_delete_stay_equal_to_a_full_recomputation()
    {
        var random = new Random(20261108);
        for (var trial = 0; trial < 12; trial++)
        {
            using var subject = Create();
            var catalog = subject.Store;
            catalog.Initialize();
            var ids = Enumerable.Range(0, 14).Select(index => "s" + index).ToArray();
            string[] nodes = ["master", "box", "edge"];
            for (var step = 0; step < 70; step++)
            {
                var existing = ids.Where(id => catalog.Get(id) is not null).ToArray();
                var action = random.Next(7);
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
                    var row = NodeRow(id, random.Next(1, 200), parent, random.Next(3) == 0 ? "beta" : "main", nodes[random.Next(3)]);
                    row["busy"] = random.Next(3) == 0;
                    row["queueLength"] = random.Next(3);
                    row["stats"] = new JsonObject { ["totalInputTokens"] = random.Next(100) };
                    if (random.Next(2) == 0)
                        row["stats"]!["totalCost"] = random.Next(3) * .1;
                    catalog.Upsert([row]);
                }
                else if (action == 2)
                {
                    var id = existing[random.Next(existing.Length)];
                    var row = catalog.Get(id)!;
                    row["meta"]!["lastMessageTime"] = random.Next(1, 200);
                    row["currentNode"] = nodes[random.Next(3)];
                    row["busy"] = random.Next(2) == 0;
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
                else if (action == 4)
                    catalog.Pin(existing[random.Next(existing.Length)], random.Next(2) == 0);
                else if (action == 5)
                {
                    var id = existing[random.Next(existing.Length)];
                    // A target no row references keeps the rename from closing a parent cycle.
                    var target = ids.FirstOrDefault(candidate =>
                        !existing.Contains(candidate)
                        && existing.All(other => SessionCatalog.Text(catalog.Get(other)!["parentSessionId"]) != candidate)
                    );
                    if (target is not null)
                        // The old ID stays an alias no later Session takes, so no reference re-resolves into a cycle.
                        catalog.RewriteIdentity(id, target, random.Next(2) == 0 ? "main" : "beta", ["was-" + id]);
                }
                else
                    catalog.RemoveForDeletion(existing[random.Next(existing.Length)]);
                AssertMaintained(subject);
            }
        }
    }

    [Fact]
    public void Recent_child_counts_take_a_bounded_window_per_parent()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Upsert(
            Enumerable.Range(0, 20).Select(index => Row("p" + index, index))
                .Concat(Enumerable.Range(0, 12).Select(index => Row("c" + index, index * 10, "p1")))
        );
        catalog.Pin("c11", true);
        catalog.Archive("c10", true);
        Assert.Equal(5, catalog.RecentChildCounts(["p1"], 0, 5)["p1"]);
        Assert.Equal(0, catalog.RecentChildCounts(["p2"], 0, 5)["p2"]);
        // c9 and c8 at 90 and 80; c10 is archived and c11 pinned.
        Assert.Equal(2, catalog.RecentChildCounts(["p1", "p2"], 75, 5)["p1"]);
        Assert.Equal(110, catalog.SubtreeTimes(["p1", "absent"])["p1"]);
        Assert.Single(catalog.SubtreeTimes(["p1", "absent"]));
        Assert.Throws<InvalidDataException>(() =>
            catalog.RecentChildCounts(Enumerable.Range(0, 101).Select(index => "p" + index).ToArray(), 0, 1)
        );
    }

    [Fact]
    public void Catalog_pages_order_tree_modes_by_activity_and_flat_by_own_time()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        var ordered = Row("ordered", 1);
        ordered["sidebarOrder"] = 1;
        catalog.Upsert([
            ordered,
            Row("quiet-parent", 10),
            Row("quiet-parent/hot", 100, "quiet-parent"),
            Row("newer-alone", 50),
            Row("oldest", 2),
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
        // Keyset continuation from the last row of a page.
        var first = catalog.Page("time", 2, null, true, null);
        Assert.True(first.HasMore);
        var rest = catalog.Page("time", 2, new JsonArray(1, 0, -50, "newer-alone"), true, null);
        Assert.Equal(["oldest", "ordered"], Ids(rest.Rows));
        Assert.False(rest.HasMore);
    }

    [Fact]
    public void Pages_order_ids_by_bytes_and_saved_order_before_unordered_rows()
    {
        using var subject = Create();
        var catalog = subject.Store;
        // Byte order: upper case before lower case, ASCII before BMP before supplementary.
        string[] ids = ["b", "B", "a", "é", "\U0001F98A", "Z", "ü", "\u4E00", "\uFF21", "a-1", "a_1"];
        catalog.Upsert(ids.Select(id => Row(id, 7)));
        var expected = ids.OrderBy(id => id, StringComparer.Ordinal)
            .OrderBy(id => System.Text.Encoding.UTF8.GetBytes(id), Comparer<byte[]>.Create((a, b) => a.AsSpan().SequenceCompareTo(b)))
            .ToArray();
        Assert.Equal(expected, Ids(catalog.Page("flat-time", 20, null, false, null).Rows));
        Assert.Equal(expected, Ids(catalog.List()));
        var reordered = catalog.Move("Z", new JsonObject { ["position"] = "first" });
        Assert.Equal(1000, SessionCatalog.Number(catalog.Get("Z")!["sidebarOrder"]));
        Assert.Contains("Z", reordered.ChangedIds);
        var page = Ids(catalog.Page("default", 20, null, true, null).Rows);
        Assert.Equal("Z", page[0]);
        // Paging through two at a time gives the same order.
        var all = new List<string>();
        JsonArray? after = null;
        while (true)
        {
            var next = catalog.Page("flat-time", 3, after, false, null);
            all.AddRange(Ids(next.Rows));
            if (!next.HasMore)
                break;
            var last = next.Rows[^1];
            after = new JsonArray(1, SessionCatalog.Flag(last["archived"]) ? 1 : 0, -7, last["id"]!.GetValue<string>());
        }
        Assert.Equal(expected, all);
    }

    [Fact]
    public void Child_windows_take_per_parent_limits_and_order_by_activity()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([
            Row("p", 1),
            Row("q", 1),
            Row("p/quiet", 20, "p"),
            Row("p/quiet/hot", 90, "p/quiet"),
            Row("p/newer", 50, "p"),
            Row("p/old", 5, "p"),
            Row("q/a", 8, "q"),
            Row("q/b", 9, "q"),
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
        // Agent-forest children keep their real relation and own time.
        var forest = catalog.Children([("p", null)], "time", 5, "main");
        Assert.Equal(["p/newer", "p/quiet", "p/old"], Ids(forest[0].Rows));
    }

    private static void GroupFixture(ISessionCatalogStore catalog)
    {
        catalog.Upsert([
            NodeRow("main", 50),
            NodeRow("0905_aaaaa", 40),
            NodeRow("0905_child", 39, "0905_aaaaa", node: "box"),
            NodeRow("alpha/main", 30, agent: "alpha", node: "box"),
            NodeRow("alpha/loose", 31, agent: "alpha"),
            NodeRow("alpha/nested", 28, "alpha/loose", "alpha", "box"),
            NodeRow("alpha/pinned", 27, agent: "alpha", node: "box"),
            NodeRow("beta/one", 20, "alpha/loose", "beta"),
            NodeRow("beta/two", 21, agent: "beta", node: "gone"),
        ]);
        catalog.Pin("alpha/pinned", true);
    }

    private static string[] GroupMembers(
        ISessionCatalogStore catalog,
        string by,
        string key,
        string mode,
        string? exclude = null
    ) => Ids(catalog.GroupPage(by, key, mode, 100, null, exclude).Rows);

    [Fact]
    public void Group_counts_and_pages_follow_own_agent_or_node_and_real_top_level_rows()
    {
        using var subject = Create();
        var catalog = subject.Store;
        GroupFixture(catalog);
        // Tree modes count unpinned top-level rows; Flat counts every unpinned row.
        Assert.Equal(
            new Dictionary<string, long> { ["main"] = 2, ["alpha"] = 2, ["beta"] = 1 },
            catalog.GroupCounts("agent", true)
        );
        Assert.Equal(
            new Dictionary<string, long> { ["main"] = 3, ["alpha"] = 3, ["beta"] = 2 },
            catalog.GroupCounts("agent", false)
        );
        Assert.Equal(
            new Dictionary<string, long> { ["master"] = 3, ["box"] = 1, ["gone"] = 1 },
            catalog.GroupCounts("node", true)
        );
        Assert.Equal(
            new Dictionary<string, long> { ["master"] = 4, ["box"] = 3, ["gone"] = 1 },
            catalog.GroupCounts("node", false)
        );
        // Children stay under their real parent and are not group members in tree modes,
        // even when they belong to another Agent or run on another Node.
        Assert.Equal(["alpha/loose", "alpha/main"], GroupMembers(catalog, "agent", "alpha", "time"));
        Assert.Equal(["beta/two"], GroupMembers(catalog, "agent", "beta", "default"));
        Assert.Equal(["alpha/main"], GroupMembers(catalog, "node", "box", "default"));
        Assert.Equal(["main", "0905_aaaaa", "alpha/loose"], GroupMembers(catalog, "node", "master", "time"));
        // Flat members are every unpinned row of the group, by recency.
        Assert.Equal(["alpha/loose", "alpha/main", "alpha/nested"], GroupMembers(catalog, "agent", "alpha", "flat-time"));
        Assert.Equal(["0905_child", "alpha/main", "alpha/nested"], GroupMembers(catalog, "node", "box", "flat-time"));
        // The caller places an Agent main separately.
        Assert.Equal(["alpha/loose"], GroupMembers(catalog, "agent", "alpha", "time", "alpha/main"));
        // The pinned section is paged alone.
        Assert.Equal(["alpha/pinned"], Ids(catalog.Page("default", 10, null, true, null, pinnedOnly: true).Rows));
        Assert.Equal(["alpha/pinned"], Ids(catalog.Page("flat-time", 10, null, true, null, pinnedOnly: true).Rows));
        Assert.Equal(
            new Dictionary<string, string> { ["beta/one"] = "master", ["beta/two"] = "gone" },
            catalog.GroupKeys(["beta/one", "beta/two", "missing"], "node")
        );
        // The Agent forest: a row is a root when its parent is missing or another Agent's.
        Assert.Equal(["beta/two", "beta/one"], Ids(catalog.Page("time", 10, null, true, "beta").Rows));
        AssertMaintained(subject);
    }

    [Fact]
    public void Default_group_pages_use_saved_order_and_continue_by_keyset()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Upsert([
            NodeRow("gamma/a", 10, agent: "gamma", order: 2),
            NodeRow("gamma/b", 20, agent: "gamma", order: 1),
            NodeRow("gamma/c", 30, agent: "gamma"),
            NodeRow("gamma/d", 40, agent: "gamma"),
        ]);
        Assert.Equal(["gamma/b", "gamma/a", "gamma/d", "gamma/c"], GroupMembers(catalog, "agent", "gamma", "default"));
        Assert.Equal(["gamma/d", "gamma/c", "gamma/b", "gamma/a"], GroupMembers(catalog, "agent", "gamma", "time"));
        var first = catalog.GroupPage("agent", "gamma", "default", 2, null, null);
        Assert.True(first.HasMore);
        var after = new JsonArray(0, 0, 2, -10, "gamma/a");
        var rest = catalog.GroupPage("agent", "gamma", "default", 2, after, null);
        Assert.Equal(["gamma/d", "gamma/c"], Ids(rest.Rows));
        Assert.False(rest.HasMore);
        // A start key below every member continues from the first row.
        var start = catalog.GroupPage("agent", "gamma", "default", 10, new JsonArray(-1, 0, 0, 0, ""), "gamma/b");
        Assert.Equal(["gamma/a", "gamma/d", "gamma/c"], Ids(start.Rows));
        // A fractional key part still compares numerically.
        var fractional = catalog.GroupPage("agent", "gamma", "default", 10, new JsonArray(0, 0, 1.5, 0, ""), null);
        Assert.Equal(["gamma/a", "gamma/d", "gamma/c"], Ids(fractional.Rows));
    }

    [Fact]
    public void Node_counts_are_maintained_through_topology_changes()
    {
        using var subject = Create();
        var catalog = subject.Store;
        GroupFixture(catalog);
        AssertMaintained(subject);
        catalog.SetParent("beta/two", "main");
        catalog.SetParent("alpha/nested", null);
        catalog.Upsert([NodeRow("0905_aaaaa", 41, node: "box")]);
        catalog.RemoveForDeletion("beta/one");
        AssertMaintained(subject);
        Assert.Equal(
            new Dictionary<string, long> { ["master"] = 2, ["box"] = 3 },
            catalog.GroupCounts("node", true)
        );
    }

    [Fact]
    public void Ordinary_exact_and_resolution_reads_complete_while_a_presentation_writer_is_held()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Upsert([Row("one", 0, aliases: ["only", "shared"]), Row("two", 0, aliases: ["shared"])]);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        catalog.BeforePresentationMutation = rows =>
        {
            // The hook sees the rows the mutation writes, and reads join its transaction.
            Assert.Equal(["one"], Ids(rows));
            Assert.Null(catalog.Get("one")!["pinned"]);
            entered.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Presentation writer was not released.");
            return null!;
        };
        var writer = Task.Factory.StartNew(() => catalog.Pin("one", true), TaskCreationOptions.LongRunning);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        var watch = Stopwatch.StartNew();
        var reads = Enumerable
            .Range(0, 8)
            .Select(_ =>
                Task.Factory.StartNew(
                    () =>
                        new[]
                        {
                            catalog.Get("one")!,
                            catalog.Resolve("one"),
                            catalog.Resolve("only"),
                            catalog.Resolve("shared"),
                            catalog.Resolve("absent"),
                        },
                    TaskCreationOptions.LongRunning
                )
            )
            .ToArray();
        try
        {
            var results = Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            foreach (var result in results)
            {
                Assert.Null(result[0]["pinned"]);
                Assert.Equal("exact", result[1]["kind"]!.GetValue<string>());
                Assert.Equal("one", result[2]["sessionId"]!.GetValue<string>());
                Assert.Equal("ambiguous", result[3]["kind"]!.GetValue<string>());
                Assert.Equal("missing", result[4]["kind"]!.GetValue<string>());
            }
            output.WriteLine($"Eight readers completed 40 Get/Resolve calls in {watch.Elapsed.TotalMilliseconds:F3} ms while the writer was held.");
            Assert.False(writer.IsCompleted);
        }
        finally
        {
            release.Set();
            writer.GetAwaiter().GetResult();
        }
        catalog.BeforePresentationMutation = null;
        Assert.True(catalog.Get("one")!["pinned"]!.GetValue<bool>());
        // Publication reads current Main fields in its own transaction, not an older snapshot.
        catalog.PublishAuthority(Row("one", 10));
        Assert.True(catalog.Get("one")!["pinned"]!.GetValue<bool>());
    }

    [Fact]
    public void Raw_cycle_traversal_exact_aliases_and_ambiguous_parents_are_not_the_presentation_forest()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([
            Row("A", 0),
            Row("B", 0, aliases: ["A", "shared"]),
            Row("C", 0, aliases: ["shared"]),
            Row("child", 0, "A"),
            Row("ambiguous", 0, "shared"),
            Row("self", 0, "self"),
            Row("x", 0, "y"),
            Row("y", 0, "x"),
        ]);
        var change = catalog.Archive("A", true, true);
        Assert.Equal(new[] { "A", "child" }, change.ChangedIds);
        Assert.Null(catalog.Get("B")!["archived"]);
        Assert.Null(catalog.Get("ambiguous")!["archived"]);
        foreach (var id in new[] { "self", "x" })
        {
            var revision = catalog.Revision;
            var error = Assert.Throws<SessionPresentationException>(() => catalog.Archive(id, true, true));
            Assert.Equal("SESSION_RELATION_CYCLE", error.Code);
            Assert.Equal(revision, catalog.Revision);
            Assert.Null(catalog.Get(id)!["archived"]);
            catalog.Pin(id, true);
            catalog.Archive(id, true);
            Assert.True(catalog.Get(id)!["pinned"]!.GetValue<bool>());
        }
        var parentError = Assert.Throws<SessionPresentationException>(() => catalog.SetParent("A", "child"));
        Assert.Equal("PARENT_CYCLE_NOT_ALLOWED", parentError.Code);
        Assert.Equal("shared", catalog.Get("ambiguous")!["parentSessionId"]!.GetValue<string>());
        // An unchanged presentation command keeps the revision.
        var unchanged = catalog.Revision;
        Assert.Empty(catalog.Archive("A", true).ChangedIds);
        Assert.Equal(unchanged, catalog.Revision);
        AssertMaintained(subject);
    }

    [Fact]
    public void Moves_rank_siblings_and_a_failed_notification_still_reports_the_commit()
    {
        using var subject = Create();
        var catalog = subject.Store;
        catalog.Initialize();
        catalog.Upsert([Row("root", 0), Row("a", 1, " root\u00A0"), Row("b", 2, "root"), Row("c", 3, "root")]);
        var moved = catalog.Move("c", new JsonObject { ["afterSessionId"] = "a" });
        Assert.Equal("root", moved.Result["parentSessionId"]!.GetValue<string>());
        Assert.Equal(
            [1000, 2000, 3000],
            new[] { "b", "a", "c" }.Select(id => SessionCatalog.Number(catalog.Get(id)!["sidebarOrder"])!.Value).ToArray()
        );
        var promoted = catalog.Move("a", new JsonObject(), promote: true);
        Assert.Equal("promote-to-root", promoted.Result["operation"]!.GetValue<string>());
        Assert.Null(catalog.Get("a")!["parentSessionId"]);
        Assert.Equal(1000, SessionCatalog.Number(catalog.Get("a")!["sidebarOrder"]));
        catalog.Move("a", new JsonObject { ["parentSessionId"] = null });
        Assert.Null(catalog.Get("a")!["parentSessionId"]);
        Assert.Throws<SessionPresentationException>(() =>
            catalog.Move("a", new JsonObject { ["beforeSessionId"] = "a" })
        );
        catalog.Changed += () => throw new IOException("notification failed");
        var error = Assert.Throws<PresentationCommittedException>(() => catalog.Pin("a", true));
        Assert.True(error.Change.Result["pinned"]!.GetValue<bool>());
        Assert.True(catalog.Get("a")!["pinned"]!.GetValue<bool>());
        AssertMaintained(subject);
    }
}

public sealed class FileSessionCatalogContractTests(ITestOutputHelper output)
    : SessionCatalogContractTests(output)
{
    private protected override CatalogUnderTest Create()
    {
        var temp = new TempDirectory();
        var file = Path.Combine(temp.Path, "state", "catalog.sqlite");
        return new CatalogUnderTest(
            () => new SessionCatalog(temp.Path),
            sql =>
            {
                using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly;Pooling=False");
                db.Open();
                using var command = db.CreateCommand();
                command.CommandText = sql;
                using var reader = command.ExecuteReader();
                var rows = new List<object?[]>();
                while (reader.Read())
                    rows.Add(Enumerable.Range(0, reader.FieldCount).Select(index => reader.IsDBNull(index) ? null : reader.GetValue(index)).ToArray());
                return rows;
            },
            temp.Dispose
        );
    }
}
