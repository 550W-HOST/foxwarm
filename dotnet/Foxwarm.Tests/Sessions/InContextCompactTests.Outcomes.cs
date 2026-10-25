using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    [Fact]
    public async Task Cancelling_an_accepted_but_unpaired_plan_continues_without_claiming_application()
    {
        await using var fixture = await Fixture.CreateAsync(2, (f, index, request) =>
        {
            if (index == 0)
                return Task.FromResult(new JsonArray(Call("plan", "submit_compact_plan", Plan())));
            Assert.Contains("Completed middle detail.", request.ToJsonString());
            Assert.DoesNotContain("CTX-BLOCK", request.ToJsonString());
            return Task.FromResult(Final());
        });
        (bool Cancelled, bool TooLate) cancelled = default;
        fixture.Owner.Entry.BeforeCanonicalNotification = async () =>
        {
            if (fixture.Owner.Compactor.Phase == "awaiting-tool-response")
                cancelled = await fixture.Owner.Compactor.StopAsync();
        };
        await fixture.RunAsync();
        Assert.True(cancelled.Cancelled);
        Assert.False(cancelled.TooLate);
        Assert.True(fixture.ToolResponse("plan")["response"]!["accepted"]!.GetValue<bool>());
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Apply_authority_errors_keep_publication_truth_and_existing_continuation_rules(bool afterRename, bool overLimit)
    {
        await using var fixture = await Fixture.CreateAsync(overLimit ? 1 : 2, (f, index, request) =>
        {
            if (index == 0)
                return Task.FromResult(new JsonArray(Call("plan", "submit_compact_plan", Plan())));
            Assert.Equal(afterRename, request.ToJsonString().Contains("CTX-BLOCK"));
            return Task.FromResult(Final());
        });
        fixture.InputTokens = overLimit ? 21000 : 50;
        var armed = false;
        fixture.Owner.Entry.BeforeCanonicalNotification = () =>
        {
            if (fixture.Owner.Compactor.Phase == "awaiting-tool-response")
                armed = true;
            return Task.CompletedTask;
        };
        fixture.AuthorityHook = (id, stage) =>
        {
            if (id != fixture.Owner.Id || !armed || stage != (afterRename
                ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename))
                return;
            armed = false;
            throw new IOException("owned compact publication failure");
        };
        await fixture.RunAsync();
        Assert.Equal(afterRename ? 1 : 0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Equal(afterRename ? 1 : 0, fixture.Owner.Archive!.ReadBlocks().Count);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.True(fixture.Owner.Entry.BestEffortFailureCount > 0);
        if (overLimit)
            Assert.IsType<ModelPreparationException>(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        else
            Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.DoesNotContain(fixture.Owner.Archive.ReadMessages(), row => row.MessageJson.Contains("owned compact publication failure"));
        var saved = (await fixture.Owner.AuthorityStore.LoadAsync(fixture.Owner.Id))!;
        Assert.Equal(afterRename ? 1 : 0, saved.HistoryVersion);
        Assert.False(saved.Busy);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_compact_at_the_real_commit_boundary_cancels_before_rename_and_is_too_late_after_it(bool afterRename)
    {
        await using var fixture = await Fixture.CreateAsync(2, (f, index, _) => Task.FromResult(index == 0
            ? new JsonArray(Call("plan", "submit_compact_plan", Plan())) : Final()));
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        fixture.AuthorityHook = (id, stage) =>
        {
            if (id != fixture.Owner.Id || fixture.Owner.Compactor.Phase != "committing"
                || stage != (afterRename ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename))
                return;
            reached.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("owned cancellation barrier expired");
        };
        var foreground = fixture.RunAsync();
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var stop = fixture.Owner.Compactor.StopAsync();
            release.Set();
            var outcome = await stop.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(!afterRename, outcome.Cancelled);
            Assert.Equal(afterRename, outcome.TooLate);
            await foreground;
        }
        finally
        {
            release.Set();
        }
        Assert.Equal(afterRename ? 1 : 0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Fact]
    public async Task Failure_to_publish_the_real_tool_response_discards_the_unpaired_submission()
    {
        await using var fixture = await Fixture.CreateAsync(1, (f, _, _) =>
            Task.FromResult(new JsonArray(Call("plan", "submit_compact_plan", Plan()))));
        var failed = false;
        fixture.AuthorityHook = (id, stage) =>
        {
            if (!failed && id == fixture.Owner.Id && stage == AtomicJsonWriteStage.BeforeRename
                && fixture.Owner.Compactor.Phase == "awaiting-tool-response")
            {
                failed = true;
                throw new IOException("owned tool-response publication failure");
            }
        };
        await fixture.RunAsync();
        Assert.True(failed);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Empty(fixture.Owner.Archive!.ReadBlocks());
        Assert.DoesNotContain(fixture.Owner.Archive.ReadMessages(), row => row.MessageJson.Contains("\"accepted\":true"));
    }
}
