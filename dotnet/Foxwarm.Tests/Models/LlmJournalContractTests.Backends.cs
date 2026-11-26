using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;
using Microsoft.Data.Sqlite;
using Npgsql;

namespace Foxwarm.Tests.Models;

public sealed class FileLlmJournalContractTests : LlmJournalContractTests
{
    private protected override Task<Backend> CreateAsync() => Task.FromResult<Backend>(new Files());

    private sealed class Files : Backend
    {
        private readonly TempDirectory temp = new();

        internal override ILlmJournalStore Open() => new LlmRequestJournalStore(temp.Path);

        internal override long Count(string sql)
        {
            using var connection = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = Path.Combine(temp.Path, "state", "llm-request-journal.sqlite"),
                    Mode = SqliteOpenMode.ReadOnly,
                    Pooling = false,
                }.ToString()
            );
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            return Convert.ToInt64(command.ExecuteScalar());
        }

        internal override string ResultOrder => "rowid";

        internal override void BeforeBatch(ILlmJournalStore store, Func<Task>? hook) =>
            ((LlmRequestJournalStore)store).Writer.BeforeBatch = hook;

        internal override long CommittedBatches(ILlmJournalStore store) =>
            ((LlmRequestJournalStore)store).Writer.CommittedBatches;

        internal override int LargestBatch(ILlmJournalStore store) =>
            ((LlmRequestJournalStore)store).Writer.LargestBatch;

        public override ValueTask DisposeAsync()
        {
            SqliteConnection.ClearAllPools();
            temp.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}

[Trait("Backend", "postgres")]
public sealed class PostgresLlmJournalContractTests : LlmJournalContractTests
{
    private protected override async Task<Backend> CreateAsync() => await Tenant.OpenAsync();

    /// <summary>One tenant database; stores built over it share the tenant's rows.</summary>
    private sealed class Tenant(HostedTestDatabase database, TenantDb tenant) : Backend
    {
        internal HostedTestDatabase Database => database;

        internal TenantDb Db => tenant;

        internal static async Task<Tenant> OpenAsync()
        {
            var server = await PostgresServer.SharedAsync();
            var database = await server.CreateDatabaseAsync();
            var tenantId = await database.TenantIdAsync();
            var epoch = await database.TakeLeaseAsync(tenantId);
            return new Tenant(database, new TenantDb(database.OpenApp(), tenantId, epoch));
        }

        internal override ILlmJournalStore Open() => new PgLlmJournalStore(tenant);

        internal PgLlmJournalStore Open(TimeProvider clock) => new(tenant, clock);

        internal override long Count(string sql) =>
            Convert.ToInt64(database.ScalarAsync(sql).GetAwaiter().GetResult() ?? 0L);

        internal override string ResultOrder => "seq";

        internal override void BeforeBatch(ILlmJournalStore store, Func<Task>? hook) =>
            ((PgLlmJournalStore)store).Writer.BeforeBatch = hook;

        internal override long CommittedBatches(ILlmJournalStore store) =>
            ((PgLlmJournalStore)store).Writer.CommittedBatches;

        internal override int LargestBatch(ILlmJournalStore store) =>
            ((PgLlmJournalStore)store).Writer.LargestBatch;

        public override ValueTask DisposeAsync() => database.DisposeAsync();
    }

    private static readonly string[] Tables =
    [
        "llm_journal_metadata",
        "llm_journal_objects",
        "llm_journal_requests",
        "llm_journal_request_objects",
        "llm_journal_attempt_starts",
        "llm_journal_attempt_results",
        "llm_usage",
        "llm_redaction",
    ];

    private static string Rows(Tenant backend) =>
        string.Join(",", Tables.Select(table => table + "=" + backend.Count("SELECT count(*) FROM " + table)));

    private static LlmRedactionRecord Stats(string session) =>
        new(session, "normal-turn", "p/m", "p", "t", null, null, 1, 0, new JsonObject(), new JsonObject(), 1, 1, 0, 1, 1, false);

