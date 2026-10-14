using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Over_limit_tools_and_provider_time_queue_wait_for_planner_and_owner_commit(bool queued)
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        fixture.Peer.NextUsage = 21000;
        fixture.Peer.NextTool = !queued;
        if (queued)
        {
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("hold foreground"));
            await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("provider-time input"));
            fixture.Peer.ReleaseForeground();
        }
        else
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("tool continuation"));
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.ContinuationReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(fixture.Continuation!.IsCompleted);
        Assert.Equal(8, fixture.Peer.NormalRequests);
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        if (queued)
            Assert.Contains(fixture.Owner.History(), row => row["parts"]!.ToJsonString().Contains("provider-time input"));
        else
        {
            Assert.Equal(1, fixture.ToolExecutor.Invocations);
            Assert.Contains(fixture.Owner.History(), row => row["parts"]!.ToJsonString().Contains("completed tool"));
        }
        fixture.Peer.ReleasePlan();
        await fixture.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(9, fixture.Peer.NormalRequests);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Contains("Prior context.", fixture.Peer.NormalBodies[^1]);
        Assert.NotEmpty(fixture.Store.Archive.ReadEffectiveBlocksRange(1, long.MaxValue));
    }

    [Fact]
    public async Task Threshold_only_tool_continuation_does_not_wait_for_independent_background_planning()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        fixture.Peer.NextUsage = 18000;
        fixture.Peer.NextTool = true;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("tool continuation"));
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Peer.NextNormalReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(9, fixture.Peer.NormalRequests);
        Assert.True(fixture.Owner.Compactor.Active);
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task Stop_releases_over_limit_continuation_without_cancelling_planning(bool runQueued, bool beforeWait)
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        // An already independent planner remains held throughout Stop and turn release.
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldBeforeContinuation = beforeWait;
        fixture.Peer.NextUsage = 21000;
        fixture.Peer.NextTool = true;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("tool continuation"));
        await fixture.ContinuationReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (runQueued)
        {
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("run queued input"));
            await fixture.Owner.Registry.Control.DequeueAsync("s");
        }
        else
            await fixture.Owner.Registry.Control.StopAsync("s");
        fixture.ContinuationRelease.TrySetResult();
        await fixture.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(runQueued ? 9 : 8, fixture.Peer.NormalRequests);
        Assert.True(fixture.Owner.Compactor.Active);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Equal(1, fixture.ToolExecutor.Invocations);
        Assert.Contains(fixture.Owner.History(), row => row["parts"]!.ToJsonString().Contains("completed tool"));
        if (runQueued)
            Assert.Contains("run queued input", fixture.Peer.NormalBodies[^1]);
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
    }

    [Fact]
    public async Task Ready_safe_point_commit_consumes_old_usage_without_another_planner_round()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldBeforeContinuation = true;
        fixture.Peer.NextUsage = 21000;
        fixture.Peer.NextTool = true;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("tool continuation"));
        await fixture.ContinuationReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldSignal = true;
        fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.StageRelease.Set();
        fixture.ContinuationRelease.TrySetResult();
        await fixture.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(9, fixture.Peer.NormalRequests);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Contains("Prior context.", fixture.Peer.NormalBodies[^1]);
    }

    [Fact]
    public async Task Failed_ready_authority_apply_ends_over_limit_turn_before_another_provider_request()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        fixture.Peer.NextUsage = 21000;
        fixture.Peer.NextTool = true;
        await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("tool continuation"));
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldStage = AtomicJsonWriteStage.BeforeRename;
        fixture.FailHeldStage = true;
        fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.StageRelease.Set();
        await fixture.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(8, fixture.Peer.NormalRequests);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Equal(1, fixture.ToolExecutor.Invocations);
        Assert.Contains(fixture.Owner.History(), row => row["parts"]!.ToJsonString().Contains("completed tool"));
        Assert.Empty(fixture.Store.Archive.ReadEffectiveBlocksRange(1, long.MaxValue));
        Assert.IsType<ModelPreparationException>(fixture.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failed_pending_or_already_ready_over_limit_plan_ends_turn_and_retains_admitted_input(bool alreadyReady)
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        fixture.Peer.FailPlan = true;
        fixture.Peer.NextUsage = 21000;
        if (alreadyReady)
        {
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("hold foreground"));
            await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await fixture.Owner.Compactor.StartManualAsync();
            await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            fixture.HoldSignal = true;
            fixture.Peer.ReleasePlan();
            await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var ingress = fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("retained admitted input"));
            fixture.StageRelease.Set();
            await ingress;
            fixture.Peer.ReleaseForeground();
        }
        else
        {
            fixture.Peer.NextTool = true;
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("tool continuation"));
            await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("retained admitted input"));
            fixture.Peer.ReleasePlan();
        }
        await fixture.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(8, fixture.Peer.NormalRequests);
        Assert.Equal(1, fixture.Peer.PlannerRequests);
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        var snapshot = fixture.Owner.Entry.Snapshot();
        Assert.True(snapshot.Queue.Any(item => item.Parts?.Any(part => part.ToJsonString().Contains("retained admitted input")) == true)
            || snapshot.History.Any(row => row["parts"]!.ToJsonString().Contains("retained admitted input")));
        Assert.IsType<ModelPreparationException>(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        if (!alreadyReady)
        {
            Assert.Equal(1, fixture.ToolExecutor.Invocations);
            Assert.Contains(snapshot.History, row => row["parts"]!.ToJsonString().Contains("completed tool"));
        }
    }
}
