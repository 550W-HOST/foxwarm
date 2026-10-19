using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    private static async Task SeedManualPruningAsync(CompactFixture fixture)
    {
        fixture.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        JsonObject[] messages =
        [
            new() { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject
                { ["functionCall"] = new JsonObject { ["id"] = "prune", ["name"] = "read", ["args"] = new JsonObject { ["filePath"] = "sample" } } }) },
            new() { ["role"] = "tool", ["parts"] = new JsonArray(new JsonObject
                { ["functionResponse"] = new JsonObject { ["tool_use_id"] = "prune", ["name"] = "read", ["response"] = new JsonObject { ["output"] = new string('x', 5000) } } }) },
            new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = new string('a', 20000) }) },
            new() { ["role"] = "model", ["parts"] = new JsonArray(new JsonObject { ["text"] = "recent" }) },
        ];
        foreach (var row in messages)
            await fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.Prebuilt(row));
        await fixture.Owner.Registry.HostFor("s").AppendQueuedInputsAsync(fixture.Owner.Entry.WithState(state => state.Queue.ToArray()));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Manual_pruning_rechecks_real_save_lane_prefix_and_preserves_new_suffix(bool deletePrefix)
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await SeedManualPruningAsync(fixture);
        var before = fixture.Owner.Entry.Snapshot();
        fixture.HoldIngress = true;
        var ingress = Task.Run(() => fixture.Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText("ingress correction suffix")));
        try
        {
            await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var pending = fixture.Owner.Registry.HostFor("s").AppendQueuedInputsAsync(fixture.Owner.Entry.WithState(state => state.Queue.ToArray()));
            var deletion = deletePrefix ? fixture.Owner.Entry.SaveLane.DeleteMessagesAsync(1) : Task.FromResult((0, 0));
            var prune = fixture.Owner.Compactor.PruneToolsManuallyAsync();
            fixture.StageRelease.Set();
            await ingress; await pending; await deletion;
            var result = await prune;
            Assert.Equal(!deletePrefix, result.Committed);
            Assert.Equal(deletePrefix ? 0 : 1, result.ReplacedFunctionResponses);
            var live = fixture.Owner.Entry.Snapshot();
            Assert.Contains("ingress correction suffix", live.History.Last().ToJsonString());
            Assert.Equal(before.NextMessageSeq, live.History.Last().Sequence);
            Assert.Equal(5, fixture.Store.Archive.ReadMessages().Count);
            if (!deletePrefix)
            {
                Assert.Contains("historical tool response pruned", live.History[1].ToJsonString());
                Assert.True(result.EstimatedTokensAfter >= result.EstimatedTokensBefore * .6);
            }
            else Assert.DoesNotContain("historical tool response pruned", string.Join('\n', live.History.Select(row => row.ToJsonString())));
            Assert.Equal(0, fixture.Peer.PlannerRequests);
        }
        finally { fixture.StageRelease.Set(); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Manual_pruning_preserves_existing_compaction_pre_and_post_rename_truth(bool renamed)
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await SeedManualPruningAsync(fixture);
        var original = fixture.Owner.Entry.Snapshot();
        fixture.HoldStage = renamed ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename;
        fixture.FailHeldStage = true;
        var pruning = Task.Run(() => fixture.Owner.Compactor.PruneToolsManuallyAsync());
        try
        {
            await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            fixture.StageRelease.Set();
            await Assert.ThrowsAnyAsync<IOException>(() => pruning);
            var live = fixture.Owner.Entry.Snapshot();
            var loaded = await fixture.Store.LoadAsync("s");
            Assert.Equal(renamed ? 1 : 0, live.HistoryVersion);
            Assert.Equal(live.History.Select(row => row.ToJsonString()), loaded!.History.Select(row => row.ToJsonString()));
            Assert.Equal(renamed, live.History[1].ToJsonString().Contains("historical tool response pruned"));
            Assert.Equal(original.History.Select(row => row.ToJsonString()), fixture.Store.Archive.ReadMessages().Select(row => row.Message.ToJsonString()));
            Assert.Equal(0, fixture.Peer.PlannerRequests);
        }
        finally { fixture.StageRelease.Set(); }
    }

    [Fact]
    public async Task Delete_during_actual_background_compaction_planning_keeps_deleted_prefix_out_of_active_authority()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        var before = fixture.Owner.Entry.Snapshot();
        Assert.True((await fixture.Owner.Compactor.StartManualAsync()).Started);
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var deleted = await fixture.Owner.Entry.SaveLane.DeleteMessagesAsync(1);
        Assert.Equal(1, deleted.Deleted);
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
        await fixture.Owner.DrainForegroundAsync();
        Assert.DoesNotContain(fixture.Owner.Entry.Snapshot().History, row => row.Sequence == before.History[0].Sequence);
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
        Assert.Contains(fixture.Store.Archive.ReadMessages(), row => row.Seq == before.History[0].Sequence);
        Assert.True(fixture.Owner.Entry.Snapshot().HistoryVersion >= 1);
    }
}