    [Theory]
    [InlineData("request")]
    [InlineData("attempt-start")]
    [InlineData("attempt-result")]
    [InlineData("chat-result")]
    [InlineData("redaction")]
    [InlineData("backfill")]
    [InlineData("retention")]
    public async Task A_write_after_a_takeover_is_fenced_and_leaves_nothing(string operation)
    {
        await using var backend = await Tenant.OpenAsync();
        var clock = new ManualClock(DateTimeOffset.UtcNow.AddDays(-30));
        await using var store = backend.Open(clock);
        var id = await store.BeginRequestAsync("s", "normal-turn", 0, "System", new JsonArray(), [User("hello")], "m", "c");
        await store.AppendAttemptStartAsync(id, 1, "p/m", null, "t", new JsonObject(), "System");
        await store.BackfillUsageAsync(CancellationToken.None);
        var fenced = 0;
        backend.Db.Fenced += _ => fenced++;
        var before = Rows(backend);

        await backend.Database.TakeLeaseAsync(backend.Db.TenantId, "other");
        Task write = operation switch
        {
            "request" => store.BeginRequestAsync("s", "normal-turn", 1, "Other", new JsonArray(), [User("new")], "m", "c"),
            "attempt-start" => store.AppendAttemptStartAsync(id, 2, "p/m", null, "t", new JsonObject(), "Override"),
            "attempt-result" => store.AppendAttemptResultAsync(id, 1, "failure", null, new JsonObject { ["m"] = "x" }),
            "chat-result" => store.AppendChatResultAsync(
                id,
                1,
                new ChatResult(new JsonObject { ["role"] = "model", ["parts"] = new JsonArray() }, new JsonObject { ["inputTokens"] = 1 }),
                redaction: Stats("s")
            ),
            "redaction" => store.AppendRedactionAsync(id, 1, Stats("s")),
            "backfill" => store.BackfillUsageAsync(CancellationToken.None),
            _ => store.PurgeAsync(long.MaxValue, CancellationToken.None),
        };
        await Assert.ThrowsAsync<TenantFencedException>(() => write);
        Assert.True(fenced > 0);
        Assert.Equal(before, Rows(backend));
    }

