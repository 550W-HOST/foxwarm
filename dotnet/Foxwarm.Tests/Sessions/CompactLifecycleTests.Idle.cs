using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Idle_timer_uses_provider_request_start_and_commits_through_the_real_compactor(bool background)
    {
        var clock = new IdleClock();
        await using var fixture = await IdleFixture(clock, background);
        var owner = fixture.Owner;
        var anchor = LastProviderStart(owner);
        Assert.Equal(anchor.AddMinutes(55), clock.PendingDue);
        // Session message/activity timestamps do not move the provider-cache deadline.
        owner.Entry.WithState(state => state.Meta["lastMessageTime"] = anchor.AddMinutes(45).ToUnixTimeMilliseconds());
        clock.AdvanceTo(anchor.AddMinutes(54));
        Assert.Equal(0, fixture.Peer.PlannerRequests);
        clock.AdvanceTo(anchor.AddMinutes(55));
        await owner.Compactor.DrainIdleAsync().WaitAsync(TimeSpan.FromSeconds(8));
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(8));
        Assert.Equal(background ? false : true, owner.Entry.WithState(state => state.Busy));
        fixture.Peer.ReleasePlan();
        await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(8));
        Assert.Single(fixture.Store.Archive.ReadBlocks());
        Assert.Equal(1, owner.Entry.Snapshot().HistoryVersion);
        Assert.Contains(owner.Entry.Snapshot().History, row => row.ToJson()["compaction"] is not null);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Null(clock.PendingDue);
        // A later idle release cannot compact again from the old provider measurement.
        owner.Entry.ReleaseProcessor();
        clock.AdvanceTo(anchor.AddHours(3));
        await owner.Compactor.DrainIdleAsync();
        Assert.Equal(1, fixture.Peer.PlannerRequests);
    }

    [Fact]
    public async Task Idle_timer_cancels_on_input_and_rearms_from_the_next_request_start()
    {
        var clock = new IdleClock();
        await using var fixture = await IdleFixture(clock);
        var previous = clock.LastTimer!;
        var anchor = LastProviderStart(fixture.Owner);
        clock.AdvanceTo(anchor.AddMinutes(20));
        fixture.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("next input"));
        Assert.True(previous.Disposed);
        Assert.Null(clock.PendingDue);
        previous.Fire();
        Assert.Equal(0, fixture.Peer.PlannerRequests);
        fixture.Peer.NextUsage = 12000;
        await fixture.Owner.StartProcessing();
        var nextAnchor = LastProviderStart(fixture.Owner);
        Assert.True(nextAnchor > anchor);
        Assert.Equal(nextAnchor.AddMinutes(55), clock.PendingDue);
    }

    [Theory]
    [InlineData("busy")]
    [InlineData("stopping")]
    [InlineData("ordinary-input")]
    [InlineData("processor")]
    [InlineData("history-mutation")]
    [InlineData("claude-code")]
    [InlineData("different-model")]
    [InlineData("equal-ratio")]
    [InlineData("lower-ratio")]
    [InlineData("disabled")]
    [InlineData("retired")]
    [InlineData("shutdown")]
    public async Task Idle_timer_rechecks_current_owner_eligibility_before_admission(string condition)
    {
        var clock = new IdleClock();
        await using var fixture = await IdleFixture(clock);
        var owner = fixture.Owner;
        var deadline = clock.PendingDue!.Value;
        owner.Entry.WithState(state =>
        {
            switch (condition)
            {
                case "busy": state.Busy = true; break;
                case "stopping": state.Stopping = true; break;
                case "ordinary-input": state.Queue.Add(QueueItem.UserText("queued")); break;
                case "processor": Assert.True(owner.Entry.TryClaimProcessor()); break;
                case "history-mutation": Assert.True(owner.Entry.TryBeginHistoryMutation(out _, out _)); break;
                case "claude-code": state.AuthorityEnvelope["runtime"] = "claude-code"; break;
                case "different-model": state.AuthorityEnvelope["model"] = "b"; break;
                case "equal-ratio": SetLastUsage(state, 10000); break;
                case "lower-ratio": SetLastUsage(state, 9999); break;
                case "disabled": fixture.Models.Resolve("a").Configuration["idleCompactMinutes"] = 0; break;
                case "retired": owner.Entry.Retired = true; break;
                case "shutdown": owner.Registry.Runner.CloseAdmission(); break;
            }
        });
        clock.AdvanceTo(deadline);
        await owner.Compactor.DrainIdleAsync().WaitAsync(TimeSpan.FromSeconds(8));
        Assert.Equal(0, fixture.Peer.PlannerRequests);
        Assert.False(owner.Compactor.Active);
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
        // Restore only the fixture's synthetic skip state for its ordinary disposal.
        owner.Entry.WithState(state =>
        {
            state.Busy = state.Stopping = false;
            state.Queue.Clear();
            state.AuthorityEnvelope.Remove("runtime");
        });
        if (condition == "history-mutation")
            owner.Entry.EndHistoryMutation(true);
        if (condition == "processor")
            owner.Entry.ReleaseProcessor();
    }

    [Fact]
    public async Task Idle_timer_rechecks_a_longer_configuration_delay_and_later_disablement()
    {
        var clock = new IdleClock();
        await using var fixture = await IdleFixture(clock);
        var original = clock.PendingDue!.Value;
        fixture.Models.Resolve("a").Configuration["idleCompactMinutes"] = 70;
        clock.AdvanceTo(original);
        await fixture.Owner.Compactor.DrainIdleAsync();
        Assert.Equal(original.AddMinutes(15), clock.PendingDue);
        fixture.Models.Resolve("a").Configuration["idleCompactMinutes"] = 0;
        clock.AdvanceTo(original.AddMinutes(15));
        await fixture.Owner.Compactor.DrainIdleAsync();
        Assert.Null(clock.PendingDue);
        Assert.Equal(0, fixture.Peer.PlannerRequests);
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("retire")]
    [InlineData("dispose")]
    public async Task Idle_schedule_is_cancelled_at_owner_lifecycle_boundaries(string boundary)
    {
        var clock = new IdleClock();
        await using var fixture = await IdleFixture(clock);
        var timer = clock.LastTimer!;
        if (boundary == "clear")
        {
            await fixture.Owner.Entry.SaveLane.ClearHistoryAsync([], () => 0);
            fixture.Owner.Entry.ReleaseProcessor();
        }
        else if (boundary == "retire")
            fixture.Owner.Entry.Retired = true;
        else
            fixture.Owner.Compactor.StopIdleScheduling();
        Assert.True(timer.Disposed);
        Assert.Null(clock.PendingDue);
        timer.Fire();
        await fixture.Owner.Compactor.DrainIdleAsync();
        Assert.Equal(0, fixture.Peer.PlannerRequests);
    }

    [Fact]
    public async Task Lazy_owner_does_not_arm_and_active_compaction_cancels_the_idle_timer()
    {
        var clock = new IdleClock();
        await using var fixture = await CompactFixture.CreateAsync(idleClock: clock, idleMinutes: 55);
        Assert.Null(clock.PendingDue);
        await fixture.SeedAsync();
        fixture.Peer.NextUsage = 12000;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("measure"));
        await fixture.Owner.DrainForegroundAsync();
        var timer = clock.LastTimer!;
        Assert.NotNull(clock.PendingDue);
        Assert.True((await fixture.Owner.Compactor.StartManualAsync()).Started);
        Assert.True(timer.Disposed);
        timer.Fire();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(8));
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        await fixture.Owner.Compactor.StopAsync();
    }

    [Fact]
    public async Task A_small_context_and_an_absent_request_measurement_do_not_arm_idle_work()
    {
        var clock = new IdleClock();
        await using var fixture = await CompactFixture.CreateAsync(idleClock: clock, idleMinutes: 55);
        await fixture.SeedAsync();
        Assert.Null(clock.PendingDue);
        fixture.Peer.NextUsage = 9000;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("below idle fraction"));
        await fixture.Owner.DrainForegroundAsync();
        Assert.Null(clock.PendingDue);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task Idle_compaction_prunes_large_tool_responses_before_starting_a_planner(
        bool background,
        bool committedFault
    )
    {
        var clock = new IdleClock();
        await using var fixture = await CompactFixture.CreateAsync(background, idleClock: clock, idleMinutes: 55);
        var owner = fixture.Owner;
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        foreach (var row in new[]
        {
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "large-read",
                        ["name"] = "read",
                        ["args"] = new JsonObject { ["filePath"] = "fixture" },
                    },
                }),
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "large-read",
                        ["name"] = "read",
                        ["response"] = new JsonObject { ["output"] = new string('x', 100000) },
                    },
                }),
            },
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "recent tail" }),
            },
        })
        {
            await owner.Registry.Ingress.EnqueueAsync("s", QueueItem.Prebuilt(row));
            await owner.Registry.HostFor("s").AppendQueuedInputsAsync(
                owner.Entry.WithState(state => state.Queue.ToArray())
            );
        }
        owner.Registry.TriggerOverride = _ => owner.StartProcessing();
        fixture.Peer.NextUsage = 12000;
        await owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("measured turn"));
        await owner.DrainForegroundAsync();
        Assert.NotNull(clock.PendingDue);
        var claims = owner.Entry.ProcessorClaimCount;
        var messages = owner.Entry.Snapshot().History.Count;
        if (committedFault)
        {
            fixture.FailHeldStage = true;
            fixture.HoldStage = AtomicJsonWriteStage.AfterRenameBeforeDirectorySync;
            fixture.StageRelease.Set();
        }
        clock.AdvanceTo(clock.PendingDue!.Value);
        await owner.Compactor.DrainIdleAsync().WaitAsync(TimeSpan.FromSeconds(8));
        await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(8));
        Assert.Equal(1, owner.Entry.Snapshot().HistoryVersion);
        Assert.Equal(claims + (background ? 0 : 1), owner.Entry.ProcessorClaimCount);
        Assert.Equal(messages, owner.Entry.Snapshot().History.Count);
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
        Assert.Equal(0, fixture.Peer.PlannerRequests);
        Assert.Contains("historical tool response pruned", owner.History()[1].ToJsonString());
        Assert.DoesNotContain(
            "historical tool response pruned",
            fixture.Store.Archive.ReadMessages()[1].Message.ToJsonString()
        );
        owner.Entry.ReleaseProcessor();
        Assert.Null(clock.PendingDue);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task New_input_during_idle_compaction_uses_the_existing_background_or_standalone_path(bool background)
    {
        var clock = new IdleClock();
        await using var fixture = await IdleFixture(clock, background);
        clock.AdvanceTo(clock.PendingDue!.Value);
        await fixture.Owner.Compactor.DrainIdleAsync().WaitAsync(TimeSpan.FromSeconds(8));
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(8));
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("arrived during idle compact"));
        if (background)
            await fixture.Owner.DrainForegroundAsync();
        else
            Assert.Single(fixture.Owner.Entry.Snapshot().Queue.Where(SessionCompactor.Ordinary));
        fixture.Peer.ReleasePlan();
        await fixture.Peer.NextNormalReached.Task.WaitAsync(TimeSpan.FromSeconds(8));
        await fixture.Owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(8));
        Assert.Single(fixture.Store.Archive.ReadBlocks());
        Assert.Contains(fixture.Owner.History(), row => row.ToJsonString().Contains("arrived during idle compact"));
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue.Where(SessionCompactor.Ordinary));
    }

    private static async Task<CompactFixture> IdleFixture(IdleClock clock, bool background = true)
    {
        var fixture = await CompactFixture.CreateAsync(background, idleClock: clock, idleMinutes: 55);
        await fixture.SeedAsync();
        fixture.Peer.NextUsage = 12000;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("last measured turn"));
        await fixture.Owner.DrainForegroundAsync();
        Assert.NotNull(clock.PendingDue);
        return fixture;
    }

    private static DateTimeOffset LastProviderStart(SessionOwner owner)
    {
        var row = owner.Entry.Snapshot().History.Last(row => row.Role == "model").ToJson();
        var start = row["__meta"]!["llmRequestTiming"]!["startedAt"]!.GetValue<double>();
        return DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Ceiling(start));
    }

    private static void SetLastUsage(SessionState state, double contextTokens)
    {
        var index = state.History.Count - 1;
        var row = state.History[index].ToJson();
        row["__meta"]!["usage"] = new JsonObject
        {
            ["contextTokens"] = contextTokens,
            ["inputTokens"] = 19000,
            ["cachedTokens"] = 19000,
        };
        state.History.Replace(index, HistoryMessage.FromJson(row));
    }

    private sealed class IdleClock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.FromUnixTimeMilliseconds(
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        );
        private readonly List<Timer> timers = [];
        internal Timer? LastTimer => timers.LastOrDefault();
        internal DateTimeOffset? PendingDue => timers.LastOrDefault(timer => !timer.Disposed)?.Due;
        public override DateTimeOffset GetUtcNow() => now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new Timer(this, callback, state);
            timers.Add(timer);
            timer.Change(dueTime, period);
            return timer;
        }
        internal void AdvanceTo(DateTimeOffset time)
        {
            now = time;
            foreach (var timer in timers.ToArray())
                if (!timer.Disposed && timer.Due <= now)
                {
                    timer.Due = null;
                    timer.Fire();
                }
        }
        internal sealed class Timer(IdleClock clock, TimerCallback callback, object? state) : ITimer
        {
            internal bool Disposed;
            internal DateTimeOffset? Due;
            internal void Fire() => callback(state);
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                Due = dueTime == Timeout.InfiniteTimeSpan ? null : clock.now + dueTime;
                return !Disposed;
            }
            public void Dispose() => Disposed = true;
            public ValueTask DisposeAsync() { Dispose(); return default; }
        }
    }
}
