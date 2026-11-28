using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Npgsql;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

/// <summary>One tenant database with a catalog store over it, for the hosted catalog tests.</summary>
internal sealed class PostgresCatalogFixture : IDisposable
{
    private PostgresCatalogFixture(HostedTestDatabase database, TenantDb tenant)
    {
        Database = database;
        Tenant = tenant;
    }

    internal HostedTestDatabase Database { get; }

    internal TenantDb Tenant { get; }

    internal static PostgresCatalogFixture Open()
    {
        var server = PostgresServer.SharedAsync().GetAwaiter().GetResult();
        var database = server.CreateDatabaseAsync().GetAwaiter().GetResult();
        var tenantId = database.TenantIdAsync().GetAwaiter().GetResult();
        var epoch = database.TakeLeaseAsync(tenantId).GetAwaiter().GetResult();
        return new(database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    internal List<object?[]> Query(string sql, params object?[] args) =>
        Tenant.Read(tx =>
        {
            using var command = tx.Command(sql, args);
            using var reader = command.ExecuteReader();
            var rows = new List<object?[]>();
            while (reader.Read())
                rows.Add(
                    Enumerable
                        .Range(0, reader.FieldCount)
                        .Select(index => reader.IsDBNull(index) ? null : reader.GetValue(index))
                        .ToArray()
                );
            return rows;
        });

    /// <summary>Every catalog table's rows as text, for before/after comparisons.</summary>
    internal string Dump() =>
        string.Join(
            "\n",
            new[]
            {
                "SELECT session_id,metadata_json,parent_session_id,subtree_time FROM session_catalog ORDER BY session_id",
                "SELECT alias,session_id,ordinal FROM session_alias ORDER BY alias,session_id",
                "SELECT * FROM catalog_count",
                "SELECT * FROM catalog_agent_count ORDER BY agent",
                "SELECT * FROM catalog_parent_count ORDER BY parent_key",
                "SELECT * FROM catalog_parent_agent_count ORDER BY parent_key,agent",
                "SELECT * FROM catalog_node_count ORDER BY current_node",
                "SELECT * FROM catalog_revision",
            }.SelectMany(sql =>
                Query(sql).Select(row => string.Join("|", row.Select(value => Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture))))
            )
        );

    public void Dispose() => Database.DisposeAsync().AsTask().GetAwaiter().GetResult();
}

[Trait("Backend", "postgres")]
public sealed class PostgresSessionCatalogContractTests(ITestOutputHelper output)
    : SessionCatalogContractTests(output)
{
    private protected override CatalogUnderTest Create()
    {
        var fixture = PostgresCatalogFixture.Open();
        return new CatalogUnderTest(
            () => new PgSessionCatalog(fixture.Tenant),
            sql => fixture.Query(sql),
            fixture.Dispose
        );
    }
}

/// <summary>
/// Hosted-only catalog behavior: the write fence on every write operation, the revision
/// counter (including a lost COMMIT), tenant separation and the plans of the indexed queries.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PostgresSessionCatalogTests(ITestOutputHelper output)
{
    private static JsonObject Row(string id, int time, string? parent = null, string agent = "main", string[]? aliases = null) =>
        SessionCatalogTests.Row(id, time, parent, agent, aliases);

    private static void Seed(PgSessionCatalog catalog) =>
        catalog.Upsert([
            Row("root", 1, aliases: ["r"]),
            Row("a", 2, "root"),
            Row("b", 3, "root"),
            Row("other", 4, agent: "beta"),
        ]);

    private static readonly (string Name, Action<PgSessionCatalog> Write)[] Writes =
    [
        ("Upsert", catalog => catalog.Upsert([Row("new", 9)])),
        ("PublishAuthority", catalog => catalog.PublishAuthority(Row("a", 50, "root"))),
        ("PublishAuthority insert", catalog => catalog.PublishAuthority(Row("new", 9), allowInsert: true)),
        ("Rename", catalog => catalog.Rename("a", "Named")),
        ("RenameIfUnnamed", catalog => catalog.RenameIfUnnamed("a", "Named")),
        ("RewriteIdentity", catalog => catalog.RewriteIdentity("a", "beta/a", "beta", ["a"])),
        ("RemoveForDeletion", catalog => catalog.RemoveForDeletion("b")),
        ("SetLastChannel", catalog => catalog.SetLastChannel("a", new JsonObject { ["channelId"] = "c", ["channelUserId"] = "u" })),
        ("Archive", catalog => catalog.Archive("root", true, descendants: true)),
        ("Archive unchanged", catalog => catalog.Archive("root", false)),
        ("Pin", catalog => catalog.Pin("a", true)),
        ("SetParent", catalog => catalog.SetParent("a", null)),
        ("Move", catalog => catalog.Move("b", new JsonObject { ["position"] = "first" })),
        ("Promote", catalog => catalog.Move("a", new JsonObject(), promote: true)),
    ];

    [Fact]
    public async Task CatalogQueriesOverlapAndKeepTheirOwnRevisionAndRows()
    {
        using var fixture = PostgresCatalogFixture.Open();
        var catalog = new PgSessionCatalog(fixture.Tenant);
        Seed(catalog);
        var before = catalog.Revision;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var resume = new ManualResetEventSlim();
        var first = Task.Run(() => catalog.QueryAsync(() =>
        {
            var initial = catalog.List();
            entered.TrySetResult();
            resume.Wait();
            return (Initial: initial.Length, Final: catalog.List().Length, Revision: catalog.Revision);
        }));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var second = catalog.QueryAsync(() => catalog.List().Length);
            Assert.Equal(4, await second.WaitAsync(TimeSpan.FromSeconds(2)));
            await catalog.PublishAuthorityAsync(Row("extra", 7), allowInsert: true).WaitAsync(TimeSpan.FromSeconds(2));
            Assert.NotEqual(before, catalog.Revision);
            Assert.Equal(5, await catalog.QueryAsync(() => catalog.List().Length));
        }
        finally { resume.Set(); }
        Assert.Equal((4, 4, before), await first);
    }

