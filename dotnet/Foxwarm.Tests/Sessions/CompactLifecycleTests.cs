using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompactLifecycleTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Empty_background_or_awaited_operation_releases_without_provider_or_fake_input(bool background)
    {
        await using var fixture = await CompactFixture.CreateAsync(background);
        var admission = await fixture.Owner.Compactor.StartManualAsync(); Assert.True(admission.Started); Assert.Equal(background, admission.Background);
        await fixture.Owner.Compactor.DrainAsync(); await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(0, fixture.Peer.NormalRequests); Assert.False(fixture.Peer.PlanReached.Task.IsCompleted);
        Assert.False(fixture.Owner.Compactor.Active); Assert.False(fixture.Owner.Compacting); Assert.False(fixture.Owner.Entry.Snapshot().Busy);
        Assert.Empty(fixture.Owner.Entry.Snapshot().History); Assert.Empty(fixture.Owner.Entry.Snapshot().Queue); Assert.Empty(fixture.Store.Archive.ReadMessages());
    }

    [Fact]
    public async Task Failed_ready_planner_concludes_only_itself_and_preserves_followup_input()
    {
        await using var fixture = await CompactFixture.CreateAsync(); await fixture.SeedAsync();
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("hold foreground")); await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.FailPlan = true; await fixture.Owner.Compactor.StartManualAsync(); await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("ordinary after failed planner")); fixture.Peer.ReleasePlan();
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!fixture.Owner.Compactor.HasCompletedJob && DateTime.UtcNow < deadline) await Task.Delay(1);
        Assert.True(fixture.Owner.Compactor.HasCompletedJob); fixture.Peer.ReleaseForeground();
        await fixture.Owner.DrainForegroundAsync(); await fixture.Owner.Compactor.DrainAsync();
        Assert.Equal(9, fixture.Peer.NormalRequests); Assert.Empty(fixture.Store.Archive.ReadBlocks()); Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Contains(fixture.Owner.Entry.Snapshot().History, row => row["parts"]?[0]?["text"]?.GetValue<string>() == "ordinary after failed planner");
        Assert.Equal(0, fixture.Owner.Entry.BackgroundProcessorFailureCount); Assert.True(fixture.Owner.Entry.BestEffortFailureCount > 0);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Actual_background_owner_cancellation_at_authority_boundary_retains_only_committed_rows(bool postrename, bool failAfterRename)
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        var before = fixture.Owner.Entry.Snapshot(); var archive = fixture.Store.Archive.ReadMessages().Select(row => row.MessageJson).ToArray();
        fixture.HoldStage = postrename ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename;
        fixture.FailHeldStage = failAfterRename;
        var admission = await fixture.Owner.Compactor.StartManualAsync(); Assert.True(admission.Background);
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await File.WriteAllTextAsync(fixture.MemoryPath, "refreshed memory after planning admission");
        fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stop = fixture.Owner.Compactor.StopAsync(); Assert.False(stop.IsCompleted);
        fixture.StageRelease.Set(); var outcome = await stop.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(!postrename, outcome.Cancelled); Assert.Equal(postrename, outcome.TooLate);
        var live = fixture.Owner.Entry.Snapshot(); var stored = (await fixture.Store.LoadAsync("s"))!;
        Assert.False(fixture.Owner.Compactor.Active); Assert.Empty(live.Queue); Assert.False(live.Busy);
        Assert.Equal(live.History.Select(row => row.ToJsonString()), stored.History.Select(row => row.ToJsonString()));
        Assert.Equal(archive, fixture.Store.Archive.ReadMessages().Take(archive.Length).Select(row => row.MessageJson));
        if (postrename)
        {
            Assert.Single(fixture.Store.Archive.ReadBlocks()); Assert.Equal(archive.Length + 1, fixture.Store.Archive.ReadMessages().Count);
            Assert.Contains(live.History, row => row["__meta"]?["contextBlock"] is JsonObject);
            Assert.Contains("refreshed memory", SessionWait.Text(live.AuthorityEnvelope["persistentMemorySnapshot"]));
            Assert.Equal(before.HistoryVersion + 1, live.HistoryVersion);
        }
        else
        {
            Assert.Empty(fixture.Store.Archive.ReadBlocks()); Assert.Equal(archive.Length, fixture.Store.Archive.ReadMessages().Count);
            Assert.Equal(before.History.Select(row => row.ToJsonString()), live.History.Select(row => row.ToJsonString()));
            Assert.Equal(before.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString(), live.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString());
        }
        await fixture.Owner.Entry.SaveLane.SaveStrictAsync();
    }

    [Fact]
    public async Task Commit_refresh_uses_recorded_live_concrete_identity_not_the_new_planner_leaf()
    {
        await using var fixture = await CompactFixture.CreateAsync(); await fixture.SeedAsync();
        await fixture.Owner.UpdateModelAsync(new JsonObject { ["model"] = "b" });
        await File.WriteAllTextAsync(fixture.MemoryPath, "<foxwarm-if model-id=\"a/wire\">\nlive concrete memory\n</foxwarm-if>\n<foxwarm-if model-id=\"b/wire-b\">\nplanner concrete memory\n</foxwarm-if>\n");
        await fixture.Owner.Compactor.StartManualAsync(); await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("wire-b", fixture.Peer.PlanRequestModel); Assert.Contains("planner concrete memory", fixture.Peer.PlanInstructions); Assert.DoesNotContain("live concrete memory", fixture.Peer.PlanInstructions);
        fixture.Peer.ReleasePlan(); await fixture.Owner.Compactor.DrainAsync(); await fixture.Owner.DrainForegroundAsync();
        var memory = SessionWait.Text(fixture.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"])!;
        Assert.Equal("a/wire", ConditionalMemory.ReadCurrentModelSnapshotId(memory)); Assert.Contains("live concrete memory", memory); Assert.DoesNotContain("planner concrete memory", memory);
        Assert.Single(fixture.Store.Archive.ReadBlocks());
    }

    [Fact]
    public async Task Ready_during_held_producer_publication_cancellation_waits_for_exact_producer_and_preserves_ordinary_input()
    {
        await using var fixture = await CompactFixture.CreateAsync(); await fixture.SeedAsync();
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("hold foreground"));
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldSignal = true;
        await fixture.Owner.Compactor.StartManualAsync(); await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5)); fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(fixture.Owner.Compactor.HasCompletedJob); Assert.DoesNotContain(fixture.Owner.Entry.Snapshot().Queue, row => row.Type == QueueItemType.CompactCommit);
        var stop = fixture.Owner.Compactor.StopAsync(); Assert.False(stop.IsCompleted);
        fixture.StageRelease.Set(); Assert.True((await stop.WaitAsync(TimeSpan.FromSeconds(5))).Cancelled);
        Assert.False(fixture.Owner.Compactor.Active); Assert.DoesNotContain(fixture.Owner.Entry.Snapshot().Queue, row => row.Type == QueueItemType.CompactCommit);
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("ordinary after cancellation"));
        fixture.Peer.ReleaseForeground(); await fixture.Owner.DrainForegroundAsync();
        Assert.Contains(fixture.Owner.Entry.Snapshot().History, row => row["parts"]?[0]?["text"]?.GetValue<string>() == "ordinary after cancellation");
        Assert.Equal(0, fixture.Owner.Entry.BackgroundProcessorFailureCount);
    }

    [Fact]
    public async Task Applying_owner_survives_failed_signal_producer_until_postrename_cancellation_is_classified()
    {
        await using var fixture = await CompactFixture.CreateAsync(); await fixture.SeedAsync();
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("hold foreground"));
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldSignal = true; fixture.FailHeldStage = true; fixture.HoldApplyAfterSignal = true;
        await fixture.Owner.Compactor.StartManualAsync(); await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5)); fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var applying = fixture.Owner.Compactor.ApplyCompletedAsync(); fixture.StageRelease.Set();
        await fixture.ApplyReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(fixture.Owner.Compactor.Active);
        var stop = fixture.Owner.Compactor.StopAsync(); Assert.False(stop.IsCompleted);
        fixture.ApplyRelease.Set(); await applying.WaitAsync(TimeSpan.FromSeconds(5));
        var outcome = await stop.WaitAsync(TimeSpan.FromSeconds(5)); Assert.True(outcome.TooLate); Assert.False(outcome.Cancelled);
        Assert.Single(fixture.Store.Archive.ReadBlocks()); Assert.False(fixture.Owner.Compactor.Active);
        fixture.Peer.ReleaseForeground(); await fixture.Owner.DrainForegroundAsync();
    }

    [Fact]
    public async Task Wake_cleanup_is_operation_owned_across_clones_and_restart_stale_signal_preserves_declared_wait()
    {
        using var root = new TempDirectory(); var store = new PersistentSessionAuthorityStore(root.Path, "s");
        var registry = new SessionRegistry(store, new NoChat()) { TriggerOverride = _ => Task.CompletedTask }; var entry = registry.Add("s");
        await entry.SaveLane.StartWaitAsync(JsonNode.Parse("""{"id":"wait-one","startedAt":1,"waitForInput":true}""")!.AsObject());
        var first = new object(); var second = new object();
        await entry.SaveLane.PublishCompactWakeAsync(first, CancellationToken.None); await entry.SaveLane.PublishCompactWakeAsync(second, CancellationToken.None);
        Assert.Same(first, entry.Snapshot().Queue[0].CompactOwner); Assert.Same(second, entry.Snapshot().Queue[1].CompactOwner);
        await entry.SaveLane.RemoveCompactWakeAsync(first); Assert.Same(second, Assert.Single(entry.Snapshot().Queue).CompactOwner);
        var restarted = new SessionRegistry(store, new NoChat()) { TriggerOverride = _ => Task.CompletedTask };
        var loaded = await restarted.LoadOrAddAsync("s"); Assert.Null(Assert.Single(loaded.Snapshot().Queue).CompactOwner);
        await restarted.Runner.ProcessQueueAsync("s"); Assert.Empty(loaded.Snapshot().Queue);
        Assert.Equal("wait-one", SessionWait.Text(loaded.Snapshot().Meta["wait"]?["id"])); Assert.Empty(loaded.Snapshot().History); Assert.False(loaded.Snapshot().Busy);
    }

    [Fact]
    public async Task Cancelled_live_memory_refresh_precedes_compact_preparation_and_does_not_poison_save_lane()
    {
        using var root = new TempDirectory(); var store = new PersistentSessionAuthorityStore(root.Path, "s");
        var registry = new SessionRegistry(store, new NoChat()) { TriggerOverride = _ => Task.CompletedTask }; var entry = registry.Add("s");
        await entry.SaveLane.SaveStrictAsync(); await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("acknowledged"));
        using var cancellation = new CancellationTokenSource(); var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var prepared = 0;
        var operation = entry.SaveLane.CommitCompactionAsync(_ => { prepared++; throw new InvalidOperationException("not reached"); }, cancellation.Token,
            async (_, token) => { reached.TrySetResult(); await Task.Delay(Timeout.Infinite, token); return "not published"; });
        await reached.Task; cancellation.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.Equal(0, prepared); Assert.Empty(store.Archive.ReadBlocks()); Assert.Empty(store.Archive.ReadMessages());
        Assert.Single(entry.Snapshot().Queue); Assert.Single((await store.LoadAsync("s"))!.Queue); await entry.SaveLane.SaveStrictAsync();
    }

    [Fact]
    public void Awaited_phase_release_is_exact_lease_owned_and_wake_is_not_visible_input_count()
    {
        var models = HostModels.ForTest(new ResponsesClientOptions(new Uri("http://localhost"), "wire", "a/wire", "", "", 713));
        var owner = new SessionOwner("s", "main", models) { Registry = new SessionRegistry(new InMemorySessionAuthorityStore(), new NoChat()) }; var entry = owner.Registry.Add("s");
        var old = owner.BeginCompactPhase(); var current = owner.BeginCompactPhase(); owner.EndCompactPhase(old); Assert.True(owner.Compacting); owner.EndCompactPhase(current); Assert.False(owner.Compacting);
        entry.State.Queue.Add(new QueueItem(QueueItemType.CompactCommit)); entry.State.Queue.Add(QueueItem.UserText("ordinary"));
        Assert.Equal(1, owner.Metadata().QueueLength);
        var dto = Foxwarm.Channels.WebUi.WebUiContract.History(entry.Snapshot(), models, false, false, null, null, null);
        Assert.Equal(1, dto["queueLength"]!.GetValue<int>()); Assert.Single(dto["queuedMessages"]!.AsArray()); Assert.Equal(0, dto["queuedPreviewOmittedCount"]!.GetValue<int>());
    }

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken) => throw new InvalidOperationException("control-only work must not call provider");
    }

    private sealed class CompactFixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new(); private readonly HttpClient http;
        internal readonly CompactPeer Peer = new(); internal readonly TaskCompletionSource StageReached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly ManualResetEventSlim StageRelease = new(false); internal AtomicJsonWriteStage? HoldStage; internal bool HoldSignal, FailHeldStage;
        internal bool HoldApplyAfterSignal; internal readonly TaskCompletionSource ApplyReached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly ManualResetEventSlim ApplyRelease = new(false);
        internal readonly PersistentSessionAuthorityStore Store; internal readonly SessionOwner Owner; internal readonly string MemoryPath;
        private CompactFixture(bool background)
        {
            var data = Path.Combine(temp.Path, "data"); var work = Path.Combine(temp.Path, "work"); Directory.CreateDirectory(work);
            MemoryPath = Path.Combine(work, "memory", "MEMORY.md"); Directory.CreateDirectory(Path.GetDirectoryName(MemoryPath)!); File.WriteAllText(MemoryPath, "initial memory");
            var authorityPath = Path.Combine(data, "state", "sessions", "s.json");
            Store = new PersistentSessionAuthorityStore(data, "s", authorityStageHook: stage =>
            {
                if (HoldApplyAfterSignal && stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                    && JsonNode.Parse(File.ReadAllText(authorityPath))!["historyVersion"]?.GetValue<long>() == 1)
                {
                    HoldApplyAfterSignal = false; ApplyReached.TrySetResult();
                    if (!ApplyRelease.Wait(TimeSpan.FromSeconds(8))) throw new TimeoutException("private applying barrier expired");
                }
                if (stage != HoldStage && !(HoldSignal && stage == AtomicJsonWriteStage.BeforeRename)) return;
                var pending = stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync ? authorityPath
                    : Directory.GetFiles(Path.GetDirectoryName(authorityPath)!, "s.json.tmp-*").SingleOrDefault();
                if (pending is null) return; var document = JsonNode.Parse(File.ReadAllText(pending))!.AsObject();
                var matches = HoldSignal ? document["queue"]!.AsArray().Any(row => row?["type"]?.GetValue<string>() == "compact-commit") : document["historyVersion"]?.GetValue<long>() == 1;
                if (!matches) return; HoldStage = null; HoldSignal = false; StageReached.TrySetResult();
                if (!StageRelease.Wait(TimeSpan.FromSeconds(8))) throw new TimeoutException("private compact barrier expired");
                if (FailHeldStage) throw new IOException("private postrename fault");
            });
            http = new HttpClient(Peer) { Timeout = Timeout.InfiniteTimeSpan };
            var options = new ResponsesClientOptions(new Uri("http://localhost"), "wire", "a/wire", "", "", 713);
            var models = HostModels.Parse(JsonNode.Parse("""{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost","models":["wire"],"contextLimit":20000},"b":{"providerType":"openai-responses","baseUrl":"http://localhost","models":["wire-b"],"contextLimit":20000}}}""")!.AsObject(), new JsonObject());
            if (!background) models = HostModels.Parse(JsonNode.Parse("""{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost","models":["wire"],"contextLimit":20000,"asyncCompact":false}}}""")!.AsObject(), new JsonObject());
            var agents = new AgentCatalog(data, work); var skills = new Skills(agents, Path.Combine(temp.Path, "skills")); var memory = new AgentMemory(agents, skills);
            Owner = new SessionOwner("s", "main", models) { Archive = Store.Archive }; var requests = new ModelRequestOwner(http, options, new ModelRouting());
            var chat = new SessionChatService(requests, options, Owner, models, memory, (_, _) => { });
            Owner.Registry = new SessionRegistry(Store, chat); Owner.Registry.Add("s");
            Owner.Compactor = new SessionCompactor(Owner, Store, models, options, requests, memory);
            Owner.Registry.OnSafePoint = _ => Owner.Compactor.SafePointAsync(); Owner.Registry.HasCompletedCompact = _ => Owner.Compactor.HasCompletedJob;
            Owner.Registry.TriggerOverride = _ => Owner.StartProcessing();
        }
        internal static async Task<CompactFixture> CreateAsync(bool background = true) { var fixture = new CompactFixture(background); await fixture.Owner.Entry.SaveLane.SaveStrictAsync(); return fixture; }
        internal async Task SeedAsync() { for (var i = 0; i < 7; i++) { await Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("seed " + i + " " + new string('x', 5000))); await Owner.DrainForegroundAsync(); } }
        public async ValueTask DisposeAsync()
        {
            StageRelease.Set(); ApplyRelease.Set(); Peer.ReleaseForeground(); Peer.ReleasePlan();
            if (Owner.Compactor.Active) await Owner.Compactor.StopAsync(); await Owner.DrainAsync(); http.Dispose(); StageRelease.Dispose(); ApplyRelease.Dispose(); temp.Dispose();
        }
    }

    private sealed class CompactPeer : HttpMessageHandler
    {
        internal readonly TaskCompletionSource PlanReached = new(TaskCreationOptions.RunContinuationsAsynchronously), ForegroundReached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource plan = new(TaskCreationOptions.RunContinuationsAsynchronously), foreground = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string? PlanRequestModel, PlanInstructions;
        internal bool FailPlan; internal int NormalRequests;
        internal void ReleasePlan() => plan.TrySetResult(); internal void ReleaseForeground() => foreground.TrySetResult();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = await request.Content!.ReadAsStringAsync(cancellationToken); var owned = JsonNode.Parse(body)!.AsObject();
            var input = owned["input"]!.AsArray().OfType<JsonObject>().Where(row => SessionWait.Text(row["role"]) == "user")
                .SelectMany(row => row["content"]!.AsArray().OfType<JsonObject>()).Select(row => SessionWait.Text(row["text"]) ?? "").ToArray();
            JsonArray output;
            if (input.Any(text => text.Contains("COMPACTION STARTED:", StringComparison.Ordinal)))
            {
                PlanRequestModel = SessionWait.Text(owned["model"]); PlanInstructions = SessionWait.Text(owned["instructions"]);
                PlanReached.TrySetResult(); await plan.Task.WaitAsync(cancellationToken);
                if (FailPlan) return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("planner rejected") };
                var ranges = Regex.Matches(string.Join('\n', input), "^- M#(\\d+)(?:-#(\\d+))?\\s", RegexOptions.Multiline);
                var start = long.Parse(ranges[0].Groups[1].Value); var last = ranges[^1]; var end = long.Parse(last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value);
                var args = new JsonObject { ["replaceAsBlocks"] = new JsonArray(new JsonObject { ["level"] = 1, ["sourceKind"] = "message", ["sourceStart"] = start, ["sourceEnd"] = end, ["summary"] = "Prior context." }) };
                output = new JsonArray(new JsonObject { ["type"] = "function_call", ["id"] = "output-plan", ["call_id"] = "plan", ["name"] = "submit_compact_plan", ["arguments"] = args.ToJsonString() });
            }
            else
            {
                Interlocked.Increment(ref NormalRequests);
                if (input.LastOrDefault() == "hold foreground") { ForegroundReached.TrySetResult(); await foreground.Task.WaitAsync(cancellationToken); }
                output = new JsonArray(new JsonObject { ["type"] = "message", ["role"] = "assistant", ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = "answer" }) });
            }
            var payload = new JsonObject { ["type"] = "response.completed", ["response"] = new JsonObject { ["id"] = "response", ["status"] = "completed", ["output"] = output } };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: " + payload.ToJsonString() + "\n\n", Encoding.UTF8, "text/event-stream") };
        }
    }
}
