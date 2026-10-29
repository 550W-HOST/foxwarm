using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class RuntimePresentationTests
{
    [Fact]
    public async Task Processing_remains_visible_after_busy_commit_until_the_exact_owner_finishes()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        using var fixture = new ProviderFixture(temp.Path, store);
        var owner = fixture.Owner;
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var published = new ConcurrentQueue<JsonObject>();
        owner.Changed += value =>
        {
            if (value.Kind == SessionEventKind.StateChanged)
                published.Enqueue(owner.RuntimeSnapshot());
        };
        owner.Registry.OnProcessorFinalizing = async (_, _, _, _) =>
        {
            reached.TrySetResult();
            await release.Task;
        };
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("provider failure"));
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(owner.Entry.Snapshot().Busy);
            Assert.False((await store.LoadAsync(owner.Id))!.Busy);
            Assert.True(owner.RuntimeSnapshot()["processing"]!.GetValue<bool>());
            Assert.Equal("llm-failed", owner.RuntimeSnapshot()["state"]!.GetValue<string>());
            Assert.True(owner.BuildDto()["runtimeState"]!["processing"]!.GetValue<bool>());
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                owner.StartProcessing(retry: true)
            );
            Assert.True(owner.Processing);
        }
        finally
        {
            release.TrySetResult();
            await owner.DrainForegroundAsync();
        }
        Assert.False(owner.Processing);
        Assert.Null(owner.RuntimeSnapshot()["processing"]);
        Assert.Null(published.Last()["processing"]);
    }

    [Fact]
    public async Task Prior_owner_exit_keeps_a_queued_successors_processing_and_draft()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var firstFinalizing = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var releaseFirst = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var secondRequest = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var releaseSecond = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var attempts = 0;
        using var fixture = new ProviderFixture(
            temp.Path,
            store,
            () =>
            {
                if (Interlocked.Increment(ref attempts) != 2)
                    return;
                secondRequest.TrySetResult();
                releaseSecond.Task.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            },
            journal: true
        );
        var owner = fixture.Owner;
        var finalizations = 0;
        owner.Registry.OnProcessorFinalizing = async (_, _, _, _) =>
        {
            // Main performs draft cleanup here, before releasing the processor claim.
            owner.ClearDraft();
            if (Interlocked.Increment(ref finalizations) == 1)
            {
                firstFinalizing.TrySetResult();
                await releaseFirst.Task;
            }
        };
        var published = new ConcurrentQueue<JsonObject>();
        owner.Changed += value =>
        {
            if (value.Kind == SessionEventKind.StateChanged)
                published.Enqueue(owner.RuntimeSnapshot());
        };
        Task? first = null;
        owner.Registry.TriggerOverride = _ => first = owner.StartProcessing();
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("first"));
        try
        {
            await firstFinalizing.Task.WaitAsync(TimeSpan.FromSeconds(5));
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.UserText("queued successor")
            );
            Task? successor = null;
            owner.Registry.TriggerOverride = _ =>
            {
                successor = owner.StartProcessing();
                secondRequest.Task.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
                return successor;
            };
            releaseFirst.TrySetResult();
            await secondRequest.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await first!.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(published.Last()["processing"]!.GetValue<bool>());
            Assert.True(owner.RuntimeSnapshot()["processing"]!.GetValue<bool>());
            Assert.True(owner.Entry.Snapshot().Busy);
            Assert.NotEmpty(owner.DraftSnapshot());
            Assert.NotNull(successor);
        }
        finally
        {
            releaseFirst.TrySetResult();
            releaseSecond.TrySetResult();
            await owner.DrainForegroundAsync();
        }
        Assert.Equal(2, fixture.Attempts);
        Assert.Null(owner.RuntimeSnapshot()["processing"]);
    }
}
