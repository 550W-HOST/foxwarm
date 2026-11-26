using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Models;

// The usage ledger and redaction statistics (moved from LlmUsageLedgerTests, plus the
// redaction queries).
public abstract partial class LlmJournalContractTests
{
    [Fact]
    public async Task Successful_results_record_usage_in_the_same_command()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
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
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
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
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var id = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 1)));
        var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1;
        var cells = store.QueryUsage([before - 1000, before, after, after + 1000], null);
        Assert.Equal(1, Assert.Single(cells).Bucket);
        Assert.Throws<ArgumentException>(() => store.QueryUsage(Everything, "result_json"));
        Assert.Throws<ArgumentException>(() => store.QueryUsage([1], null));
    }

    [Fact]
    public async Task Reads_never_wait_for_the_journal_writer()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        var id = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 1)));
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        backend.BeforeBatch(store, () =>
        {
            held.TrySetResult();
            return release.Task;
        });
        var blocked = await store.EnqueueRequestAsync("s", "test", 0, "System", new(), History(), "m", "c");
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
            await blocked.Completion;
        }
    }

    [Fact]
    public async Task Backfill_rebuilds_history_newest_first_resumes_and_catches_up_after_a_downgrade()
    {
        await using var backend = await CreateAsync();
        var ids = new List<string>();
        await using (var store = backend.Open())
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
            Assert.Equal(0, backend.Ledger());
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
            Assert.Equal(2, backend.Ledger());
            Assert.Equal(1, backend.Count("SELECT count(*) FROM llm_usage WHERE model_key='x/y' AND input_tokens IS NULL AND cost IS NULL"));
            Assert.False(store.UsageCoverage().Complete);
        }

        await using (var store = backend.Open())
        {
            await store.BackfillUsageAsync(CancellationToken.None, batchSize: 2);
            Assert.Equal(6, backend.Ledger());
            Assert.True(store.UsageCoverage().Complete);
            var total = Assert.Single(store.QueryUsage(Everything, null));
            Assert.Equal((6L, 5L, 10L, 15L, 4L), (total.Requests, total.CachedTokens, total.InputTokens, total.OutputTokens, total.PricedRequests));
            Assert.Equal(2, total.Cost, 10);
            Assert.Equal(3, backend.Count("SELECT count(*) FROM llm_usage WHERE session_id='even'"));
            Assert.Equal(1, backend.Count("SELECT count(*) FROM llm_usage WHERE provider_key='x'"));

            // A version without the ledger writes more results; the next start covers them.
            var late = await StartAsync(store, "even", "btw", "p/m");
            await LegacySuccessAsync(store, late, Usage(0, 1, 0, 0.1));
            var live = await StartAsync(store, "even", "btw", "p/m");
            await store.AppendChatResultAsync(live, 1, Result(Usage(0, 1, 0, 0.1)));
            Assert.Equal(7, backend.Ledger());
            await store.BackfillUsageAsync(CancellationToken.None);
            Assert.Equal(8, backend.Ledger());
            Assert.Equal(backend.MaxResult(), backend.Metadata("usage-ledger-high"));
            // Reruns are idempotent.
            await store.BackfillUsageAsync(CancellationToken.None);
            Assert.Equal(8, backend.Ledger());
        }
    }

    [Fact]
    public async Task Live_results_extend_the_covered_range_so_a_restart_rescans_nothing()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
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
        Assert.Equal(backend.MaxResult(), backend.Metadata("usage-ledger-high"));

        // A success recorded without its row (as by a version without the ledger) stops the
        // covered range until a pass adds it, then live results extend it again.
        var gap = await StartAsync(store, "s", "btw", "p/m");
        await LegacySuccessAsync(store, gap, Usage(0, 1, 1, 0.1));
        var covered = backend.Metadata("usage-ledger-high");
        var after = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(after, 1, Result(Usage(0, 1, 1, 0.1)));
        Assert.Equal(covered, backend.Metadata("usage-ledger-high"));
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(backend.MaxResult(), backend.Metadata("usage-ledger-high"));
        Assert.Equal(6, backend.Ledger());
    }

    private static LlmRedactionRecord Redaction(
        string? session,
        string? failure = null,
        int detected = 0,
        JsonObject? labels = null
    ) =>
        new(
            session,
            "normal-turn",
            "p/m",
            "p",
            "openai-responses",
            null,
            failure,
            detected,
            1,
            labels ?? new JsonObject(),
            new JsonObject { ["secret"] = 1 },
            4,
            2,
            1,
            1,
            2.5,
            false
        );

    [Fact]
    public async Task Redaction_statistics_travel_with_results_or_alone_and_aggregate_by_kind_and_label()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        var sent = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(
            sent,
            1,
            Result(Usage(0, 1, 1, 0.1)),
            redaction: Redaction("s", detected: 3, labels: new JsonObject { ["private_person"] = 2, ["email"] = 1 })
        );
        var other = await StartAsync(store, "t", "normal-turn", "p/m");
        Assert.True(await store.AppendRedactionAsync(
            other,
            1,
            Redaction("t", detected: 1, labels: new JsonObject { ["private_person"] = 1 })
        ));
        // A detection failure consumed attempt 2 without sending anything.
        Assert.True(await store.AppendRedactionAsync(other, 2, Redaction("t", failure: "timeout", detected: 9)));
        // The same attempt is recorded once; a repeat changes nothing.
        await store.AppendRedactionAsync(other, 1, Redaction("t", detected: 5));

        var total = Assert.Single(store.QueryRedaction(Everything, null));
        Assert.Equal((2L, 4L, 2L, 8L, 2L, 2L, 0L), (total.Attempts, total.Detected, total.Literal, total.Slots, total.CachedSlots, total.DetectorCalls, total.Omitted));
        Assert.Equal(5.0, total.DetectionMs, 10);
        Assert.Equal(3, total.Labels["private_person"]);
        Assert.Equal(1, total.Labels["email"]);
        Assert.Equal(2, total.Labels["secret"]);
        Assert.Equal(1, Assert.Single(total.Failures).Value);
        Assert.Equal("timeout", total.Failures.Keys.Single());
        var bySession = store.QueryRedaction(Everything, "model_key", bySession: true);
        Assert.Equal(["s", "t"], bySession.Select(cell => cell.SessionId!).Order().ToArray());
        Assert.All(bySession, cell => Assert.Equal("p/m", cell.Key));
        Assert.Equal(["s", "t"], store.RedactionSessions(0, long.MaxValue).Order().ToArray());
        // Redaction rows are not usage: only the sent success is in the ledger.
        Assert.Equal(1, backend.Ledger());
    }
}