    [Fact]
    public void Every_write_operation_after_a_takeover_is_fenced_and_leaves_nothing_behind()
    {
        using var fixture = PostgresCatalogFixture.Open();
        var catalog = new PgSessionCatalog(fixture.Tenant);
        Seed(catalog);
        // Each operation works while the lease is current.
        foreach (var (name, write) in Writes)
        {
            using var scratch = PostgresCatalogFixture.Open();
            var other = new PgSessionCatalog(scratch.Tenant);
            Seed(other);
            write(other);
            output.WriteLine($"{name}: committed before the takeover");
        }
        var before = fixture.Dump();
        var revision = catalog.Revision;
        var changes = 0;
        catalog.Changed += () => changes++;
        fixture.Database.TakeLeaseAsync(fixture.Tenant.TenantId, "other").GetAwaiter().GetResult();
        foreach (var (name, write) in Writes)
        {
            var error = Record.Exception(() => write(catalog));
            Assert.True(error is TenantFencedException, $"{name}: {error?.GetType().Name ?? "no error"}");
            Assert.Equal(before, fixture.Dump());
            Assert.Equal(revision, catalog.Revision);
        }
        Assert.Equal(0, changes);
        // Reads need no lease.
        Assert.NotNull(catalog.Get("a"));
        Assert.Equal(4, catalog.Summary()["total"]!.GetValue<long>());
    }