    [Fact]
    public async Task Retention_deletes_old_requests_attempts_and_their_unreferenced_objects_and_keeps_the_ledger()
    {
        await using var backend = await Tenant.OpenAsync();
        var start = DateTimeOffset.UtcNow.AddDays(-100);
        var clock = new ManualClock(start);
        await using var store = backend.Open(clock);
        async Task<string> Request(string session, params string[] texts)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            return await store.BeginRequestAsync(
                session,
                "normal-turn",
                0,
                "System",
                new JsonArray(),
                texts.Select(User).ToArray(),
                "p/m",
                "c"
            );
        }
        async Task Succeed(string request, int attempt = 1, string prompt = "System")
        {
            await store.AppendAttemptStartAsync(request, attempt, "p/m", null, "t", new JsonObject(), prompt);
            await store.AppendChatResultAsync(
                request,
                attempt,
                new ChatResult(
                    new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject { ["text"] = "ok" }) },
                    new JsonObject { ["inputTokens"] = 3, ["outputTokens"] = 1, ["cost"] = 0.5 }
                ),
                redaction: Stats(request)
            );
        }
        // Old: Session a's chain continues into the retained period; Session b's doesn't.
        var a1 = await Request("a", "hello");
        await Succeed(a1);
        var a2 = await Request("a", "hello", "a two");
        await Succeed(a2);
        var b1 = await Request("b", "hello", "only b");
        await store.AppendAttemptStartAsync(b1, 1, "p/m", null, "t", new JsonObject(), "System");
        await store.AppendAttemptResultAsync(b1, 1, "failure", null, new JsonObject { ["m"] = "x" });
        await Succeed(b1, 2, "Only-b override");
        var b2 = await Request("b", "hello", "only b", "b two");
        await Succeed(b2);
        var old = await store.ListAsync(null, null, null, null, 100);
        Assert.Equal(4, old.Count);

        clock.Advance(TimeSpan.FromDays(60));
        var cutoff = clock.GetUtcNow().ToUnixTimeMilliseconds();
        clock.Advance(TimeSpan.FromDays(1));
        var a3 = await Request("a", "hello", "a two", "a three");
        await Succeed(a3);
        var c1 = await Request("c", "hello");
        await Succeed(c1);
        await store.BackfillUsageAsync(CancellationToken.None);
        var usage = Assert.Single(store.QueryUsage([0, long.MaxValue], null));
        var redaction = Assert.Single(store.QueryRedaction([0, long.MaxValue], null));
        var coverage = store.UsageCoverage();
        Assert.True(coverage.Complete);
        Assert.Equal(6, usage.Requests);
        static long Objects(Tenant backend, string text) =>
            backend.Count($"SELECT count(*) FROM llm_journal_objects WHERE payload LIKE '%{text}%'");
        Assert.Equal(1, Objects(backend, "only b"));
        Assert.Equal(1, Objects(backend, "Only-b override"));

        // Batches of one, so the job walks past kept requests.
        var purged = await store.PurgeAsync(cutoff, CancellationToken.None, batchSize: 1);
        Assert.Equal(2, purged.Requests);
        Assert.Equal(6, purged.Attempts);
        foreach (var gone in new[] { b1, b2 })
            Assert.Equal("legacy-partial", (await store.ReconstructAsync(gone))["completeness"]!.GetValue<string>());
        Assert.Equal(0, backend.Count($"SELECT count(*) FROM llm_journal_attempt_starts WHERE request_id IN ('{b1}','{b2}')"));
        Assert.Equal(0, backend.Count($"SELECT count(*) FROM llm_journal_attempt_results WHERE request_id IN ('{b1}','{b2}')"));
        Assert.Equal(0, Objects(backend, "only b"));
        Assert.Equal(0, Objects(backend, "b two"));
        Assert.Equal(0, Objects(backend, "Only-b override"));
        // Objects that retained requests reference stay, as do the old bases of a3's chain.
        Assert.Equal(1, Objects(backend, "hello"));
        foreach (var kept in new[] { a1, a2, a3, c1 })
        {
            var request = await store.ReconstructAsync(kept);
            Assert.Equal("complete", request["completeness"]!.GetValue<string>());
        }
        var a3Request = await store.ReconstructAsync(a3);
        Assert.Equal(3, a3Request["messages"]!.AsArray().Count);

        // The ledger and redaction statistics are whole: the usage overview doesn't change.
        Assert.Equal(usage, Assert.Single(store.QueryUsage([0, long.MaxValue], null)));
        var after = Assert.Single(store.QueryRedaction([0, long.MaxValue], null));
        Assert.Equal((redaction.Attempts, redaction.Detected), (after.Attempts, after.Detected));
        Assert.Equal(coverage, store.UsageCoverage());
        Assert.Equal(
            ["a", "b", "c"],
            store.UsageSessions(0, long.MaxValue).Order().ToArray()
        );
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(usage, Assert.Single(store.QueryUsage([0, long.MaxValue], null)));

        // A second pass has nothing left to delete.
        Assert.Equal(new JournalRetentionResult(0, 0, 0), await store.PurgeAsync(cutoff, CancellationToken.None));
    }

    [Fact]
    public async Task A_lost_commit_reply_is_resolved_by_the_batch_transaction_id()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var id = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(id);
        await using var proxy = PgTcpProxy.For(database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(database.AppConnectionString))
        {
            Pooling = false,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString;
        await using var store = new PgLlmJournalStore(new TenantDb(database.OpenApp(routed), id, epoch));
        var held = 0;
        store.Writer.BeforeCommit = (_, _) =>
        {
            if (Interlocked.Exchange(ref held, 1) == 0)
                proxy.HoldExisting(toServer: false, toClient: true);
        };
        var request = await store.BeginRequestAsync("s", "test", 0, "System", new JsonArray(), [User("once")], "m", "c");
        Assert.Equal(1, held);
        Assert.Equal("complete", (await store.ReconstructAsync(request))["completeness"]!.GetValue<string>());
        Assert.Single(await store.ListAsync("s", null, null, null, 10));
    }

    [Fact]
    public async Task The_runtime_role_cannot_delete_or_rewrite_the_usage_ledger()
    {
        await using var backend = await Tenant.OpenAsync();
        foreach (var sql in new[]
        {
            "DELETE FROM llm_usage",
            "UPDATE llm_usage SET cost = 0",
            "DELETE FROM llm_redaction",
        })
        {
            var error = Assert.Throws<PostgresException>(() => backend.Db.Write(tx => tx.Execute(sql)));
            Assert.Equal("42501", error.SqlState);
        }
    }

    [Fact]
    public async Task The_daily_job_runs_in_the_owner_and_stops_with_the_journal()
    {
        await using var backend = await Tenant.OpenAsync();
        var clock = new ManualClock(DateTimeOffset.UtcNow.AddDays(-40));
        var store = backend.Open(clock);
        await store.BeginRequestAsync("s", "normal-turn", 0, "System", new JsonArray(), [User("old")], "m", "c");
        clock.Advance(TimeSpan.FromDays(40));
        await store.BeginRequestAsync("s2", "normal-turn", 0, "System", new JsonArray(), [User("new")], "m", "c");

        store.StartRetention(JournalRetentionOptions.Unlimited, TimeSpan.Zero);
        Assert.True(store.RetentionTask.IsCompleted);
        store.StartRetention(new JournalRetentionOptions(30), TimeSpan.FromMilliseconds(10), TimeSpan.FromHours(1));
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (backend.Count("SELECT count(*) FROM llm_journal_requests") != 1 && DateTime.UtcNow < deadline)
            await Task.Delay(50);
        Assert.Equal(1, backend.Count("SELECT count(*) FROM llm_journal_requests WHERE session_id='s2'"));
        Assert.Equal(1, backend.Count("SELECT count(*) FROM llm_journal_requests"));
        var job = store.RetentionTask;
        Assert.False(job.IsCompleted);
        await store.DisposeAsync();
        Assert.True(job.IsCompleted);
    }

    private static JsonObject User(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private sealed class ManualClock(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset now = start;

        public override DateTimeOffset GetUtcNow() => now;

        internal void Advance(TimeSpan by) => now += by;
    }
}
