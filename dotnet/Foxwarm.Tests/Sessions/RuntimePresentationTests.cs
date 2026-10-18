using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class RuntimePresentationTests
{
    private static SessionOwner Owner(ISessionAuthorityStore store, string id = "s")
    {
        var models = HostModels.ForTest(new ResponsesClientOptions(new Uri("http://localhost"), "m", "a/m", "", "", 50));
        var owner = new SessionOwner(id, "main", models) { Registry = new SessionRegistry(store, new NoChat()) };
        owner.Registry.Add(id);
        owner.EnableCommittedNotifications();
        return owner;
    }

    [Fact]
    public void Foreground_and_compact_cleanup_cannot_erase_successors_and_retry_clears_at_actual_attempt()
    {
        var owner = Owner(new InMemorySessionAuthorityStore());
        owner.Entry.WithState(state => { state.Busy = true; state.BusyStartedAt = 10; });
        var oldTool = owner.BeginTool(new JsonObject { ["name"] = "exec", ["index"] = 0, ["total"] = 2 });
        owner.SetCompactRuntime("old", "planning", true, null);
        var compactWait = owner.BeginCompactPhase();
        Assert.Equal("compaction", owner.RuntimeSnapshot()["active"]!["phase"]!.GetValue<string>());
        owner.BeginModelAttempt();
        owner.EndTool(oldTool);
        owner.EndCompactPhase(compactWait);
        Assert.Equal("normal-turn", owner.RuntimeSnapshot()["active"]!["phase"]!.GetValue<string>());
        owner.SetModelRetry(new ModelRetryEvent(1, 6, "http", new string('x', 2000), "a/m", null, DelayMs: 5000));
        var retry = owner.RuntimeSnapshot()["retry"]!;
        Assert.Equal(2, retry["nextAttempt"]!.GetValue<int>());
        Assert.Equal(1024, retry["reason"]!.GetValue<string>().Length);
        Assert.True(retry["retryAt"]!.GetValue<long>() >= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        owner.BeginModelAttempt();
        Assert.Null(owner.RuntimeSnapshot()["retry"]);
        owner.SetCompactRuntime("new", "ready", true, null);
        owner.ClearCompactRuntime("old");
        Assert.Equal("new", owner.RuntimeSnapshot()["compaction"]!["operationId"]!.GetValue<string>());
        owner.Entry.WithState(state => state.Stopping = true);
        Assert.True(owner.RuntimeSnapshot()["stopping"]!.GetValue<bool>());
        owner.Entry.WithState(state => state.Busy = false);
        Assert.Null(owner.RuntimeSnapshot()["stopping"]);
        Assert.Equal("idle", owner.RuntimeSnapshot()["state"]!.GetValue<string>());
        Assert.NotNull(owner.RuntimeSnapshot()["compaction"]);
        owner.ClearCompactRuntime("new");
        Assert.Null(owner.RuntimeSnapshot()["compaction"]);
    }

    [Fact]
    public async Task Notices_append_once_per_exact_owner_survive_reopen_and_never_enter_provider_replay()
    {
        using var temp = new TempDirectory();
        var error = new InvalidOperationException("actual preparation diagnostics");
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var owner = Owner(store);
        await owner.Entry.SaveLane.SaveStrictAsync();
        await owner.PresentFailureAsync(error, true);
        await owner.PresentFailureAsync(error, true);
        var row = Assert.Single(owner.History());
        Assert.False(row["modelVisible"]!.GetValue<bool>());
        Assert.Equal("system-event", row["__meta"]!["noticeType"]!.GetValue<string>());
        Assert.Equal(1, row["__meta"]!["sessionNotice"]!["version"]!.GetValue<int>());
        Assert.Empty(ConcreteRequestHistory.Prepare([row], "m"));
        Assert.Equal(row.ToJsonString(), (await store.LoadAsync("s"))!.History[0].ToJson().ToJsonString());
        Assert.Equal(1, store.Archive.ReadMessageBySeq(1)!.Seq);
        var other = Owner(new InMemorySessionAuthorityStore(), "other");
        await other.PresentFailureAsync(error, true);
        Assert.Single(other.History());
        await owner.PresentFailureAsync(new OperationCanceledException(), true);
        await owner.PresentFailureAsync(new SessionTurnShutdownException(), true);
        Assert.Single(owner.History());
    }

    [Fact]
    public async Task A_failed_authority_path_presents_temporarily_without_another_append_and_terminal_retry_is_not_duplicated()
    {
        using var temp = new TempDirectory();
        var attempts = 0;
        var store = new PersistentSessionAuthorityStore(temp.Path, "s", authorityStageHook: stage =>
        {
            if (stage == AtomicJsonWriteStage.BeforeRename)
            {
                attempts++;
                throw new IOException("authority unavailable");
            }
        });
        var owner = Owner(store);
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += events.Add;
        var error = await Assert.ThrowsAsync<IOException>(() => owner.Entry.SaveLane.SaveStrictAsync());
        await owner.PresentFailureAsync(new ModelPreparationException("could not prepare", error), true);
        Assert.Equal(1, attempts);
        Assert.Empty(owner.History());
        var notice = Assert.Single(events, item => item.Kind == SessionEventKind.MessageCommitted).Data!;
        Assert.True(notice["__meta"]!["temporary"]!.GetValue<bool>());
        Assert.Equal("system-event", notice["__meta"]!["noticeType"]!.GetValue<string>());
        var retryOwner = Owner(new InMemorySessionAuthorityStore());
        var retry = new ModelRetryNotice(retryOwner);
        await retry.NotifyAsync(new ModelRetryEvent(6, 6, "http", "terminal", "a/m", null, Final: true));
        await retryOwner.PresentFailureAsync(new InvalidOperationException("terminal wrapper"), true);
        Assert.Single(retryOwner.History());
        Assert.Equal("llm-retry", retryOwner.History()[0]["__meta"]!["noticeType"]!.GetValue<string>());
    }

    [Fact]
    public void Argument_previews_follow_resolved_arguments_and_remain_bounded()
    {
        Assert.Equal("printf actual", SessionToolExecutor.ToolArgsPreview("exec", new JsonObject { ["command"] = "printf actual", ["timeout"] = 10 }));
        Assert.Equal("a.txt (lines 2-4)", SessionToolExecutor.ToolArgsPreview("read", new JsonObject { ["filePath"] = "a.txt", ["startLine"] = 2, ["endLine"] = 4 }));
        Assert.Equal(200, SessionToolExecutor.ToolArgsPreview("exec", new JsonObject { ["command"] = new string('x', 1000) }).Length);
    }

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(string id, IReadOnlyList<JsonObject> history, CancellationToken token) => throw new NotSupportedException();
    }
}
