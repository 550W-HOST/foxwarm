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

    [Fact]
    public async Task Successful_results_record_attributed_usage_in_the_same_command()
    {
        await using var store = new LlmRequestJournalStore(root);
        store.SessionAgent = id => id == "s-1" ? "alpha" : null;
        var recorded = 0;
        store.UsageRecorded += () => recorded++;

        var normal = await StartAsync(store, "s-1", "normal-turn", "prov/m1", "auto");
        await store.AppendChatResultAsync(
            normal,
            1,
            Result(Usage(8, 2, 5, 0.25)),
            attribution: new LlmUsageAttribution("s-1", "prov")
        );
        var unknown = await StartAsync(store, "s-gone", "compact-plan", "prov/m1");
        await store.AppendChatResultAsync(
            unknown,
            1,
            Result(Usage(0, 4, 1, null)),
            attribution: new LlmUsageAttribution("s-gone", "prov")
        );
        // A request outside any Session, with no reported usage at all.
        var setup = await StartAsync(store, null, "setup-test", "solo");
        await store.AppendChatResultAsync(
            setup,
            1,
            Result(null),
            attribution: new LlmUsageAttribution(null, "solo")
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

        var total = Assert.Single(await store.QueryUsageAsync(Everything, null, null));
        Assert.Equal((3L, 8L, 6L, 6L, 1L), (total.Requests, total.CachedTokens, total.InputTokens, total.OutputTokens, total.PricedRequests));
        Assert.Equal(0.25, total.Cost, 10);

        var agents = (await store.QueryUsageAsync(Everything, "agent", null)).ToDictionary(
            cell => cell.Key ?? "<none>"
        );
        Assert.Equal(1, agents["alpha"].Requests);
        // Unattributed Session requests and requests outside Sessions stay distinguishable.
        Assert.Equal(1, agents[""].Requests);
        Assert.Equal(1, agents["<none>"].Requests);

        var purposes = (await store.QueryUsageAsync(Everything, "purpose", null))
            .Select(cell => cell.Key)
            .Order()
            .ToArray();
        Assert.Equal(["compact-plan", "normal-turn", "setup-test"], purposes);
        var providers = (await store.QueryUsageAsync(Everything, "provider_key", null)).ToDictionary(
            cell => cell.Key!
        );
        Assert.Equal(2, providers["prov"].Requests);
        Assert.Equal(1, providers["solo"].Requests);
        Assert.Equal(
            1,
            Assert.Single(await store.QueryUsageAsync(Everything, "model_key", "alpha")).Requests
        );
        var coverage = await store.UsageCoverageAsync();
        Assert.NotNull(coverage.Earliest);
    }

    [Fact]
    public async Task Buckets_split_on_the_supplied_boundaries()
    {
        await using var store = new LlmRequestJournalStore(root);
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var id = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 1)));
        var after = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1;
        var cells = await store.QueryUsageAsync([before - 1000, before, after, after + 1000], null, null);
        Assert.Equal(1, Assert.Single(cells).Bucket);
        await Assert.ThrowsAsync<ArgumentException>(() =>
            store.QueryUsageAsync(Everything, "result_json", null)
        );
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
            Assert.False((await store.UsageCoverageAsync()).Complete);

            using var stop = new CancellationTokenSource();
            var batches = new List<string[]>();
            IReadOnlyDictionary<string, string?> Resolve(IReadOnlyCollection<string> sessions)
            {
                batches.Add(sessions.Order().ToArray());
                if (batches.Count == 2)
                    stop.Cancel();
                return sessions.ToDictionary(id => id, id => id == "even" ? "beta" : (string?)null);
            }
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
                store.BackfillUsageAsync(Resolve, stop.Token, batchSize: 2)
            );
            // The newest batch (the usage-less result and the newest legacy one) committed first.
            Assert.Equal(2, Count(root));
            Assert.Equal(1, Count(root, "SELECT count(*) FROM llm_usage WHERE model_key='x/y' AND input_tokens IS NULL AND cost IS NULL"));
            Assert.False((await store.UsageCoverageAsync()).Complete);
        }

        await using (var store = new LlmRequestJournalStore(root))
        {
            await store.BackfillUsageAsync(
                sessions => sessions.ToDictionary(id => id, id => id == "even" ? "beta" : (string?)null),
                CancellationToken.None,
                batchSize: 2
            );
            Assert.Equal(6, Count(root));
            Assert.True((await store.UsageCoverageAsync()).Complete);
            var total = Assert.Single(await store.QueryUsageAsync(Everything, null, null));
            Assert.Equal((6L, 5L, 10L, 15L, 4L), (total.Requests, total.CachedTokens, total.InputTokens, total.OutputTokens, total.PricedRequests));
            Assert.Equal(2, total.Cost, 10);
            Assert.Equal(3, Count(root, "SELECT count(*) FROM llm_usage WHERE agent='beta'"));
            Assert.Equal(1, Count(root, "SELECT count(*) FROM llm_usage WHERE provider_key='x'"));

            // A version without the ledger writes more results; the next start covers them.
            var late = await StartAsync(store, "even", "btw", "p/m");
            await LegacySuccessAsync(store, late, Usage(0, 1, 0, 0.1));
            var live = await StartAsync(store, "even", "btw", "p/m");
            await store.AppendChatResultAsync(live, 1, Result(Usage(0, 1, 0, 0.1)));
            Assert.Equal(7, Count(root));
            await store.BackfillUsageAsync(
                sessions => sessions.ToDictionary(id => id, _ => (string?)"beta"),
                CancellationToken.None
            );
            Assert.Equal(8, Count(root));
            // Reruns are idempotent.
            await store.BackfillUsageAsync(_ => new Dictionary<string, string?>(), CancellationToken.None);
            Assert.Equal(8, Count(root));
        }
    }
}