    [Fact]
    public async Task A_lost_commit_is_resolved_by_the_revision_counter()
    {
        using var fixture = PostgresCatalogFixture.Open();
        Seed(new PgSessionCatalog(fixture.Tenant));
        await using var proxy = PgTcpProxy.For(fixture.Database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(fixture.Database.AppConnectionString))
        {
            Pooling = false,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString;
        var owner = new TenantDb(fixture.Database.OpenApp(routed), fixture.Tenant.TenantId, fixture.Tenant.Epoch);
        var catalog = new PgSessionCatalog(owner);
        var start = catalog.Revision;

        // COMMIT reaches the server, its reply doesn't: the counter shows the write landed.
        catalog.BeforeCommit = () => proxy.HoldExisting(toServer: false, toClient: true);
        Assert.True(catalog.Pin("a", true).Result["pinned"]!.GetValue<bool>());
        catalog.BeforeCommit = null;
        proxy.SeverAll();
        proxy.Heal();
        Assert.NotEqual(start, catalog.Revision);
        Assert.True(catalog.Get("a")!["pinned"]!.GetValue<bool>());

        // COMMIT never reaches the server: the counter is unchanged, the write fails.
        var landed = catalog.Revision;
        var changes = 0;
        catalog.Changed += () => changes++;
        catalog.BeforeCommit = () => proxy.HoldExisting(toServer: true, toClient: false);
        var lost = Assert.ThrowsAny<Exception>(() => catalog.Pin("b", true));
        Assert.IsNotType<CommitOutcomeUnknownException>(lost);
        catalog.BeforeCommit = null;
        proxy.SeverAll();
        proxy.Heal();
        Assert.Equal(landed, catalog.Revision);
        Assert.Null(catalog.Get("b")!["pinned"]);
        Assert.Equal(0, changes);
    }

    [Fact]
    public void The_revision_is_per_tenant_and_rises_with_every_catalog_write_transaction()
    {
        using var fixture = PostgresCatalogFixture.Open();
        var catalog = new PgSessionCatalog(fixture.Tenant);
        long Counter() => fixture.Query("SELECT revision FROM catalog_revision").Select(row => (long)row[0]!).SingleOrDefault();
        Assert.Equal(0, Counter());
        Seed(catalog);
        Assert.Equal(1, Counter());
        catalog.Pin("a", true);
        catalog.Pin("a", true);
        catalog.Rename("a", "x");
        Assert.False(catalog.RenameIfUnnamed("a", "y"));
        Assert.Empty(catalog.Archive("a", false).ChangedIds);
        Assert.Equal(4, Counter());
        Assert.EndsWith(":4", catalog.Revision);
        // Another store instance over the tenant reads the counter, under its own identity.
        var reopened = new PgSessionCatalog(fixture.Tenant);
        Assert.EndsWith(":4", reopened.Revision);
        Assert.NotEqual(catalog.Revision, reopened.Revision);
    }

    [Fact]
    public async Task Tenants_in_one_database_see_only_their_own_rows_and_counts()
    {
        using var fixture = PostgresCatalogFixture.Open();
        await fixture.Database.ExecuteOwnerAsync(
            "INSERT INTO tenants (name) VALUES ('second');"
                + " INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = 'second'"
        );
        var secondId = await fixture.Database.TenantIdAsync("second");
        var secondEpoch = await fixture.Database.TakeLeaseAsync(secondId);
        var second = new PgSessionCatalog(new TenantDb(fixture.Database.OpenApp(), secondId, secondEpoch));
        var first = new PgSessionCatalog(fixture.Tenant);
        Seed(first);
        second.Upsert([Row("root", 7, aliases: ["only-second"]), Row("solo", 8, "r")]);
        Assert.Equal(4, first.Summary()["total"]!.GetValue<long>());
        Assert.Equal(2, second.Summary()["total"]!.GetValue<long>());
        Assert.Equal("missing", first.Resolve("only-second")["kind"]!.GetValue<string>());
        Assert.Equal("missing", second.Resolve("r")["kind"]!.GetValue<string>());
        Assert.Null(second.Presentation("solo")!["parentSessionId"]);
        Assert.Equal(2, first.ChildCounts(["root"])["root"]);
        Assert.Empty(second.ChildCounts(["root"]));
        Assert.Equal(1, SessionCatalog.Number(first.Get("root")!["meta"]!["lastMessageTime"]));
        second.RemoveForDeletion("root");
        Assert.NotNull(first.Get("root"));
        Assert.EndsWith(":1", first.Revision);
        Assert.EndsWith(":2", second.Revision);
    }

    // ---- Plans --------------------------------------------------------------------------

    private static void SeedForPlans(PostgresCatalogFixture fixture, PgSessionCatalog catalog)
    {
        string[] agents = ["main", "alpha", "beta", "gamma"];
        string[] nodes = ["master", "box", "edge"];
        var rows = new List<JsonObject>();
        for (var index = 0; index < 1200; index++)
        {
            var row = Row($"r{index:D4}", index, agent: agents[index % 4], aliases: [$"alias-{index:D4}", $"old-{index % 600:D4}"]);
            row["currentNode"] = nodes[index % 3];
            if (index % 50 == 0)
                row["pinned"] = true;
            if (index % 7 == 0)
                row["archived"] = true;
            if (index % 97 == 0)
                row["busy"] = true;
            if (index % 89 == 0)
                row["meta"]!["wait"] = new JsonObject { ["id"] = "w" + index };
            if (index % 83 == 0)
                row["meta"]!["questions"] = new JsonObject { ["open"] = 1, ["revision"] = 1 };
            rows.Add(row);
        }
        for (var index = 0; index < 1200; index++)
        {
            var row = Row($"c{index:D4}", 2000 + index, $"r{index % 40:D4}", agents[index % 4]);
            row["currentNode"] = nodes[index % 3];
            rows.Add(row);
        }
        foreach (var chunk in rows.Chunk(400))
            catalog.Upsert(chunk);
        fixture.Database.ExecuteOwnerAsync("ANALYZE").GetAwaiter().GetResult();
    }

    private sealed record Plan(string Sql, string Text);

    // Runs `query` and returns the EXPLAIN of each statement it issued, with its arguments.
    private static List<Plan> Plans(PostgresCatalogFixture fixture, PgSessionCatalog catalog, Action query)
    {
        var statements = new List<(string Sql, object?[] Args)>();
        // A parameter object belongs to the command it ran in, so the EXPLAIN gets a copy.
        catalog.StatementObserved = (sql, args) =>
            statements.Add((sql, args.Select(arg => arg is NpgsqlParameter parameter ? parameter.Clone() : arg).ToArray()));
        try
        {
            query();
        }
        finally
        {
            catalog.StatementObserved = null;
        }
        return statements
            .Select(statement => new Plan(
                statement.Sql,
                string.Join(
                    "\n",
                    fixture.Query("EXPLAIN " + statement.Sql, statement.Args).Select(row => (string)row[0]!)
                )
            ))
            .ToList();
    }

    private void AssertIndexed(Plan plan, params string[] indexes)
    {
        output.WriteLine(plan.Sql + "\n" + plan.Text + "\n");
        Assert.True(
            indexes.Any(index => plan.Text.Contains(" using " + index + " ", StringComparison.Ordinal)
                || plan.Text.Contains(" on " + index, StringComparison.Ordinal)),
            $"Expected one of {string.Join(", ", indexes)}:\n{plan.Text}"
        );
        Assert.DoesNotContain("Seq Scan on session_catalog", plan.Text);
        Assert.DoesNotContain("Sort  (", plan.Text);
    }

    [Fact]
    public void Keyset_pages_children_groups_and_startup_selections_use_their_indexes_without_sorting()
    {
        using var fixture = PostgresCatalogFixture.Open();
        var catalog = new PgSessionCatalog(fixture.Tenant);
        SeedForPlans(fixture, catalog);
        Plan Single(Action query) => Assert.Single(Plans(fixture, catalog, query));

        // Sidebar root pages, first and continuation, rank by subtree activity.
        AssertIndexed(Single(() => catalog.Page("default", 50, null, true, null)), "idx_session_catalog_root_activity_default");
        AssertIndexed(
            Single(() => catalog.Page("default", 50, new JsonArray(1, 0, 1, 0, -900, "r0900"), true, null)),
            "idx_session_catalog_root_activity_default"
        );
        AssertIndexed(Single(() => catalog.Page("time", 50, null, true, null)), "idx_session_catalog_root_activity");
        AssertIndexed(
            Single(() => catalog.Page("time", 50, new JsonArray(1, 0, -900, "r0900"), true, null)),
            "idx_session_catalog_root_activity"
        );
        // The all-Sessions Flat page has no index in SQLite either; both take a bounded top-N.
        AssertIndexed(Single(() => catalog.Page("default", 50, null, true, null, pinnedOnly: true)), "idx_session_catalog_root_activity_default");
        AssertIndexed(Single(() => catalog.Page("time", 50, null, true, "alpha")), "idx_session_catalog_agent_time");

        // Child windows: one bounded seek per parent through the index SQLite names.
        foreach (var (mode, agent, index) in new[]
        {
            ("default", (string?)null, "idx_session_catalog_parent_activity_default"),
            ("time", null, "idx_session_catalog_parent_activity"),
            ("flat-time", null, "idx_session_catalog_parent_time"),
            ("time", "alpha", "idx_session_catalog_parent_agent_architecture"),
        })
        {
            var plans = Plans(
                fixture,
                catalog,
                () => catalog.Children([("r0001", null), ("r0002", null), ("r0003", null)], mode, 5, agent)
            );
            AssertIndexed(plans[0], index);
            Assert.Equal(3, plans[0].Text.Split(" using " + index + " ").Length - 1);
        }
        AssertIndexed(
            Plans(fixture, catalog, () => catalog.Children([("r0001", new JsonArray(0, 0, 0, -2500, "c0500"))], "default", 5, null))[0],
            "idx_session_catalog_parent_activity_default"
        );

        // Group pages use the partial and Flat group indexes.
        foreach (var (by, mode, index) in new[]
        {
            ("agent", "default", "idx_session_catalog_agent_root_activity_default"),
            ("agent", "time", "idx_session_catalog_agent_root_activity"),
            ("agent", "flat-time", "idx_session_catalog_agent_time"),
            ("node", "default", "idx_session_catalog_node_root_activity_default"),
            ("node", "time", "idx_session_catalog_node_root_activity"),
            ("node", "flat-time", "idx_session_catalog_node_time"),
        })
            AssertIndexed(Single(() => catalog.GroupPage(by, by == "agent" ? "alpha" : "box", mode, 50, null, by == "agent" ? "alpha/main" : null)), index);
        AssertIndexed(
            Single(() => catalog.GroupPage("agent", "alpha", "time", 50, new JsonArray(0, -900, "r0900"), null)),
            "idx_session_catalog_agent_root_activity"
        );

        // Recent child windows and startup selections.
        AssertIndexed(Single(() => catalog.RecentChildCounts(["r0001", "r0002"], 2500, 5)), "idx_session_catalog_parent_activity");
        AssertIndexed(Single(() => catalog.QuestionRows(50)), "idx_session_catalog_question_presence");
        AssertIndexed(Single(() => catalog.RecentWaitIds(500)), "idx_session_catalog_wait_presence", "idx_session_catalog_recent");
        var restart = Single(() => catalog.RestartIds());
        foreach (var index in new[] { "idx_session_catalog_recovery_busy", "idx_session_catalog_recovery_queued", "idx_session_catalog_recovery_managed" })
            Assert.Contains(" " + index, restart.Text);
        Assert.DoesNotContain("Seq Scan on session_catalog", restart.Text);
        AssertIndexed(Single(() => catalog.List(50, 100)), "idx_session_catalog_recent");
        AssertIndexed(Single(() => catalog.OffsetPage(50, 0, agent: "beta")), "idx_session_catalog_agent_recent");
        AssertIndexed(Single(() => catalog.IdentityChildren("r0001")), "idx_session_catalog_parent_reference");
        foreach (var key in new[] { "r0001", "alias-0001", "old-0001" })
        {
            var resolve = Single(() => catalog.Resolve(key));
            output.WriteLine(resolve.Text);
            Assert.DoesNotContain("Seq Scan", resolve.Text);
        }
        var batch = Plans(fixture, catalog, () => catalog.ResolveMany(["alias-0001", "old-0002", "r0003"]));
        Assert.Equal(2, batch.Count);
        AssertIndexed(batch[0], "session_catalog_pkey");
        AssertIndexed(batch[1], "session_alias_pkey");
    }
}
