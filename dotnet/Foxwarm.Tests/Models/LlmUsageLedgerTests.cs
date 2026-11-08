using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests.Models;

public sealed class LlmUsageLedgerTests : IDisposable
{
    private readonly string root = Path.Combine(
        Path.GetTempPath(),
        "foxwarm-usage-ledger-" + Guid.NewGuid().ToString("N")
    );

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(root))
            Directory.Delete(root, recursive: true);
    }

    private static readonly long[] Everything = [0, long.MaxValue];

    private static JsonObject Usage(long cached, long input, long output, double? cost)
    {
        var usage = new JsonObject
        {
            ["cachedTokens"] = cached,
            ["inputTokens"] = input,
            ["outputTokens"] = output,
        };
        if (cost is not null)
            usage["cost"] = cost;
        return usage;
    }

    private static async Task<string> StartAsync(
        LlmRequestJournalStore store,
        string? session,
        string purpose,
        string model,
        string? virtualKey = null
    )
    {
        var id = await store.BeginRequestAsync(
            session,
            purpose,
            0,
            "System",
            new JsonArray(),
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "hi" }),
                },
            ],
            virtualKey ?? model,
            "cache"
        );
        await store.AppendAttemptStartAsync(
            id,
            1,
            model,
            virtualKey,
            "openai-responses",
            new JsonObject { ["input"] = "hi" },
            "System"
        );
        return id;
    }

    private static ChatResult Result(JsonObject? usage) =>
        new(
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "ok" }),
            },
            usage
        );

    // What a version without the ledger leaves behind: the result row only.
    private static Task LegacySuccessAsync(
        LlmRequestJournalStore store,
        string id,
        JsonObject? usage
    ) =>
        store.AppendAttemptResultAsync(
            id,
            1,
            "success",
            new JsonObject { ["text"] = "ok", ["usage"] = usage },
            null
        );

    private static long Count(string root, string sql = "SELECT count(*) FROM llm_usage")
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(root, "state", "llm-request-journal.sqlite"),
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static string Metadata(string root, string key) =>
        Count(root, $"SELECT CAST(value AS INTEGER) FROM llm_journal_metadata WHERE key='{key}'").ToString();

    private static long MaxResult(string root) =>
        Count(root, "SELECT max(rowid) FROM llm_journal_attempt_results");

    private static void Execute(string root, string sql)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(root, "state", "llm-request-journal.sqlite"),
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    [Fact]
    public async Task Successful_results_record_usage_in_the_same_command()
    {
        await using var store = new LlmRequestJournalStore(root);
        var recorded = 0;
        store.UsageRecorded += () => recorded++;

        var normal = await StartAsync(store, "s-1", "normal-turn", "prov/m1", "auto");
        await store.AppendChatResultAsync(
            normal,
            1,
            Result(Usage(8, 2, 5, 0.25)),
            attribution: new LlmUsageAttribution("prov")
        );
        var unknown = await StartAsync(store, "s-gone", "compact-plan", "prov/m1");
        await store.AppendChatResultAsync(
            unknown,
            1,
            Result(Usage(0, 4, 1, null)),
            attribution: new LlmUsageAttribution("prov")
        );
        // A request outside any Session, with no reported usage at all.
        var setup = await StartAsync(store, null, "setup-test", "solo");
        await store.AppendChatResultAsync(
            setup,
            1,
            Result(null),
            attribution: new LlmUsageAttribution("solo")
        );
        var failed = await StartAsync(store, "s-1", "normal-turn", "prov/m1");
        await store.AppendAttemptResultAsync(
            failed,
            1,
            "failure",
            null,
            new JsonObject { ["message"] = "x" }
        );
        Assert.Equal(3, recorded);

        var total = Assert.Single(store.QueryUsage(Everything, null));
        Assert.Equal((3L, 8L, 6L, 6L, 1L), (total.Requests, total.CachedTokens, total.InputTokens, total.OutputTokens, total.PricedRequests));
        Assert.Equal(0.25, total.Cost, 10);

        // The ledger keeps the recorded Session; Agents are attributed when it is read.
        var sessions = store.QueryUsage(Everything, null, bySession: true).ToDictionary(
            cell => cell.SessionId ?? "<none>"
        );
        Assert.Equal(["<none>", "s-1", "s-gone"], sessions.Keys.Order().ToArray());
        Assert.Equal(["s-1", "s-gone"], store.UsageSessions(0, long.MaxValue).Order().ToArray());

        var purposes = store.QueryUsage(Everything, "purpose").Select(cell => cell.Key).Order().ToArray();
        Assert.Equal(["compact-plan", "normal-turn", "setup-test"], purposes);
        var providers = store.QueryUsage(Everything, "provider_key").ToDictionary(cell => cell.Key!);
        Assert.Equal(2, providers["prov"].Requests);
        Assert.Equal(1, providers["solo"].Requests);
        Assert.Equal(
            2,
            store.QueryUsage(Everything, "model_key").Single(cell => cell.Key == "prov/m1").Requests
        );
        Assert.NotNull(store.UsageCoverage().Earliest);
    }

    [Fact]
    public async Task Session_queries_separate_rows_before_the_current_history_began()
    {
        await using var store = new LlmRequestJournalStore(root);
        var early = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(early, 1, Result(Usage(0, 1, 1, 1)));
        await Task.Delay(20);
        var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var late = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(late, 1, Result(Usage(0, 1, 1, 1)));
        var cells = store.QueryUsage(Everything, null, bySession: true, new Dictionary<string, long> { ["s"] = start });
        Assert.Equal(1, cells.Single(cell => cell.BeforeSessionStart).Requests);
        Assert.Equal(1, cells.Single(cell => !cell.BeforeSessionStart).Requests);
    }

    [Fact]
    public async Task Buckets_split_on_the_supplied_boundaries()
    {
        await using var store = new LlmRequestJournalStore(root);
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var id = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 1)));
        var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1;
        var cells = store.QueryUsage([before - 1000, before, after, after + 1000], null);
        Assert.Equal(1, Assert.Single(cells).Bucket);
        Assert.Throws<ArgumentException>(() => store.QueryUsage(Everything, "result_json"));
    }

    [Fact]
    public async Task Reads_never_wait_for_the_journal_writer()
    {
        await using var store = new LlmRequestJournalStore(root);
        var id = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 1)));
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var receipt = await store.Writer.ExclusiveAsync(async _ =>
        {
            held.SetResult();
            await release.Task;
            return true;
        });
        await held.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            var read = Task.Run(() => (store.QueryUsage(Everything, null), store.UsageCoverage()));
            var (cells, coverage) = await read.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(1, Assert.Single(cells).Requests);
            Assert.NotNull(coverage.Earliest);
        }
        finally
        {
            release.SetResult();
            await receipt.Completion;
        }
    }

    [Fact]
    public async Task Backfill_rebuilds_history_newest_first_resumes_and_catches_up_after_a_downgrade()
    {
        var ids = new List<string>();
        await using (var store = new LlmRequestJournalStore(root))
        {
            for (var index = 0; index < 5; index++)
            {
                var id = await StartAsync(store, index % 2 == 0 ? "even" : null, "btw", "p/m");
                await LegacySuccessAsync(store, id, Usage(1, 2, 3, index == 4 ? null : 0.5));
                ids.Add(id);
            }
            var failed = await StartAsync(store, "even", "btw", "p/m");
            await store.AppendAttemptResultAsync(failed, 1, "abort", null, new JsonObject());
            // A legacy result without usage still counts as a request with unknown usage.
            var odd = await StartAsync(store, "odd", "btw", "x/y");
            await store.AppendAttemptResultAsync(odd, 1, "success", new JsonObject { ["text"] = "legacy" }, null);
            Assert.Equal(0, Count(root));
            Assert.False(store.UsageCoverage().Complete);

            using var stop = new CancellationTokenSource();
            var batches = 0;
            store.UsageRecorded += () =>
            {
                if (++batches == 1)
                    stop.Cancel();
            };
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                store.BackfillUsageAsync(stop.Token, batchSize: 2)
            );
            // The newest batch (the usage-less result and the newest legacy one) committed first.
            Assert.Equal(2, Count(root));
            Assert.Equal(1, Count(root, "SELECT count(*) FROM llm_usage WHERE model_key='x/y' AND input_tokens IS NULL AND cost IS NULL"));
            Assert.False(store.UsageCoverage().Complete);
        }

        await using (var store = new LlmRequestJournalStore(root))
        {
            await store.BackfillUsageAsync(CancellationToken.None, batchSize: 2);
            Assert.Equal(6, Count(root));
            Assert.True(store.UsageCoverage().Complete);
            var total = Assert.Single(store.QueryUsage(Everything, null));
            Assert.Equal((6L, 5L, 10L, 15L, 4L), (total.Requests, total.CachedTokens, total.InputTokens, total.OutputTokens, total.PricedRequests));
            Assert.Equal(2, total.Cost, 10);
            Assert.Equal(3, Count(root, "SELECT count(*) FROM llm_usage WHERE session_id='even'"));
            Assert.Equal(1, Count(root, "SELECT count(*) FROM llm_usage WHERE provider_key='x'"));

            // A version without the ledger writes more results; the next start covers them.
            var late = await StartAsync(store, "even", "btw", "p/m");
            await LegacySuccessAsync(store, late, Usage(0, 1, 0, 0.1));
            var live = await StartAsync(store, "even", "btw", "p/m");
            await store.AppendChatResultAsync(live, 1, Result(Usage(0, 1, 0, 0.1)));
            Assert.Equal(7, Count(root));
            await store.BackfillUsageAsync(CancellationToken.None);
            Assert.Equal(8, Count(root));
            Assert.Equal(MaxResult(root).ToString(), Metadata(root, "usage-ledger-high"));
            // Reruns are idempotent.
            await store.BackfillUsageAsync(CancellationToken.None);
            Assert.Equal(8, Count(root));
        }
    }

    [Fact]
    public async Task Live_results_extend_the_covered_range_so_a_restart_rescans_nothing()
    {
        await using var store = new LlmRequestJournalStore(root);
        var old = await StartAsync(store, "s", "btw", "p/m");
        await LegacySuccessAsync(store, old, Usage(0, 1, 1, 0.1));
        await store.BackfillUsageAsync(CancellationToken.None);
        for (var index = 0; index < 3; index++)
        {
            var id = await StartAsync(store, "s", "normal-turn", "p/m");
            await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 0.1)));
        }
        var aborted = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendAttemptResultAsync(aborted, 1, "abort", null, new JsonObject());
        // Every result so far is covered without another pass.
        Assert.Equal(MaxResult(root).ToString(), Metadata(root, "usage-ledger-high"));

        // A success recorded without its row (as by a version without the ledger) stops the
        // covered range until a pass adds it, then live results extend it again.
        var gap = await StartAsync(store, "s", "btw", "p/m");
        await LegacySuccessAsync(store, gap, Usage(0, 1, 1, 0.1));
        var covered = Metadata(root, "usage-ledger-high");
        var after = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(after, 1, Result(Usage(0, 1, 1, 0.1)));
        Assert.Equal(covered, Metadata(root, "usage-ledger-high"));
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(MaxResult(root).ToString(), Metadata(root, "usage-ledger-high"));
        Assert.Equal(6, Count(root));
    }

    [Fact]
    public async Task A_removed_or_emptied_ledger_is_rebuilt_and_never_fails_a_result()
    {
        await using var store = new LlmRequestJournalStore(root);
        var failures = 0;
        store.UsageLedgerFailed += () => failures++;
        for (var index = 0; index < 3; index++)
        {
            var id = await StartAsync(store, "s", "normal-turn", "p/m");
            await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 0.1)));
        }
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.True(store.UsageCoverage().Complete);

        Execute(root, "DROP TABLE llm_usage");
        Assert.Null(store.UsageCoverage().Earliest);
        Assert.False(store.UsageCoverage().Complete);
        var during = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(during, 1, Result(Usage(0, 1, 1, 0.1)));
        Assert.Equal(1, failures);
        Assert.Equal(4, Count(root, "SELECT count(*) FROM llm_journal_attempt_results WHERE outcome='success'"));

        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(4, Count(root));
        Assert.True(store.UsageCoverage().Complete);
        Assert.NotNull(store.UsageCoverage().Earliest);

        Execute(root, "DELETE FROM llm_usage");
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(4, Count(root));
        Assert.True(store.UsageCoverage().Complete);
    }
}
