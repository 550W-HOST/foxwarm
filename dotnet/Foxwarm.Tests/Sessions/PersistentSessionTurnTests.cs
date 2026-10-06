using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class PersistentSessionTurnTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task HeldCanonicalAppendSerializesConcurrentAcknowledgedIngress(bool failPrecommit)
    {
        using var temp = new TempDirectory();
        var hook = new AsyncCommitBarrier(1, failPrecommit);
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            canonicalCommitBarrier: hook.InvokeAsync
        );
        var chat = new ControlledChat();
        chat.QueueResult("first");
        chat.QueueResult("second");
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("A", clientMessageId: "a"));

        var runner = registry.Runner.ProcessQueueAsync("s");
        await hook.Reached.WaitAsync(TimeSpan.FromSeconds(5));
        var ingressB = registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("B", clientMessageId: "b")
        );
        var ingressC = registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("C", clientMessageId: "c")
        );
        Assert.False(ingressB.IsCompleted);
        Assert.False(ingressC.IsCompleted);
        Assert.Empty(entry.Snapshot().History);
        // B/C are not acknowledged until their ordered wait-aware admissions start after the held append.
        Assert.Equal(new[] { "A" }, entry.Snapshot().Queue.Select(QueueText));

        hook.Release();
        if (failPrecommit)
        {
            await Assert.ThrowsAsync<IOException>(() => runner);
            await Task.WhenAll(ingressB, ingressC);
            Assert.Empty(entry.Snapshot().History);
            Assert.Equal(new[] { "A", "B", "C" }, entry.Snapshot().Queue.Select(QueueText));
            await registry.Runner.ProcessQueueAsync("s");
        }
        else
        {
            await Task.WhenAll(ingressB, ingressC);
            await runner;
        }

        var hot = entry.Snapshot();
        var stored = await store.LoadAsync("s");
        Assert.NotNull(stored);
        Assert.Empty(hot.Queue);
        Assert.Empty(stored!.Queue);
        Assert.Equal(
            hot.History.Select(message => message.ToJsonString()),
            stored.History.Select(message => message.ToJsonString())
        );
        Assert.Equal(
            Enumerable.Range(1, hot.History.Count).Select(value => (long)value),
            hot.History.Select(Seq)
        );
        Assert.Equal(hot.History.Count + 1, hot.NextMessageSeq);
        Assert.Equal(hot.History.Select(MessageText), hot.History.Select(MessageText).Distinct());
        var combined = string.Join("|", hot.History.Select(MessageText));
        Assert.Contains("A", combined);
        Assert.Contains("B", combined);
        Assert.Contains("C", combined);
        var archive = store.Archive.ReadMessages();
        Assert.Equal(hot.History.Count, archive.Count);
        Assert.Equal(
            hot.History.Select(message => message.ToJsonString()),
            archive.Select(record => record.Message.ToJsonString())
        );
    }

    [Fact]
    public async Task StopCancelsBeforeHeldAssistantAppendCompletesAndPersistsFinalState()
    {
        using var temp = new TempDirectory();
        var hook = new AsyncCommitBarrier(2, failAfterRelease: false);
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            canonicalCommitBarrier: hook.InvokeAsync
        );
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("A"));

        var runner = registry.Runner.ProcessQueueAsync("s");
        await hook.Reached.WaitAsync(TimeSpan.FromSeconds(5));
        var stop = registry.Control.StopAsync("s");
        Assert.False(stop.IsCompleted);
        Assert.True(entry.Snapshot().Stopping);

        hook.Release();
        var stopResult = await stop;
        await runner;
        Assert.True(stopResult.AbortedInFlight);
        var hot = entry.Snapshot();
        var stored = await store.LoadAsync("s");
        Assert.NotNull(stored);
        Assert.False(hot.Busy);
        Assert.False(hot.Stopping);
        Assert.Equal(new long[] { 1, 2 }, hot.History.Select(Seq));
        Assert.Equal(
            hot.History.Select(message => message.ToJsonString()),
            stored!.History.Select(message => message.ToJsonString())
        );
    }

    [Theory]
    [InlineData(AtomicJsonWriteStage.BeforeRename, false)]
    [InlineData(AtomicJsonWriteStage.AfterRenameBeforeDirectorySync, true)]
    [InlineData(AtomicJsonWriteStage.AfterDirectorySync, true)]
    public async Task AuthorityFailurePublishesOnlyPostRenameCommit(
        AtomicJsonWriteStage stage,
        bool committed
    )
    {
        using var temp = new TempDirectory();
        var hook = new ThrowingWriteHook(3, stage);
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: hook.Invoke
        );
        var chat = new ControlledChat();
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("A"));

        var error = await Record.ExceptionAsync(() => registry.Runner.ProcessQueueAsync("s"));
        Assert.NotNull(error);
        Assert.Equal(committed, error is AuthorityCommittedException);
        var hot = entry.Snapshot();
        var stored = await store.LoadAsync("s");
        Assert.NotNull(stored);
        Assert.Equal(committed ? 1 : 0, hot.History.Count);
        Assert.Equal(committed ? 0 : 1, hot.Queue.Count);
        Assert.Equal(hot.History.Count, store.Archive.ReadMessages().Count);
        Assert.Equal(
            hot.History.Select(message => message.ToJsonString()),
            stored!.History.Select(message => message.ToJsonString())
        );
        Assert.Equal(hot.Queue.Select(QueueText), stored.Queue.Select(QueueText));
        Assert.Empty(chat.Calls);
    }

    [Fact]
    public async Task ArchiveConflictDoesNotPublishOrDeletePreexistingRow()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var existing = CanonicalMessage(1, "preexisting", 1000);
        Assert.Single(
            store.Archive.WriteMessages([
                ArchiveMessageRecord.Create("s", "main", 1, 1000, existing),
            ])
        );
        var registry = new SessionRegistry(store, new ControlledChat());
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("A"));

        await Assert.ThrowsAsync<InvalidDataException>(() =>
            registry.Runner.ProcessQueueAsync("s")
        );
        Assert.Empty(entry.Snapshot().History);
        Assert.Single(entry.Snapshot().Queue);
        var row = Assert.Single(store.Archive.ReadMessages());
        Assert.Equal("preexisting", MessageText(row.Message));
    }

    [Fact]
    public async Task ExactArchiveReplayIsNotDeletedWhenAuthorityPrecommitFails()
    {
        using var temp = new TempDirectory();
        var hook = new ThrowingWriteHook(3, AtomicJsonWriteStage.BeforeRename);
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: hook.Invoke
        );
        var prebuilt = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "exact" }),
            ["__meta"] = new JsonObject { ["timestamp"] = 1000 },
        };
        var archived = CanonicalMessage(1, "exact", 1000);
        Assert.Single(
            store.Archive.WriteMessages([
                ArchiveMessageRecord.Create("s", "main", 1, 1000, archived),
            ])
        );
        var registry = new SessionRegistry(store, new ControlledChat());
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.Prebuilt(prebuilt));

        await Assert.ThrowsAsync<IOException>(() => registry.Runner.ProcessQueueAsync("s"));

        Assert.Empty(entry.Snapshot().History);
        Assert.Single(entry.Snapshot().Queue);
        Assert.Equal(
            archived.ToJsonString(),
            Assert.Single(store.Archive.ReadMessages()).Message.ToJsonString()
        );
    }

    [Fact]
    public async Task CallerSuppliedSequenceIsRejectedBeforeArchiveWrite()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var registry = new SessionRegistry(store, new ControlledChat());
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.Prebuilt(CanonicalMessage(77, "bad", 1000)));

        await Assert.ThrowsAsync<UnsupportedSessionTurnException>(() =>
            registry.Runner.ProcessQueueAsync("s")
        );

        Assert.Empty(entry.Snapshot().History);
        Assert.Single(entry.Snapshot().Queue);
        Assert.Empty(store.Archive.ReadMessages());
    }

    [Fact]
    public async Task OrdinaryQueueRoundTripPreservesCurrentShapeAndOpenFields()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var registry = new SessionRegistry(store, new ControlledChat());
        registry.TriggerOverride = _ => Task.CompletedTask;
        registry.Add("s");
        var source = new QueueSource(
            "webui",
            "conversation",
            ChannelId: "channel",
            ConversationId: "conversation",
            OpenFields: new JsonObject { ["futureSource"] = new JsonObject { ["keep"] = true } }
        );
        var item = new QueueItem(
            QueueItemType.Intersession,
            [new JsonObject { ["text"] = "queued", ["futurePart"] = 1 }],
            Source: source,
            SourceSessionId: "parent",
            SourceSessionRelation: "parent",
            OpenFields: new JsonObject { ["futureQueue"] = new JsonObject { ["keep"] = true } }
        );

        await registry.Ingress.EnqueueAsync("s", item);

        var loaded = await store.LoadAsync("s");
        var queued = Assert.Single(loaded!.Queue);
        Assert.Equal(QueueItemType.Intersession, queued.Type);
        Assert.True(queued.OpenFields!["futureQueue"]!["keep"]!.GetValue<bool>());
        Assert.True(queued.Source!.OpenFields!["futureSource"]!["keep"]!.GetValue<bool>());
        Assert.Equal(1, queued.Parts![0]["futurePart"]!.GetValue<int>());
    }

    [Fact]
    public async Task OrdinaryAppendPreservesLoadedHistoryVersionAndUsesTsFalsyTimestampRule()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var queue = new[]
        {
            QueueItem.Prebuilt(Prebuilt("zero", 0L, includeTimestamp: true)),
            QueueItem.Prebuilt(Prebuilt("negative-zero", -0.0, includeTimestamp: true)),
            QueueItem.Prebuilt(Prebuilt("null", null, includeTimestamp: true)),
            QueueItem.Prebuilt(Prebuilt("missing", null, includeTimestamp: false)),
            QueueItem.Prebuilt(Prebuilt("kept", 7L, includeTimestamp: true)),
        };
        await store.CommitAsync(
            new SessionSnapshot(
                "s",
                [],
                queue,
                false,
                null,
                false,
                new JsonObject { ["lastMessageTime"] = 0, ["messageCount"] = 0 },
                1,
                9,
                new JsonObject()
            ),
            SaveKind.Strict
        );
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = new SessionRegistry(store, chat, clock: () => 4242);
        var entry = await registry.LoadOrAddAsync("s");

        await registry.TriggerProcessingAsync("s");

        var snapshot = entry.Snapshot();
        Assert.Equal(9, snapshot.HistoryVersion);
        Assert.Equal(9, (await store.LoadAsync("s"))!.HistoryVersion);
        Assert.Equal(
            new double[] { 4242, 4242, 4242, 4242, 7, 4242 },
            snapshot.History.Select(Timestamp)
        );
    }

    [Fact]
    public async Task SynchronousAuthorityWriteDoesNotHoldLaneGateAcrossStopEnqueue()
    {
        using var temp = new TempDirectory();
        var hook = new BlockingStageHook(4, AtomicJsonWriteStage.BeforeRename);
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: hook.Invoke
        );
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("A"));

        var runner = registry.TriggerProcessingAsync("s");
        Assert.True(hook.Reached.Wait(TimeSpan.FromSeconds(5)));
        Task<StopResult>? stopTask = null;
        using var callReturned = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            stopTask = registry.Control.StopAsync("s");
            callReturned.Set();
        });
        thread.Start();
        Assert.True(callReturned.Wait(TimeSpan.FromSeconds(2)));
        Assert.NotNull(stopTask);
        Assert.False(stopTask!.IsCompleted);
        Assert.True(entry.Snapshot().Stopping);

        hook.Release();
        Assert.True((await stopTask).AbortedInFlight);
        await runner;
        thread.Join();
    }

    [Fact]
    public async Task DefaultTriggerRecordsCanonicalFailureWithoutRetryAndExplicitTriggerRecoversOnce()
    {
        using var temp = new TempDirectory();
        var barrier = new AsyncCommitBarrier(1, failAfterRelease: true);
        barrier.Release();
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            canonicalCommitBarrier: barrier.InvokeAsync
        );
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");

        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("A"));
        var error = await entry
            .WaitForBackgroundProcessorFailureAsync()
            .WaitAsync(TimeSpan.FromSeconds(5));

        Assert.IsType<IOException>(error);
        Assert.Equal(1, entry.BackgroundProcessorFailureCount);
        Assert.IsType<IOException>(entry.LastBackgroundProcessorFailure);
        Assert.Equal(1, entry.ProcessorClaimCount);
        Assert.Single(entry.Snapshot().Queue);
        Assert.Empty(entry.Snapshot().History);
        Assert.Empty(store.Archive.ReadMessages());
        var failedAuthority = await store.LoadAsync("s");
        Assert.Single(failedAuthority!.Queue);
        Assert.Empty(failedAuthority.History);

        await registry.TriggerProcessingAsync("s");
        Assert.Equal(2, entry.ProcessorClaimCount);
        Assert.Empty(entry.Snapshot().Queue);
        Assert.Equal(2, entry.Snapshot().History.Count);
        Assert.Equal(2, store.Archive.ReadMessages().Count);
        Assert.Equal(2, (await store.LoadAsync("s"))!.History.Count);
        Assert.Equal(1, entry.BackgroundProcessorFailureCount);
    }

    [Fact]
    public async Task CallbackFailureDoesNotReverseDurableCanonicalCommit()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        var callbackCount = 0;
        entry.Committed = _ =>
        {
            if (Interlocked.Increment(ref callbackCount) == 1)
                throw new InvalidOperationException("observer failed");
        };
        entry.State.Queue.Add(QueueItem.UserText("A"));

        await registry.Runner.ProcessQueueAsync("s");

        Assert.Equal(1, entry.PostCommitNotificationFailureCount);
        Assert.Equal(2, entry.Snapshot().History.Count);
        Assert.Equal(2, store.Archive.ReadMessages().Count);
        Assert.Equal(2, (await store.LoadAsync("s"))!.History.Count);
    }

    [Fact]
    public async Task SameProcessReopenUsesJsonAuthorityAndFailsClosedWithoutIt()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("A"));
        await registry.Runner.ProcessQueueAsync("s");

        var reopened = new PersistentSessionAuthorityStore(temp.Path, "s");
        var loaded = await reopened.LoadAsync("s");
        Assert.NotNull(loaded);
        Assert.Equal(
            entry.Snapshot().History.Select(message => message.ToJsonString()),
            loaded!.History.Select(message => message.ToJsonString())
        );

        File.Delete(reopened.AuthorityPath);
        var missing = new PersistentSessionAuthorityStore(temp.Path, "s");
        await Assert.ThrowsAsync<InvalidDataException>(() => missing.LoadAsync("s"));
        File.WriteAllText(missing.AuthorityPath, "{not-json");
        var corrupt = new PersistentSessionAuthorityStore(temp.Path, "s");
        await Assert.ThrowsAsync<InvalidDataException>(() => corrupt.LoadAsync("s"));
    }

    private static JsonObject CanonicalMessage(long seq, string text, long timestamp) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = timestamp },
        };

    private static long Seq(JsonObject message) => message["__meta"]!["seq"]!.GetValue<long>();

    private static double Timestamp(JsonObject message)
    {
        var value = (JsonValue)message["__meta"]!["timestamp"]!;
        if (value.TryGetValue<double>(out var floating))
            return floating;
        if (value.TryGetValue<long>(out var signed))
            return signed;
        if (value.TryGetValue<int>(out var integer))
            return integer;
        throw new InvalidDataException("Test message timestamp is not numeric.");
    }

    private static string QueueText(QueueItem item) =>
        item.Parts?.FirstOrDefault()?["text"]?.GetValue<string>() ?? item.Type.ToString();

    private static string MessageText(JsonObject message) =>
        string.Join(
            "",
            ((JsonArray)message["parts"]!).Select(part => part?["text"]?.GetValue<string>() ?? "")
        );

    private static JsonObject Prebuilt(string text, object? timestamp, bool includeTimestamp)
    {
        var meta = new JsonObject();
        if (includeTimestamp)
            meta["timestamp"] = timestamp switch
            {
                null => null,
                long signed => JsonValue.Create(signed),
                double floating => JsonValue.Create(floating),
                _ => throw new ArgumentException(
                    "Unsupported test timestamp type.",
                    nameof(timestamp)
                ),
            };
        return new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = meta,
        };
    }

    private sealed class TempDirectory : IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"foxwarm-c2-{Guid.NewGuid():N}"
            );
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, recursive: true);
        }
    }

    private sealed class AsyncCommitBarrier(int targetCommit, bool failAfterRelease)
    {
        private readonly TaskCompletionSource<bool> release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        private readonly TaskCompletionSource<bool> reached = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        public Task Reached => reached.Task;

        public void Release() => release.TrySetResult(true);

        public async Task InvokeAsync(int commit, CancellationToken cancellationToken)
        {
            if (commit != targetCommit)
                return;
            reached.TrySetResult(true);
            await release.Task.WaitAsync(cancellationToken);
            if (failAfterRelease)
                throw new IOException("planned authority precommit failure");
        }
    }

    private sealed class ThrowingWriteHook(int targetWrite, AtomicJsonWriteStage targetStage)
    {
        private int currentWrite;
        private int fired;

        public void Invoke(AtomicJsonWriteStage stage)
        {
            if (stage == AtomicJsonWriteStage.BeforeTempWrite)
                Interlocked.Increment(ref currentWrite);
            if (
                Volatile.Read(ref currentWrite) == targetWrite
                && stage == targetStage
                && Interlocked.Exchange(ref fired, 1) == 0
            )
                throw new IOException("planned authority failure");
        }
    }

    private sealed class BlockingStageHook(int targetWrite, AtomicJsonWriteStage targetStage)
    {
        private readonly ManualResetEventSlim reached = new(false);
        private readonly ManualResetEventSlim release = new(false);
        private int currentWrite;
        private int fired;
        public ManualResetEventSlim Reached => reached;

        public void Release() => release.Set();

        public void Invoke(AtomicJsonWriteStage stage)
        {
            if (stage == AtomicJsonWriteStage.BeforeTempWrite)
                Interlocked.Increment(ref currentWrite);
            if (
                Volatile.Read(ref currentWrite) != targetWrite
                || stage != targetStage
                || Interlocked.Exchange(ref fired, 1) != 0
            )
                return;
            reached.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("test authority hold timed out");
        }
    }
}
