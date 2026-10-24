using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LlmFailureStateTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static HttpResponseMessage Failure(HttpStatusCode status = HttpStatusCode.BadRequest) =>
        new(status) { Content = new StringContent("{\"error\":{\"message\":\"owned provider rejection\"}}") };

    private static HttpResponseMessage Success() => new(HttpStatusCode.OK)
    {
        Content = new StringContent(
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n",
            Encoding.UTF8,
            "text/event-stream"
        ),
    };

    private static string State(SessionOwner owner) => owner.RuntimeSnapshot()["state"]!.GetValue<string>();

    [Theory]
    [InlineData(1)]
    [InlineData(6)]
    public async Task Real_terminal_failure_settles_only_after_the_retry_callback_and_survives_reopen(int attempts)
    {
        using var fixture = new Provider(_ => Failure(attempts == 1 ? HttpStatusCode.BadRequest : HttpStatusCode.ServiceUnavailable));
        var owner = fixture.Owner;
        var terminal = Signal();
        var release = Signal();
        var originalFailure = owner.Registry.OnTurnFailure!;
        owner.Registry.OnTurnFailure = async (error, durable) =>
        {
            Assert.IsType<ModelRequestException>(error);
            Assert.Equal("requesting-model", State(owner));
            Assert.Null(owner.Entry.Snapshot().Meta["llmFailed"]);
            terminal.TrySetResult();
            await release.Task;
            await originalFailure(error, durable);
        };
        await fixture.Enqueue("fail");
        var running = fixture.Run();
        try
        {
            await terminal.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(owner.Entry.Snapshot().Busy);
            Assert.True(owner.RuntimeSnapshot()["retry"]!["final"]!.GetValue<bool>());
            Assert.Equal(attempts, fixture.Attempts);
            Assert.Equal(attempts - 1, fixture.Delays.Count);
        }
        finally
        {
            release.TrySetResult();
            await running;
        }
        Assert.Equal("llm-failed", State(owner));
        Assert.False(owner.Metadata().Busy);
        Assert.True(owner.Metadata().LlmFailed);
        Assert.Null(owner.RuntimeSnapshot()["retry"]);
        Assert.Equal("llm-failed", WebUiContract.Session(owner.Entry.Snapshot(), fixture.Models, false, false)["runtimeState"]!["state"]!.GetValue<string>());
        var reopened = (await fixture.Store.LoadAsync("s"))!;
        Assert.False(reopened.Busy);
        Assert.True(reopened.Meta["llmFailed"]!.GetValue<bool>());
        Assert.Equal(1, reopened.History.Count(row => row.Data.GetProperty("__meta").TryGetProperty("noticeType", out var type) && type.GetString() == "llm-retry"));
    }

    [Fact]
    public async Task Retry_then_success_is_running_during_backoff_and_does_not_record_failure()
    {
        using var fixture = new Provider(attempt => attempt == 1 ? Failure(HttpStatusCode.ServiceUnavailable) : Success());
        fixture.OnDelay = () =>
        {
            Assert.Equal("requesting-model", State(fixture.Owner));
            Assert.Null(fixture.Owner.Entry.Snapshot().Meta["llmFailed"]);
            Assert.Null(fixture.Owner.RuntimeSnapshot()["retry"]!["final"]);
            return Task.CompletedTask;
        };
        await fixture.Enqueue("recover");
        await fixture.Run();
        Assert.Equal(2, fixture.Attempts);
        Assert.Equal("idle", State(fixture.Owner));
        Assert.Null((await fixture.Store.LoadAsync("s"))!.Meta["llmFailed"]);
    }

    [Fact]
    public async Task Required_compact_failure_from_a_normal_retry_safe_point_keeps_its_request_origin()
    {
        using var fixture = new Provider(attempt => Failure(attempt == 1 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.BadRequest));
        fixture.Owner.Registry.OnRetrySafePoint = async _ => await fixture.Request(ModelRequestScope.CompactPlan);
        await fixture.Enqueue("normal request requires compact preparation");
        await fixture.Run();
        var error = Assert.IsType<ModelRequestException>(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(ModelRequestScope.CompactPlan, error.Scope);
        Assert.Equal(2, fixture.Attempts);
        Assert.Equal("idle", State(fixture.Owner));
        Assert.Null((await fixture.Store.LoadAsync("s"))!.Meta["llmFailed"]);
    }

    [Fact]
    public async Task Preparation_infrastructure_and_independent_request_failures_do_not_replace_the_foreground_outcome()
    {
        using var fixture = new Provider(_ => Failure());
        await fixture.Enqueue("fail normally");
        await fixture.Run();
        Assert.Equal("llm-failed", State(fixture.Owner));
        foreach (var scope in new[] { ModelRequestScope.Btw, ModelRequestScope.CompactPlan, ModelRequestScope.BackgroundCompactPlan, ModelRequestScope.LowLevel })
        {
            var error = await Assert.ThrowsAsync<ModelRequestException>(() => fixture.Request(scope));
            Assert.Equal(scope, error.Scope);
            Assert.Equal("llm-failed", State(fixture.Owner));
        }
        fixture.Owner.Registry.OnTurnStarting = _ => throw new ModelPreparationException("local prompt unavailable");
        await fixture.Enqueue("new run");
        await Assert.ThrowsAsync<ModelPreparationException>(() => fixture.Run());
        Assert.Equal("idle", State(fixture.Owner));
        fixture.Owner.Registry.OnTurnStarting = _ => throw new HttpRequestException("local embedding unavailable");
        await fixture.Enqueue("local infrastructure");
        await Assert.ThrowsAsync<HttpRequestException>(() => fixture.Run());
        Assert.Equal("idle", State(fixture.Owner));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Release_failure_preserves_precommit_or_committed_authority_truth(bool committed)
    {
        var fault = false;
        using var fixture = new Provider(_ => Failure(), (stage, root) =>
        {
            if (!fault || stage != (committed ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename))
                return;
            var source = committed
                ? Path.Combine(root, "state", "sessions", "s.json")
                : Directory.GetFiles(Path.Combine(root, "state", "sessions"), "s.json.tmp-*").Single();
            var snapshot = JsonNode.Parse(File.ReadAllText(source))!;
            if (snapshot["busy"]!.GetValue<bool>())
                return;
            throw new IOException("owned busy-release fault");
        });
        await fixture.Enqueue("fail");
        fixture.Owner.Registry.OnTurnFailure = (_, _) =>
        {
            fault = true;
            return Task.CompletedTask;
        };
        if (committed)
            await Assert.ThrowsAsync<AuthorityCommittedException>(() => fixture.Run());
        else
            await Assert.ThrowsAsync<IOException>(() => fixture.Run());
        Assert.Equal(committed ? "llm-failed" : "requesting-model", State(fixture.Owner));
        var stored = (await fixture.Store.LoadAsync("s"))!;
        Assert.Equal(!committed, stored.Busy);
        Assert.Equal(committed, stored.Meta["llmFailed"]?.GetValue<bool>() == true);
        Assert.Equal(committed, fixture.Owner.Entry.Snapshot().Meta["llmFailed"]?.GetValue<bool>() == true);
    }

    [Fact]
    public async Task Accepted_triggering_input_runs_after_failure_and_clears_it_before_the_next_attempt()
    {
        using var fixture = new Provider(attempt => attempt == 1 ? Failure() : Success());
        var held = Signal();
        var release = Signal();
        fixture.BeforeResponse = async attempt =>
        {
            if (attempt == 1)
            {
                held.TrySetResult();
                await release.Task;
            }
            else
            {
                Assert.Equal("requesting-model", State(fixture.Owner));
                Assert.Null(fixture.Owner.Entry.Snapshot().Meta["llmFailed"]);
            }
        };
        fixture.Owner.Registry.TriggerOverride = _ => fixture.Owner.StartProcessing();
        await fixture.Enqueue("first");
        try
        {
            await held.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await fixture.Enqueue("second");
        }
        finally
        {
            release.TrySetResult();
            await fixture.Owner.DrainForegroundAsync();
        }
        Assert.Equal(2, fixture.Attempts);
        Assert.Equal("idle", State(fixture.Owner));
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Single(fixture.Owner.History(), row => row["__meta"]?["clientMessageId"]?.GetValue<string>() == "second");
    }

    [Fact]
    public async Task Failed_retry_notice_save_does_not_prevent_a_successful_terminal_release()
    {
        using var fixture = new Provider(_ => Failure(), (stage, root) =>
        {
            if (stage != AtomicJsonWriteStage.BeforeRename)
                return;
            var pending = Directory.GetFiles(Path.Combine(root, "state", "sessions"), "s.json.tmp-*").Single();
            var snapshot = JsonNode.Parse(File.ReadAllText(pending))!;
            if (snapshot["busy"]!.GetValue<bool>()
                && snapshot["history"]!.AsArray().LastOrDefault()?["__meta"]?["noticeType"]?.GetValue<string>() == "llm-retry")
                throw new IOException("owned retry-notice fault");
        });
        await fixture.Enqueue("fail");
        await fixture.Run();
        Assert.Equal("llm-failed", State(fixture.Owner));
        var stored = (await fixture.Store.LoadAsync("s"))!;
        Assert.True(stored.Meta["llmFailed"]!.GetValue<bool>());
        Assert.False(stored.Busy);
        Assert.Equal("user", Assert.Single(stored.History).Role);
        Assert.Single(fixture.Store.Archive.ReadMessages());
    }

    [Fact]
    public async Task A_paired_tool_error_followed_by_a_successful_request_ends_normally()
    {
        using var fixture = new Provider(attempt => attempt == 1
            ? new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"call_id\":\"one\",\"name\":\"unknown_tool\",\"arguments\":\"{}\"}]}}\n\n",
                    Encoding.UTF8,
                    "text/event-stream"
                ),
            }
            : Success());
        await fixture.Enqueue("tool error");
        await fixture.Run();
        Assert.Equal(2, fixture.Attempts);
        Assert.Contains(fixture.Owner.History(), row => row["role"]?.GetValue<string>() == "tool"
            && row.ToJsonString().Contains("unknown_tool"));
        Assert.Equal("idle", State(fixture.Owner));
        Assert.Null(fixture.Owner.Entry.Snapshot().Meta["llmFailed"]);
    }

    private sealed class Peer(Provider fixture) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var attempt = ++fixture.Attempts;
            if (fixture.BeforeResponse is not null)
                await fixture.BeforeResponse(attempt);
            token.ThrowIfCancellationRequested();
            return fixture.response(attempt);
        }
    }

    private sealed class Provider : IDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly HttpClient http;
        internal readonly Func<int, HttpResponseMessage> response;
        internal readonly SessionOwner Owner;
        internal readonly PersistentSessionAuthorityStore Store;
        internal readonly HostModels Models;
        private readonly ResponsesClientOptions options;
        internal readonly ModelRequestOwner Requests;
        internal int Attempts;
        internal readonly List<int> Delays = [];
        internal Func<Task>? OnDelay;
        internal Func<int, Task>? BeforeResponse;

        internal Provider(Func<int, HttpResponseMessage> response, Action<AtomicJsonWriteStage, string>? stage = null)
        {
            this.response = response;
            Store = new PersistentSessionAuthorityStore(temp.Path, "s", authorityStageHook: value => stage?.Invoke(value, temp.Path));
            options = new(new Uri("http://localhost"), "wire", "a/wire", "", "", 50);
            Models = HostModels.ForTest(options);
            Owner = new SessionOwner("s", "main", Models) { Archive = Store.Archive };
            http = new HttpClient(new Peer(this));
            Requests = new ModelRequestOwner(http, options, new ModelRouting(), async (delay, _) =>
            {
                Delays.Add(delay);
                if (OnDelay is not null)
                    await OnDelay();
            });
            var agents = new AgentCatalog(temp.Path, Path.Combine(temp.Path, "work"));
            var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills")));
            var chat = new SessionChatService(Requests, options, Owner, Models, memory, (_, _) => { });
            Owner.Registry = new SessionRegistry(Store, chat);
            Owner.Registry.Add("s");
            Owner.EnableCommittedNotifications();
            Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            Owner.Registry.OnTurnFailure = (error, durable) => Owner.PresentFailureAsync(error, durable);
        }

        internal Task<ChatResult> Request(ModelRequestScope scope) => Requests.RequestAsync(
            "s", Models, Models.DefaultKey, null, "cache", "turn", [], (_, _) => Task.FromResult("instructions"),
            null, null, null, null, default, scope);

        internal Task Enqueue(string text) => Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText(text, clientMessageId: text));
        internal Task Run() => Owner.Registry.Runner.ProcessQueueAsync("s");
        public void Dispose()
        {
            http.Dispose();
            temp.Dispose();
        }
    }
}
