using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class RuntimePresentationTests
{
    [Fact]
    public async Task Completed_foreground_retry_does_not_reappear_during_next_input_preparation()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        using var fixture = new ProviderFixture(temp.Path, store);
        var owner = fixture.Owner;
        owner.SetCompactRuntime("independent", "planning", true, null);
        await owner.Entry.SaveLane.SaveStrictAsync();
        await owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("first request"));
        await owner.DrainForegroundAsync();
        Assert.IsType<ModelRequestException>(owner.Entry.LastBackgroundProcessorFailure);
        Assert.False(owner.Entry.Snapshot().Busy);
        Assert.Null(owner.RuntimeSnapshot()["retry"]);
        Assert.Equal(1, fixture.Attempts);

        var preparing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.Registry.OnTurnStarting = async _ =>
        {
            preparing.TrySetResult();
            await release.Task;
        };
        await owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("second request"));
        try
        {
            await preparing.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var runtime = owner.RuntimeSnapshot();
            Assert.True(runtime["busy"]!.GetValue<bool>());
            Assert.Equal("requesting-model", runtime["state"]!.GetValue<string>());
            Assert.Null(runtime["retry"]);
            Assert.Equal("unknown", runtime["active"]!["phase"]!.GetValue<string>());
            Assert.Equal("independent", runtime["compaction"]!["operationId"]!.GetValue<string>());
            Assert.Equal(1, fixture.Attempts);
        }
        finally
        {
            release.TrySetResult();
            await owner.DrainForegroundAsync();
        }
        Assert.Equal(2, fixture.Attempts);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.False(owner.Entry.Snapshot().Busy);
        Assert.NotNull(owner.RuntimeSnapshot()["compaction"]);
    }

    [Fact]
    public async Task Failed_terminal_retry_save_uses_temporary_model_fallback_but_still_attempts_busy_release()
    {
        using var temp = new TempDirectory();
        var failedWrites = new List<string>();
        var fault = false;
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: stage =>
            {
                if (stage != AtomicJsonWriteStage.BeforeRename || !fault)
                    return;
                var pending = Directory.GetFiles(Path.Combine(temp.Path, "state", "sessions"), "s.json.tmp-*").Single();
                var snapshot = JsonNode.Parse(File.ReadAllText(pending))!;
                var last = snapshot["history"]!.AsArray().LastOrDefault();
                failedWrites.Add(last?["__meta"]?["noticeType"]?.GetValue<string>() ?? "ordinary");
                throw new IOException("authority unavailable after terminal provider response");
            }
        );
        using var fixture = new ProviderFixture(temp.Path, store, () => fault = true);
        var owner = fixture.Owner;
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += events.Add;
        await owner.Entry.SaveLane.SaveStrictAsync();
        await owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("provider failure"));
        await owner.DrainForegroundAsync();

        Assert.Equal(new[] { "llm-retry", "ordinary" }, failedWrites);
        Assert.Equal(1, fixture.Attempts);
        Assert.Equal("user", Assert.Single(owner.History())["role"]!.GetValue<string>());
        Assert.Single(store.Archive.ReadMessages());
        Assert.True(owner.Entry.Snapshot().Busy);
        Assert.True((await store.LoadAsync("s"))!.Busy);
        Assert.True(owner.RuntimeSnapshot()["retry"]!["final"]!.GetValue<bool>());
        var notices = events.Where(item => item.Kind == SessionEventKind.MessageCommitted
            && item.Data?["__meta"]?["temporary"]?.GetValue<bool>() == true).ToArray();
        Assert.Equal(2, notices.Length);
        Assert.Contains("terminal provider rejection", notices[0].Data!["__meta"]!["sessionNotice"]!["details"]!.GetValue<string>());
        Assert.Contains("authority unavailable", notices[1].Data!["__meta"]!["sessionNotice"]!["details"]!.GetValue<string>());

        // A failed notice does not poison independent lifecycle or later safe ordinary notice saves.
        fault = false;
        await owner.Registry.HostFor("s").ReleaseBusyAsync();
        await owner.PresentFailureAsync(new InvalidOperationException("ordinary preparation failure"), true);
        Assert.False(owner.Entry.Snapshot().Busy);
        Assert.Equal(2, owner.History().Count);
        Assert.Null(owner.History()[1]["__meta"]!["temporary"]);
    }

    private static SessionOwner Owner(ISessionAuthorityStore store, string id = "s")
    {
        var models = HostModels.ForTest(
            new ResponsesClientOptions(new Uri("http://localhost"), "m", "a/m", "", "", 50)
        );
        var owner = new SessionOwner(id, "main", models)
        {
            Registry = new SessionRegistry(store, new NoChat()),
        };
        owner.Registry.Add(id);
        owner.EnableCommittedNotifications();
        return owner;
    }

    [Fact]
    public void Foreground_and_compact_cleanup_cannot_erase_successors_and_retry_clears_at_actual_attempt()
    {
        var owner = Owner(new InMemorySessionAuthorityStore());
        owner.Entry.WithState(state =>
        {
            state.Busy = true;
            state.BusyStartedAt = 10;
        });
        var oldTool = owner.BeginTool(
            new JsonObject
            {
                ["name"] = "exec",
                ["index"] = 0,
                ["total"] = 2,
            }
        );
        owner.SetCompactRuntime("old", "planning", true, null);
        var compactWait = owner.BeginCompactPhase();
        Assert.Equal("compaction", owner.RuntimeSnapshot()["active"]!["phase"]!.GetValue<string>());
        owner.BeginModelAttempt();
        owner.EndTool(oldTool);
        owner.EndCompactPhase(compactWait);
        Assert.Equal(
            "normal-turn",
            owner.RuntimeSnapshot()["active"]!["phase"]!.GetValue<string>()
        );
        owner.SetModelRetry(
            new ModelRetryEvent(1, 6, "http", new string('x', 2000), "a/m", null, DelayMs: 5000)
        );
        var retry = owner.RuntimeSnapshot()["retry"]!;
        Assert.Equal(2, retry["nextAttempt"]!.GetValue<int>());
        Assert.Equal(1024, retry["reason"]!.GetValue<string>().Length);
        Assert.True(
            retry["retryAt"]!.GetValue<long>() >= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        );
        owner.BeginModelAttempt();
        Assert.Null(owner.RuntimeSnapshot()["retry"]);
        owner.SetCompactRuntime("new", "ready", true, null);
        owner.ClearCompactRuntime("old");
        Assert.Equal(
            "new",
            owner.RuntimeSnapshot()["compaction"]!["operationId"]!.GetValue<string>()
        );
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
        Assert.Equal(
            row.ToJsonString(),
            (await store.LoadAsync("s"))!.History[0].ToJson().ToJsonString()
        );
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
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: stage =>
            {
                if (stage == AtomicJsonWriteStage.BeforeRename)
                {
                    attempts++;
                    throw new IOException("authority unavailable");
                }
            }
        );
        var owner = Owner(store);
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += events.Add;
        var error = await Assert.ThrowsAsync<IOException>(() =>
            owner.Entry.SaveLane.SaveStrictAsync()
        );
        await owner.PresentFailureAsync(
            new ModelPreparationException("could not prepare", error),
            true
        );
        Assert.Equal(1, attempts);
        Assert.Empty(owner.History());
        var notice = Assert
            .Single(events, item => item.Kind == SessionEventKind.MessageCommitted)
            .Data!;
        Assert.True(notice["__meta"]!["temporary"]!.GetValue<bool>());
        Assert.Equal("system-event", notice["__meta"]!["noticeType"]!.GetValue<string>());
        var retryOwner = Owner(new InMemorySessionAuthorityStore());
        var retry = new ModelRetryNotice(retryOwner);
        await retry.NotifyAsync(
            new ModelRetryEvent(6, 6, "http", "terminal", "a/m", null, Final: true)
        );
        await retryOwner.PresentFailureAsync(
            new InvalidOperationException("terminal wrapper"),
            true
        );
        Assert.Single(retryOwner.History());
        Assert.Equal(
            "llm-retry",
            retryOwner.History()[0]["__meta"]!["noticeType"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Argument_previews_follow_resolved_arguments_and_remain_bounded()
    {
        Assert.Equal(
            "printf actual",
            SessionToolExecutor.ToolArgsPreview(
                "exec",
                new JsonObject { ["command"] = "printf actual", ["timeout"] = 10 }
            )
        );
        Assert.Equal(
            "a.txt (lines 2-4)",
            SessionToolExecutor.ToolArgsPreview(
                "read",
                new JsonObject
                {
                    ["filePath"] = "a.txt",
                    ["startLine"] = 2,
                    ["endLine"] = 4,
                }
            )
        );
        Assert.Equal(
            200,
            SessionToolExecutor
                .ToolArgsPreview("exec", new JsonObject { ["command"] = new string('x', 1000) })
                .Length
        );
    }

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) => throw new NotSupportedException();
    }

    private sealed class ProviderFixture : IDisposable
    {
        private readonly HttpClient http;
        internal SessionOwner Owner { get; }
        internal int Attempts { get; private set; }

        internal ProviderFixture(string root, PersistentSessionAuthorityStore store, Action? onResponse = null)
        {
            var work = Path.Combine(root, "work");
            Directory.CreateDirectory(work);
            var options = new ResponsesClientOptions(new Uri("http://localhost"), "wire", "a/wire", "", "", 50);
            var models = HostModels.ForTest(options);
            Owner = new SessionOwner("s", "main", models) { Archive = store.Archive };
            var agents = new AgentCatalog(root, work);
            var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(root, "skills")));
            http = new HttpClient(new TerminalPeer(() =>
            {
                Attempts++;
                onResponse?.Invoke();
            }));
            var requests = new ModelRequestOwner(http, options, new ModelRouting());
            var chat = new SessionChatService(requests, options, Owner, models, memory, (_, _) => { });
            Owner.Registry = new SessionRegistry(store, chat);
            Owner.Registry.Add("s");
            Owner.EnableCommittedNotifications();
            Owner.Registry.OnTurnFailure = (error, durable) => Owner.PresentFailureAsync(error, durable);
            Owner.Registry.TriggerOverride = _ => Owner.StartProcessing();
        }

        public void Dispose() => http.Dispose();
    }

    private sealed class TerminalPeer(Action onResponse) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            onResponse();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent("{\"error\":{\"message\":\"terminal provider rejection\"}}"),
            });
        }
    }
}
