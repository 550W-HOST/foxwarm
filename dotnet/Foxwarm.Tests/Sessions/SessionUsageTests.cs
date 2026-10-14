using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionUsageTests
{
    private static JsonObject Usage(int cached, int input, int output) => new()
    {
        ["cachedTokens"] = cached,
        ["inputTokens"] = input,
        ["outputTokens"] = output,
        ["reasoningTokens"] = output,
    };

    private sealed class UsageChat(params ChatResult[] results) : IChatService
    {
        private readonly Queue<ChatResult> pending = new(results);
        public Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken) =>
            Task.FromResult(pending.Dequeue());
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
        var chat = new UsageChat(first, second, new ChatResult(null, Usage(2, 3, 1)), ChatResult.Text("Legacy completion without usage"));
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
        var reopened = await new PersistentSessionAuthorityStore(temp.Path, "usage").LoadAsync("usage");
        Assert.True(JsonNode.DeepEquals(stats, reopened!.AuthorityEnvelope["stats"]));
        await entry.SaveLane.SaveStrictAsync();
        Assert.True(JsonNode.DeepEquals(stats, (await store.LoadAsync("usage"))!.AuthorityEnvelope["stats"]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Assistant_usage_follows_the_same_pre_and_post_commit_boundary_as_its_history(bool postCommit)
    {
        using var temp = new TempDirectory();
        var fired = false;
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "usage",
            canonicalCommitBarrier: (commit, _) => commit == 2 && !postCommit
                ? Task.FromException(new IOException("Assistant precommit failed"))
                : Task.CompletedTask,
            publishProjection: snapshot =>
            {
                if (postCommit && !fired && snapshot.History.Any(row => row["role"]?.ToString() == "model"))
                {
                    fired = true;
                    throw new IOException("Assistant committed, projection failed");
                }
            }
        );
        var registry = new SessionRegistry(store, new UsageChat(ChatResult.Text("Measured completion") with { Usage = Usage(10, 30, 5) }));
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
        Assert.Equal(postCommit ? 2 : 1, hot.History.Count);
        Assert.Equal(hot.History.Count, store.Archive.ReadMessages().Count);
        Assert.Equal(postCommit ? 30 : 0, SessionCatalog.Number(hot.AuthorityEnvelope["stats"]?["totalInputTokens"]) ?? 0);
        Assert.Equal(postCommit ? 30 : 0, SessionCatalog.Number(cold.AuthorityEnvelope["stats"]?["totalInputTokens"]) ?? 0);
        await entry.SaveLane.SaveStrictAsync();
        Assert.Equal(postCommit ? 30 : 0, SessionCatalog.Number((await store.LoadAsync("usage"))!.AuthorityEnvelope["stats"]?["totalInputTokens"]) ?? 0);
    }
}
