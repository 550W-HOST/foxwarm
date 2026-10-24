using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionUsageTests
{
    private static JsonObject Usage(int cached, int input, int output, double? cost = null)
    {
        var usage = new JsonObject
        {
            ["cachedTokens"] = cached,
            ["inputTokens"] = input,
            ["outputTokens"] = output,
            ["reasoningTokens"] = output,
        };
        if (cost is double amount)
            usage["cost"] = amount;
        return usage;
    }

    private sealed class UsageChat(params ChatResult[] results) : IChatService
    {
        private readonly Queue<ChatResult> pending = new(results);

        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken cancellationToken
        ) => Task.FromResult(pending.Dequeue());
    }

    [Fact]
    public async Task Completed_usage_is_cumulative_once_per_result_and_survives_reopen_without_recounting_history()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "usage");
        var first = ChatResult.Text("First completion") with { Usage = Usage(10, 30, 5) };
        first.AssistantMessage!["__meta"] = new JsonObject { ["usage"] = Usage(900, 900, 900) };
        // Explicit result usage wins; legacy normalized message usage remains readable.
        var second = ChatResult.Text("Second completion");
        second.AssistantMessage!["__meta"] = new JsonObject { ["usage"] = Usage(20, 60, 10) };
        var chat = new UsageChat(
            first,
            second,
            new ChatResult(null, Usage(2, 3, 1)),
            ChatResult.Text("Legacy completion without usage")
        );
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("usage");
        for (var turn = 0; turn < 4; turn++)
        {
            entry.State.Queue.Add(QueueItem.UserText("Turn " + turn));
            await registry.Runner.ProcessQueueAsync("usage");
        }
        var stats = entry.Snapshot().AuthorityEnvelope["stats"]!;
        Assert.Equal(32, stats["totalCachedTokens"]!.GetValue<double>());
        Assert.Equal(93, stats["totalInputTokens"]!.GetValue<double>());
        Assert.Equal(16, stats["totalOutputTokens"]!.GetValue<double>());
        Assert.True(JsonNode.DeepEquals(Usage(2, 3, 1), stats["lastUsage"]));
        // Usage-only completion saves totals without inventing an assistant history row.
        Assert.Equal(7, entry.Snapshot().History.Count);
        Assert.Equal(7, store.Archive.ReadMessages().Count);
        var reopened = await new PersistentSessionAuthorityStore(temp.Path, "usage").LoadAsync(
            "usage"
        );
        Assert.True(JsonNode.DeepEquals(stats, reopened!.AuthorityEnvelope["stats"]));
        await entry.SaveLane.SaveStrictAsync();
        Assert.True(
            JsonNode.DeepEquals(stats, (await store.LoadAsync("usage"))!.AuthorityEnvelope["stats"])
        );
    }

    [Fact]
    public async Task Known_zero_is_saved_and_missing_cost_does_not_reset_the_recorded_subtotal()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "cost");
        var registry = new SessionRegistry(store, new UsageChat(
            new ChatResult(null, Usage(1, 2, 3)),
            new ChatResult(null, Usage(1, 2, 3, 0)),
            new ChatResult(null, Usage(1, 2, 3, .375)),
            new ChatResult(null, Usage(1, 2, 3))
        ));
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("cost");
        for (var turn = 0; turn < 4; turn++)
        {
            await registry.Ingress.EnqueueAsync("cost", QueueItem.UserText("next"));
            await registry.Runner.ProcessQueueAsync("cost");
            var stats = entry.Snapshot().AuthorityEnvelope["stats"]!;
            Assert.Equal(turn == 0 ? null : turn == 1 ? 0d : .375, SessionCatalog.Number(stats["totalCost"]));
            Assert.Equal(turn is 0 or 3 ? null : turn == 1 ? 0d : .375, SessionCatalog.Number(stats["lastUsage"]?["cost"]));
        }
        var saved = (await store.LoadAsync("cost"))!;
        Assert.Equal(.375, SessionCatalog.Number(saved.AuthorityEnvelope["stats"]?["totalCost"]));
        Assert.Null(saved.AuthorityEnvelope["stats"]?["lastUsage"]?["cost"]);
        Assert.Equal(4, saved.History.Count); // User input only: no fabricated model rows.
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Assistant_usage_follows_the_same_pre_and_post_commit_boundary_as_its_history(
        bool postCommit
    )
    {
        using var temp = new TempDirectory();
        var fired = false;
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "usage",
            canonicalCommitBarrier: (commit, _) =>
                commit == 2 && !postCommit
                    ? Task.FromException(new IOException("Assistant precommit failed"))
                    : Task.CompletedTask,
            publishProjection: snapshot =>
            {
                if (
                    postCommit
                    && !fired
                    && snapshot.History.Materialize().Any(row => row["role"]?.ToString() == "model")
                )
                {
                    fired = true;
                    throw new IOException("Assistant committed, projection failed");
                }
            }
        );
        var registry = new SessionRegistry(
            store,
            new UsageChat(ChatResult.Text("Measured completion") with { Usage = Usage(10, 30, 5, .125) })
        );
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("usage");
        entry.State.Queue.Add(QueueItem.UserText("Run once"));
        var error = await Record.ExceptionAsync(() => registry.Runner.ProcessQueueAsync("usage"));
        if (postCommit)
            Assert.IsType<AuthorityCommittedException>(error);
        else
        {
            Assert.Null(error);
            Assert.IsType<IOException>(entry.LastBackgroundProcessorFailure);
        }
        var hot = entry.Snapshot();
        var cold = (await store.LoadAsync("usage"))!;
        Assert.Equal(postCommit ? .125 : (double?)null, SessionCatalog.Number(hot.AuthorityEnvelope["stats"]?["totalCost"]));
        Assert.Equal(postCommit ? .125 : (double?)null, SessionCatalog.Number(cold.AuthorityEnvelope["stats"]?["totalCost"]));
        Assert.Equal(postCommit ? 2 : 1, hot.History.Count);
        Assert.Equal(hot.History.Count, store.Archive.ReadMessages().Count);
        Assert.Equal(
            postCommit ? 30 : 0,
            SessionCatalog.Number(hot.AuthorityEnvelope["stats"]?["totalInputTokens"]) ?? 0
        );
        Assert.Equal(
            postCommit ? 30 : 0,
            SessionCatalog.Number(cold.AuthorityEnvelope["stats"]?["totalInputTokens"]) ?? 0
        );
        await entry.SaveLane.SaveStrictAsync();
        Assert.Equal(
            postCommit ? 30 : 0,
            SessionCatalog.Number(
                (await store.LoadAsync("usage"))!.AuthorityEnvelope["stats"]?["totalInputTokens"]
            ) ?? 0
        );
    }
}
