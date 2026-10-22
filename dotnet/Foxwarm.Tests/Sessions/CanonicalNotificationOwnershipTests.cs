using System.Collections.Concurrent;
using System.Text;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CanonicalNotificationOwnershipTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Settings_do_not_publish_queued_rows_and_a_delayed_notice_keeps_its_own_notification(
        bool delayNotice
    )
    {
        using var temp = new TempDirectory();
        var releaseProvider = Signal();
        await using var provider = new LoopbackResponsesServer(
            async (stream, _) =>
            {
                await releaseProvider.Task;
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
                    )
                );
            }
        );
        var options = new ResponsesClientOptions(
            provider.BaseUri,
            "wire",
            "local/wire",
            "synthetic",
            "",
            713
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateAsync();
        var runtime = new SessionRuntime(manager);
        var events = new ConcurrentQueue<SessionRuntimeEvent>();
        runtime.Changed += events.Enqueue;
        var reached = Signal();
        var release = Signal();
        var paused = 0;
        owner.Entry.BeforeCanonicalNotification = async () =>
        {
            if (Interlocked.Exchange(ref paused, 1) == 0)
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        Task notice = Task.CompletedTask;
        try
        {
            if (delayNotice)
                notice = owner.PresentFailureAsync(
                    new InvalidOperationException("ordinary notice"),
                    true
                );
            else
                await runtime.SubmitAndRunAsync(owner.Id, QueueItem.UserText("queued input"));
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (delayNotice)
            {
                await runtime.SubmitAndRunAsync(owner.Id, QueueItem.UserText("queued input"));
                await provider.Request.WaitAsync(TimeSpan.FromSeconds(10));
            }
            var settings = await new MessageRouter(runtime).HandleMessageAsync(
                new(owner.Id, "webui"),
                new("/verbose on", null)
            );
            Assert.Equal(200, settings.Status);
            if (!delayNotice)
                await owner.PresentFailureAsync(
                    new InvalidOperationException("ordinary notice"),
                    true
                );
            var singles = events
                .Where(value => value.Kind == SessionEventKind.MessageCommitted)
                .ToArray();
            Assert.DoesNotContain(singles, value => value.Data?["role"]?.ToString() == "user");
            Assert.Equal(delayNotice ? 0 : 1, singles.Length);
            release.TrySetResult();
            await notice;
            await provider.Request.WaitAsync(TimeSpan.FromSeconds(10));
            var batch = Assert.Single(
                events,
                value => value.Kind == SessionEventKind.QueueHistoryAppended
            );
            Assert.Single(batch.Data!.AsArray());
            var delivered = Assert.Single(
                events,
                value => value.Kind == SessionEventKind.MessageCommitted
            );
            Assert.Equal("system-event", delivered.Data!["__meta"]!["noticeType"]!.ToString());
            Assert.Equal(delayNotice ? 1 : 2, delivered.Data["__meta"]!["seq"]!.GetValue<long>());
            Assert.Equal(2, owner.History().Count);
            Assert.Equal(0, owner.Entry.PostCommitNotificationFailureCount);
        }
        finally
        {
            release.TrySetResult();
            releaseProvider.TrySetResult();
            await manager.ShutdownAsync();
        }
    }

    [Fact]
    public async Task Cold_admission_and_settings_do_not_replay_existing_canonical_history()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local/wire",
            "",
            "",
            713
        );
        await using (
            var seed = new SessionManager(data, work, options, HostModels.ForTest(options))
        )
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "existing", null, null);
            await owner.PresentFailureAsync(
                new InvalidOperationException("persisted notice"),
                true
            );
        }
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var runtime = new SessionRuntime(manager);
        var events = new ConcurrentQueue<SessionRuntimeEvent>();
        runtime.Changed += events.Enqueue;
        Assert.Null(manager.Find("existing"));
        var current = await manager.RequiredAsync("existing");
        var settings = await new MessageRouter(runtime).HandleMessageAsync(
            new(current.Id, "webui"),
            new("/verbose on", null)
        );
        Assert.Equal(200, settings.Status);
        Assert.Single(current.History());
        Assert.DoesNotContain(
            events,
            value =>
                value.Kind
                    is SessionEventKind.MessageCommitted
                        or SessionEventKind.QueueHistoryAppended
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Ordinary_notice_preserves_precommit_fallback_and_committed_error_publication(
        bool committed
    )
    {
        using var temp = new TempDirectory();
        var armed = false;
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: stage =>
            {
                if (
                    armed
                    && stage
                        == (
                            committed
                                ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                                : AtomicJsonWriteStage.BeforeRename
                        )
                )
                {
                    armed = false;
                    throw new IOException("owned notice write fault");
                }
            }
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local/wire",
            "",
            "",
            713
        );
        var owner = new SessionOwner("s", "main", HostModels.ForTest(options))
        {
            Registry = new SessionRegistry(store, new FakeChatService()),
        };
        owner.Registry.Add("s");
        owner.EnableCommittedNotifications();
        await owner.Entry.SaveLane.SaveStrictAsync();
        var events = new List<SessionRuntimeEvent>();
        owner.Changed += events.Add;
        armed = true;
        await owner.PresentFailureAsync(new InvalidOperationException("ordinary notice"), true);
        var delivered = Assert
            .Single(events, value => value.Kind == SessionEventKind.MessageCommitted)
            .Data!;
        Assert.Equal(!committed, delivered["__meta"]!["temporary"]?.GetValue<bool>() == true);
        Assert.Equal(committed ? 1 : 0, owner.History().Count);
        Assert.Equal(committed ? 1 : 0, (await store.LoadAsync("s"))!.History.Count);
        Assert.Equal(committed ? 1 : 0, store.Archive.ReadMessages().Count);
        Assert.Equal(1, owner.Entry.BestEffortFailureCount);
        if (committed)
            Assert.True(
                System.Text.Json.Nodes.JsonNode.DeepEquals(
                    Assert.Single(owner.History()),
                    delivered
                )
            );
    }

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
