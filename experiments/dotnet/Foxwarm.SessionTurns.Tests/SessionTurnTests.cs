using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.SessionTurns;

namespace Foxwarm.SessionTurns.Tests;

public sealed class SessionTurnTests
{
    [Fact]
    public async Task BusyClaimPersistsBeforeChatAndStrictFailureDoesNotCallProvider()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = NewRegistry(store, chat, out var entry);
        entry.State.Queue.Add(QueueItem.UserText("hello"));
        chat.QueueResult("answer");

        await registry.Runner.ProcessQueueAsync("s");

        Assert.Single(chat.Calls);
        var snapshot = await store.LoadAsync("s");
        Assert.NotNull(snapshot);
        Assert.Contains(store.Calls, call => call.Kind == SaveKind.Strict && snapshot!.Busy == false);

        var failingStore = new InMemorySessionAuthorityStore();
        failingStore.Fail("f", new InvalidOperationException("strict failure"));
        var failingChat = new ControlledChat();
        var failingRegistry = new SessionRegistry(failingStore, failingChat);
        var failingEntry = failingRegistry.Add("f");
        failingEntry.State.Queue.Add(QueueItem.UserText("never"));
        var task = CaptureTrigger(failingRegistry, "f");
        await Assert.ThrowsAsync<InvalidOperationException>(() => task);
        Assert.Empty(failingChat.Calls);
        Assert.False(failingEntry.Snapshot().Busy);
    }

    [Fact]
    public async Task OrdinaryEnqueueAwaitsBestEffortSaveAndSnapshotReloadProcessesOnce()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = NewRegistry(store, chat, out _);
        registry.TriggerOverride = _ => Task.CompletedTask;
        store.Hold("s");
        var enqueue = registry.Ingress.EnqueueAsync("s", QueueItem.UserText("queued", clientMessageId: "c1"));
        await store.WaitForCommitAsync("s");
        Assert.False(enqueue.IsCompleted);
        store.Release("s");
        await enqueue;

        var loadedRegistry = new SessionRegistry(store, chat);
        var loaded = await loadedRegistry.LoadOrAddAsync("s");
        Assert.Single(loaded.Snapshot().Queue);
        chat.QueueResult("answer");
        await loadedRegistry.Runner.ProcessQueueAsync("s");

        Assert.Single(chat.Calls);
        var final = loaded.Snapshot();
        Assert.Empty(final.Queue);
        Assert.Equal(2, final.History.Count);
    }

    [Fact]
    public async Task OrdinarySaveFailureDoesNotRejectAckOrBecomeStrict()
    {
        var store = new InMemorySessionAuthorityStore();
        store.Fail("s", new IOException("best effort fault"), SaveKind.BestEffort);
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = NewRegistry(store, chat, out var entry);
        Task? triggeredRun = null;
        registry.TriggerOverride = id => triggeredRun = registry.Runner.ProcessQueueAsync(id);
        var enqueue = registry.Ingress.EnqueueAsync("s", QueueItem.UserText("hello"));
        await enqueue;
        await triggeredRun!;
        Assert.Equal(1, entry.BestEffortFailureCount);
        Assert.Single(chat.Calls);
        Assert.Contains(store.Calls, call => call.Kind == SaveKind.Strict);
    }

    [Fact]
    public async Task CompatibleSourcesBatchAndBoundariesCreateSeparateHistoryRowsAndCalls()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = NewRegistry(store, chat, out var entry);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var source = new QueueSource("wework", "u", ChannelId: "c", ConversationId: "room", WeWorkStreamId: "stream");
        entry.State.Queue.Add(QueueItem.UserText("one", source, "m1"));
        entry.State.Queue.Add(QueueItem.UserText("two", source, "m2"));
        chat.QueueResult("combined");
        await registry.Runner.ProcessQueueAsync("s");
        Assert.Single(chat.Calls);
        Assert.Equal(3, entry.Snapshot().History.Count);
        Assert.Equal("m1", ClientId(entry.Snapshot().History[0]));
        Assert.Equal("m2", ClientId(entry.Snapshot().History[1]));

        var secondSource = source with { PreferDirectReply = true };
        entry.State.Queue.Add(QueueItem.UserText("three", source));
        entry.State.Queue.Add(QueueItem.UserText("four", secondSource));
        chat.QueueResult("third");
        chat.QueueResult("fourth");
        await registry.Runner.ProcessQueueAsync("s");
        Assert.Equal(3, chat.Calls.Count);
    }

    [Fact]
    public async Task PrebuiltFirstConsumesPartsPreparationBoundary()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = NewRegistry(store, chat, out var entry);
        registry.TriggerOverride = _ => Task.CompletedTask;
        entry.State.Meta["lastMessageTime"] = 42L;
        var prebuilt = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "prebuilt" })
        };
        entry.State.Queue.Add(QueueItem.Prebuilt(prebuilt));
        entry.State.Queue.Add(QueueItem.UserText("later"));

        await registry.Runner.ProcessQueueAsync("s");

        var snapshot = entry.Snapshot();
        var later = snapshot.History.Last(message => message["role"]?.GetValue<string>() == "user");
        var laterParts = (JsonArray)later["parts"]!;
        Assert.Equal("later", laterParts[0]?["text"]?.GetValue<string>());
        Assert.DoesNotContain(laterParts, part => part?["system"] is not null);
        Assert.Equal(42L, snapshot.Meta["lastMessageTime"]?.GetValue<long>());
    }

    [Fact]
    public async Task EmptyThenPartsStillPreparesFirstCommittedInput()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = NewRegistry(store, chat, out var entry);
        registry.TriggerOverride = _ => Task.CompletedTask;
        entry.State.Queue.Add(new QueueItem(QueueItemType.User, Array.Empty<JsonObject>()));
        entry.State.Queue.Add(QueueItem.UserText("parts"));

        await registry.Runner.ProcessQueueAsync("s");

        var snapshot = entry.Snapshot();
        var user = snapshot.History.Single(message => message["role"]?.GetValue<string>() == "user");
        Assert.Equal(
            "<foxwarm-system kind=\"session\" currentSessionId=\"s\" />",
            ((JsonArray)user["parts"]!)[0]?["system"]?.GetValue<string>());
        Assert.True(snapshot.Meta["lastMessageTime"]?.GetValue<long>() > 0);
    }

    [Fact]
    public async Task PeekedLeadingItemAdvancesAndIsConsumedOnce()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueResult("answer");
        var registry = NewRegistry(store, chat, out var entry);
        entry.State.Queue.Add(QueueItem.UserText("one"));

        await registry.Runner.ProcessQueueAsync("s");

        Assert.Single(chat.Calls);
        Assert.Empty(entry.Snapshot().Queue);
    }

    [Fact]
    public async Task CallCountWaiterRechecksAfterSignalReplacement()
    {
        var chat = new ControlledChat();
        chat.PauseNextCallCountWaiterBeforeSignalGate();

        var waiter = chat.WaitForCallCount(1);
        await chat.WaiterPausedBeforeSignalGate;
        await chat.ChatAsync("s", Array.Empty<JsonObject>(), CancellationToken.None);
        chat.ReleaseCallCountWaiter();

        await waiter;
        Assert.Single(chat.Calls);
    }

    [Fact]
    public async Task PreloadedCompactHeadFailsWithoutProviderOrRetrigger()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = NewRegistry(store, chat, out var entry);
        var triggerCount = 0;
        registry.TriggerOverride = _ =>
        {
            Interlocked.Increment(ref triggerCount);
            return Task.CompletedTask;
        };
        entry.State.Queue.Add(new QueueItem(QueueItemType.CompactCommit));

        var processing = registry.Runner.ProcessQueueAsync("s");
        await Assert.ThrowsAsync<UnsupportedSessionTurnException>(() => processing);

        Assert.Empty(chat.Calls);
        Assert.False(entry.Snapshot().Busy);
        Assert.Single(entry.Snapshot().Queue);
        Assert.Equal(0, triggerCount);
    }

    [Fact]
    public async Task ConcurrentTriggersRunOneProcessor()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueAwaitingResult();
        var registry = NewRegistry(store, chat, out var entry);
        entry.State.Queue.Add(QueueItem.UserText("one"));
        var runs = Enumerable.Range(0, 20).Select(_ => registry.Runner.ProcessQueueAsync("s")).ToArray();
        await chat.Started;
        chat.Complete("done");
        await Task.WhenAll(runs);
        Assert.Single(chat.Calls);
    }

    [Fact]
    public async Task DifferentSessionsRunFakeChatsConcurrently()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = new SessionRegistry(store, chat);
        var a = registry.Add("a");
        var b = registry.Add("b");
        a.State.Queue.Add(QueueItem.UserText("a"));
        b.State.Queue.Add(QueueItem.UserText("b"));
        var aGate = NewSignal<string>();
        chat.QueuePlan((id, token) => id == "a" ? aGate.Task : Task.FromResult("b"));
        var runA = registry.Runner.ProcessQueueAsync("a");
        await chat.WaitForStarted("a");
        var runB = registry.Runner.ProcessQueueAsync("b");
        await chat.WaitForStarted("b");
        Assert.False(runA.IsCompleted);
        aGate.TrySetResult("a");
        await Task.WhenAll(runA, runB);
        Assert.Equal(2, chat.Calls.Count);
    }

    [Fact]
    public async Task StopCancelsBeforeHeldSaveCompletes()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueAwaitingCancellation();
        var registry = NewRegistry(store, chat, out var entry);
        entry.State.Queue.Add(QueueItem.UserText("active"));
        var run = registry.Runner.ProcessQueueAsync("s");
        await chat.Started;

        store.ResetCommitSignal("s");
        store.Hold("s");
        var enqueue = registry.Ingress.EnqueueAsync("s", QueueItem.UserText("during-stop", clientMessageId: "during"));
        await store.WaitForCommitAsync("s");
        var stop = registry.Control.StopAsync("s");
        await chat.Cancelled;
        Assert.False(stop.IsCompleted);
        store.Release("s");
        await enqueue;
        await stop;
        await run;
        Assert.True(chat.CancellationObserved);
    }

    [Fact]
    public async Task StopFinalizationCommitsAcceptedQueueWithoutAnotherChat()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueAwaitingCancellation();
        var registry = NewRegistry(store, chat, out var entry);
        entry.State.Queue.Add(QueueItem.UserText("first", clientMessageId: "first"));
        var run = registry.Runner.ProcessQueueAsync("s");
        await chat.Started;
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("second", clientMessageId: "second"));
        await registry.Control.StopAsync("s");
        await run;
        var snapshot = entry.Snapshot();
        Assert.Equal(2, snapshot.History.Count);
        Assert.Equal(new[] { "second" }, snapshot.History.Skip(1).Select(ClientId));
        Assert.Empty(snapshot.Queue);
        Assert.False(snapshot.Busy);
        Assert.False(snapshot.Stopping);
        Assert.Single(chat.Calls);
    }

    [Fact]
    public async Task FinishWindowInputGetsOneFreshProcessor()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueAwaitingCancellation();
        var registry = NewRegistry(store, chat, out var entry);
        var committedOnce = 0;
        entry.Committed = snapshot =>
        {
            if (snapshot.Busy || snapshot.Stopping || Interlocked.Exchange(ref committedOnce, 1) != 0) return;
            entry.WithStateForTest(state => state.Queue.Add(QueueItem.UserText("late")));
        };
        var trailingRun = NewSignal<Task>();
        var triggerCount = 0;
        registry.TriggerOverride = id =>
        {
            Interlocked.Increment(ref triggerCount);
            var candidate = registry.Runner.ProcessQueueAsync(id);
            trailingRun.TrySetResult(candidate);
            return candidate;
        };
        entry.State.Queue.Add(QueueItem.UserText("first"));
        var run = registry.Runner.ProcessQueueAsync("s");
        await chat.Started;

        var stop = registry.Control.StopAsync("s");
        await chat.Cancelled;
        await Task.WhenAll(stop, run);
        await chat.WaitForCallCount(2);
        await (await trailingRun.Task);
        Assert.Equal(1, triggerCount);
        Assert.Equal(2, chat.Calls.Count);
        var final = entry.Snapshot();
        Assert.Empty(final.Queue);
        Assert.False(final.Busy);
        Assert.Contains(final.History, message => message.ToJsonString().Contains("late", StringComparison.Ordinal));
        Assert.Contains(final.History, message => message["role"]?.GetValue<string>() == "model");
    }

    [Fact]
    public async Task CancellationOwnershipRacesAndStaleClearAreSafe()
    {
        var entry = new SessionEntry(new SessionState("s"), new InMemorySessionAuthorityStore());
        var first = entry.RegisterCancellationForTest(new CancellationTokenSource());
        entry.ClearCancellationForTest(first);
        var stopNoOp = entry.TakeCancellationForTest();
        Assert.Null(stopNoOp);

        entry.SetStoppingForTest(false);
        var stale = entry.RegisterCancellationForTest(new CancellationTokenSource());
        var taken = entry.TakeCancellationForTest();
        Assert.Same(stale, taken);
        entry.SetStoppingForTest(false);
        var current = entry.RegisterCancellationForTest(new CancellationTokenSource());
        entry.ClearCancellationForTest(stale);
        Assert.Same(current, entry.TakeCancellationForTest());
        current!.Cancel();
        current.Dispose();
        taken!.Dispose();
    }

    [Fact]
    public async Task PostCommitCallbackCanReenterEnqueue()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = NewRegistry(store, chat, out var entry);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var callbackDone = NewSignal<bool>();
        Task? callbackEnqueue = null;
        var once = 0;
        entry.Committed = snapshot =>
        {
            if (Interlocked.Exchange(ref once, 1) == 0)
            {
                callbackEnqueue = registry.Ingress.EnqueueAsync("s", QueueItem.UserText("callback"));
                callbackDone.TrySetResult(true);
            }
        };
        entry.State.Queue.Add(QueueItem.UserText("initial"));
        chat.QueueResult("answer");
        await registry.Runner.ProcessQueueAsync("s");
        await callbackDone.Task;
        await callbackEnqueue!;
        Assert.Contains(entry.Snapshot().History, message => message.ToJsonString().Contains("callback", StringComparison.Ordinal));
    }

    [Fact]
    public async Task UnsupportedPathsFailNamedAndDoNotMutate()
    {
        var registry = NewRegistry(new InMemorySessionAuthorityStore(), new ControlledChat(), out var entry);
        foreach (var type in new[] { QueueItemType.CompactCommit, QueueItemType.Tools, QueueItemType.Retry, QueueItemType.Wait, QueueItemType.Managed, QueueItemType.Channel })
        {
            var error = await Assert.ThrowsAsync<UnsupportedSessionTurnException>(() => registry.Ingress.EnqueueAsync("s", new QueueItem(type)));
            Assert.Contains(type switch
            {
                QueueItemType.CompactCommit => "compact",
                QueueItemType.Tools => "tools",
                QueueItemType.Retry => "retry",
                QueueItemType.Wait => "waits",
                QueueItemType.Managed => "managed state",
                _ => "channel delivery"
            }, error.Message);
        }
        Assert.Empty(entry.Snapshot().Queue);
        Assert.Empty(entry.Snapshot().History);
    }

    [Fact]
    public async Task ChatFailureReleasesBusyAndLeavesLaterQueueForFreshTrigger()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        chat.QueueFailure(new InvalidOperationException("chat failed"));
        chat.QueueResult("later");
        var registry = NewRegistry(store, chat, out var entry);
        registry.TriggerOverride = _ => Task.CompletedTask;
        entry.State.Queue.Add(QueueItem.UserText("fails", new QueueSource("qq", "u", ChannelId: "c", ConversationId: "one", QqBotMessageId: "m1")));
        entry.State.Queue.Add(QueueItem.UserText("later", new QueueSource("qq", "u", ChannelId: "c", ConversationId: "two", QqBotMessageId: "m2")));
        await registry.Runner.ProcessQueueAsync("s");
        Assert.False(entry.Snapshot().Busy);
        Assert.Single(entry.Snapshot().Queue);
        await registry.Runner.ProcessQueueAsync("s");
        Assert.Equal(2, chat.Calls.Count);
        Assert.Empty(entry.Snapshot().Queue);
    }

    [Fact]
    public async Task StrictAppendFailurePreservesAcknowledgedIngressAndRestoresSelection()
    {
        var store = new AppendFailureProbeStore();
        var chat = new ControlledChat();
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        // Isolate strict-append compensation from a later normal processor started by ingress.
        registry.TriggerOverride = _ => Task.CompletedTask;
        entry.State.Queue.Add(QueueItem.UserText("A"));
        store.FailNextStrictAppend();

        var runner = registry.Runner.ProcessQueueAsync("s");
        await store.HeldStrictAppend;

        var ingress = registry.Ingress.EnqueueAsync("s", QueueItem.UserText("B", clientMessageId: "b"));
        Assert.False(ingress.IsCompleted);
        var hotBeforeRelease = entry.Snapshot();
        Assert.Contains(hotBeforeRelease.Queue, item => item.Parts?.FirstOrDefault()?[
            "text"]?.GetValue<string>() == "B");
        Assert.DoesNotContain(hotBeforeRelease.History, message => message.ToJsonString().Contains("B", StringComparison.Ordinal));
        var timestamp = hotBeforeRelease.Meta["lastMessageTime"]!.GetValue<long>();
        entry.WithStateForTest(state => state.Meta["lastMessageTime"] = JsonValue.Create(timestamp));

        store.ReleaseHeldStrictAppend();
        await Assert.ThrowsAsync<InvalidOperationException>(() => runner);
        await ingress;

        var hotFinal = entry.Snapshot();
        var storedFinal = await store.LoadAsync("s");
        Assert.NotNull(storedFinal);
        Assert.Equal(1, CountValue(hotFinal, "A"));
        Assert.Equal(1, CountValue(hotFinal, "B"));
        Assert.Equal(1, CountValue(storedFinal!, "A"));
        Assert.Equal(1, CountValue(storedFinal!, "B"));
        Assert.False(hotFinal.Busy);
        Assert.False(storedFinal.Busy);
        Assert.Equal(timestamp, hotFinal.Meta["lastMessageTime"]?.GetValue<long>());
        Assert.Equal(timestamp, storedFinal.Meta["lastMessageTime"]?.GetValue<long>());

        Assert.NotEmpty(store.Observations);
    }

    [Fact]
    public async Task InitialAndNoninitialPartsUseCanonicalSessionTagAndTimestampBoundary()
    {
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, new ControlledChat());
        var sessionId = "\uFEFF \r\n  alpha \t \u0001 & < > \" ' \u000B omega \u0085 \uFEFF \n ";
        var entry = registry.Add(sessionId);
        entry.State.Queue.Add(QueueItem.UserText("first"));

        await registry.Runner.ProcessQueueAsync(sessionId);

        var initial = entry.Snapshot();
        var initialUser = initial.History.Single(message => message["role"]?.GetValue<string>() == "user");
        var initialParts = (JsonArray)initialUser["parts"]!;
        Assert.Equal(
            "<foxwarm-system kind=\"session\" currentSessionId=\"alpha &amp; &lt; &gt; &quot; &apos; omega \u0085\" />",
            initialParts[0]?["system"]?.GetValue<string>());
        Assert.True(initial.Meta["lastMessageTime"]?.GetValue<long>() > 0);

        entry.State.Meta["lastMessageTime"] = 1;
        entry.State.Queue.Add(QueueItem.UserText("second"));
        await registry.Runner.ProcessQueueAsync(sessionId);

        var noninitial = entry.Snapshot();
        var secondUser = noninitial.History.Last(message => message["role"]?.GetValue<string>() == "user");
        var secondParts = (JsonArray)secondUser["parts"]!;
        Assert.Equal("second", secondParts[0]?["text"]?.GetValue<string>());
        Assert.DoesNotContain(secondParts, part => part?["system"] is not null);
        Assert.True(noninitial.Meta["lastMessageTime"]?.GetValue<long>() > 1);
    }

    [Fact]
    public async Task StopFinalizationPrebuiltFirstConsumesPartsPreparationBoundary()
    {
        var store = new InMemorySessionAuthorityStore();
        var entry = new SessionEntry(new SessionState("s"), store);
        entry.State.Meta["lastMessageTime"] = 42L;
        var prebuilt = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "prebuilt" })
        };
        entry.State.Queue.Add(QueueItem.Prebuilt(prebuilt));
        entry.State.Queue.Add(QueueItem.UserText("later"));
        var host = new LocalSessionTurnHost(entry, store, new ControlledChat());
        Assert.True(await host.TryClaimBusyAsync());
        entry.SetStoppingForTest(true);

        await host.FinalizeStoppedAsync();

        var snapshot = entry.Snapshot();
        var later = snapshot.History.Last(message => message["role"]?.GetValue<string>() == "user");
        var laterParts = (JsonArray)later["parts"]!;
        Assert.Equal("later", laterParts[0]?["text"]?.GetValue<string>());
        Assert.DoesNotContain(laterParts, part => part?["system"] is not null);
        Assert.Equal(42L, snapshot.Meta["lastMessageTime"]?.GetValue<long>());
    }

    [Fact]
    public async Task PrebuiltMessageDoesNotPreparePartsOrChangeTimestamp()
    {
        var store = new InMemorySessionAuthorityStore();
        var registry = NewRegistry(store, new ControlledChat(), out var entry);
        entry.State.Meta["lastMessageTime"] = 42L;
        var prebuilt = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "prebuilt" })
        };
        entry.State.Queue.Add(new QueueItem(QueueItemType.User, Array.Empty<JsonObject>()));
        entry.State.Queue.Add(QueueItem.Prebuilt(prebuilt));

        await registry.Runner.ProcessQueueAsync("s");

        var snapshot = entry.Snapshot();
        var user = snapshot.History.Single(message => message["role"]?.GetValue<string>() == "user");
        Assert.Equal(prebuilt.ToJsonString(), user.ToJsonString());
        Assert.Equal(42, snapshot.Meta["lastMessageTime"]?.GetValue<long>());
    }

    [Fact]
    public async Task ObserverFailureAfterAppendCommitDoesNotRollbackCommittedState()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new ControlledChat();
        var registry = NewRegistry(store, chat, out var entry);
        var once = 0;
        entry.Committed = _ =>
        {
            if (Interlocked.Exchange(ref once, 1) == 0) throw new InvalidOperationException("observer failed");
        };
        entry.State.Queue.Add(QueueItem.UserText("committed"));

        await Assert.ThrowsAsync<InvalidOperationException>(() => registry.Runner.ProcessQueueAsync("s"));

        var hot = entry.Snapshot();
        var stored = await store.LoadAsync("s");
        Assert.NotNull(stored);
        Assert.Contains(hot.History, message => message.ToJsonString().Contains("committed", StringComparison.Ordinal));
        Assert.Contains(stored!.History, message => message.ToJsonString().Contains("committed", StringComparison.Ordinal));
        Assert.Empty(hot.Queue);
        Assert.Empty(stored.Queue);
        Assert.False(hot.Busy);
        Assert.False(stored.Busy);
    }

    [Fact]
    public async Task ObserverFailureAfterStopFinalizationCommitDoesNotRollbackCommittedState()
    {
        var store = new InMemorySessionAuthorityStore();
        var entry = new SessionEntry(new SessionState("s"), store);
        entry.State.Queue.Add(QueueItem.UserText("finalized"));
        var host = new LocalSessionTurnHost(entry, store, new ControlledChat());
        Assert.True(await host.TryClaimBusyAsync());
        entry.SetStoppingForTest(true);
        var once = 0;
        entry.Committed = _ =>
        {
            if (Interlocked.Exchange(ref once, 1) == 0) throw new InvalidOperationException("observer failed");
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() => host.FinalizeStoppedAsync());

        var hot = entry.Snapshot();
        var stored = await store.LoadAsync("s");
        Assert.NotNull(stored);
        Assert.Contains(hot.History, message => message.ToJsonString().Contains("finalized", StringComparison.Ordinal));
        Assert.Contains(stored!.History, message => message.ToJsonString().Contains("finalized", StringComparison.Ordinal));
        Assert.Empty(hot.Queue);
        Assert.Empty(stored.Queue);
        Assert.False(hot.Busy);
        Assert.False(hot.Stopping);
        Assert.False(stored.Busy);
        Assert.False(stored.Stopping);
    }

    [Fact]
    public async Task StopFinalizationStrictFailureRestoresOnlyItsOwnState()
    {
        var store = new AppendFailureProbeStore();
        var entry = new SessionEntry(new SessionState("s"), store);
        entry.State.Queue.Add(QueueItem.UserText("A"));
        var host = new LocalSessionTurnHost(entry, store, new ControlledChat());
        Assert.True(await host.TryClaimBusyAsync());
        var before = entry.Snapshot();
        entry.SetStoppingForTest(true);
        entry.State.Meta["before"] = "kept";
        store.FailStrictCommitNumber(2);

        var finalization = host.FinalizeStoppedAsync();
        await store.HeldStrictAppend;
        entry.WithStateForTest(state =>
        {
            state.Queue.Add(QueueItem.UserText("B"));
            state.Meta["independent"] = "kept";
        });
        entry.SetStoppingForTest(true);

        store.ReleaseHeldStrictAppend();
        await Assert.ThrowsAsync<InvalidOperationException>(() => finalization);

        var snapshot = entry.Snapshot();
        Assert.Equal(new[] { "A", "B" }, snapshot.Queue.Select(item => item.Parts?.FirstOrDefault()?["text"]?.GetValue<string>()));
        Assert.Empty(snapshot.History);
        Assert.True(snapshot.Busy);
        Assert.Equal(before.BusyStartedAt, snapshot.BusyStartedAt);
        Assert.True(snapshot.Stopping);
        Assert.Equal("kept", snapshot.Meta["before"]?.GetValue<string>());
        Assert.Equal("kept", snapshot.Meta["independent"]?.GetValue<string>());
        Assert.Null(snapshot.Meta["lastMessageTime"]);
        Assert.DoesNotContain(snapshot.History, message => message.ToJsonString().Contains("A", StringComparison.Ordinal));
        Assert.DoesNotContain(snapshot.History, message => message.ToJsonString().Contains("B", StringComparison.Ordinal));
    }

    private static SessionRegistry NewRegistry(InMemorySessionAuthorityStore store, ControlledChat chat, out SessionEntry entry)
    {
        var registry = new SessionRegistry(store, chat);
        entry = registry.Add("s");
        return registry;
    }

    private static async Task CaptureTrigger(SessionRegistry registry, string sessionId)
    {
        await registry.Runner.ProcessQueueAsync(sessionId);
    }

    private static string? ClientId(JsonObject message) => message["__meta"]?["clientMessageId"]?.GetValue<string>();
    private static int CountValue(SessionSnapshot snapshot, string value) =>
        snapshot.Queue.Count(item => item.Parts?.FirstOrDefault()?["text"]?.GetValue<string>() == value)
        + snapshot.History.Count(message => message.ToJsonString().Contains($"\"text\":\"{value}\"", StringComparison.Ordinal));
    private static TaskCompletionSource<T> NewSignal<T>() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed class ControlledChat : IChatService
{
    private readonly ConcurrentQueue<Func<string, CancellationToken, Task<string>>> plans = new();
    private readonly ConcurrentQueue<Call> calls = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> startedById = new();
    private readonly object signalGate = new();
    private readonly TaskCompletionSource<bool> started = NewSignal();
    private readonly TaskCompletionSource<bool> cancelled = NewSignal();
    private TaskCompletionSource<bool> callSignal = NewSignal();
    private int pauseNextWaiter;
    private readonly TaskCompletionSource<bool> waiterPausedBeforeSignalGate = NewSignal();
    private readonly TaskCompletionSource<bool> releaseWaiterBeforeSignalGate = NewSignal();
    private TaskCompletionSource<string>? pendingResult;

    public IReadOnlyList<Call> Calls => calls.ToArray();
    public Task Started => started.Task;
    public Task Cancelled => cancelled.Task;
    public Task WaiterPausedBeforeSignalGate => waiterPausedBeforeSignalGate.Task;
    public bool CancellationObserved { get; private set; }

    public void PauseNextCallCountWaiterBeforeSignalGate() => Interlocked.Exchange(ref pauseNextWaiter, 1);
    public void ReleaseCallCountWaiter() => releaseWaiterBeforeSignalGate.TrySetResult(true);

    public void QueueResult(string result) => plans.Enqueue((_, _) => Task.FromResult(result));
    public void QueueFailure(Exception error) => plans.Enqueue((_, _) => Task.FromException<string>(error));
    public void QueueAwaitingResult() => plans.Enqueue(async (_, token) =>
    {
        pendingResult = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = token.Register(() => pendingResult.TrySetCanceled(token));
        return await pendingResult.Task;
    });
    public void QueueAwaitingCancellation() => plans.Enqueue(async (_, token) =>
    {
        try { await Task.Delay(Timeout.InfiniteTimeSpan, token); return "unexpected"; }
        catch (OperationCanceledException) { CancellationObserved = true; cancelled.TrySetResult(true); throw; }
    });
    public void QueuePlan(Func<string, CancellationToken, Task<string>> plan) => plans.Enqueue(plan);
    public void Complete(string result) => pendingResult?.TrySetResult(result);

    public async Task WaitForStarted(string sessionId) => await startedById.GetOrAdd(sessionId, _ => NewSignal()).Task;

    public async Task WaitForCallCount(int count)
    {
        while (true)
        {
            if (calls.Count >= count) return;
            if (Interlocked.Exchange(ref pauseNextWaiter, 0) == 1)
            {
                waiterPausedBeforeSignalGate.TrySetResult(true);
                await releaseWaiterBeforeSignalGate.Task;
            }

            Task signal;
            lock (signalGate)
            {
                if (calls.Count >= count) return;
                signal = callSignal.Task;
            }
            await signal;
        }
    }

    public async Task<string> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        calls.Enqueue(new Call(sessionId, history));
        lock (signalGate)
        {
            callSignal.TrySetResult(true);
            callSignal = NewSignal();
        }
        started.TrySetResult(true);
        startedById.GetOrAdd(sessionId, _ => NewSignal()).TrySetResult(true);
        var plan = plans.TryDequeue(out var queued) ? queued : ((_, _) => Task.FromResult("ok"));
        return await plan(sessionId, cancellationToken);
    }

    public sealed record Call(string SessionId, IReadOnlyList<JsonObject> History);
    private static TaskCompletionSource<bool> NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed class AppendFailureProbeStore : ISessionAuthorityStore
{
    private readonly object gate = new();
    private readonly Dictionary<string, SessionSnapshot> snapshots = new();
    private readonly List<CommitObservation> observations = new();
    private readonly TaskCompletionSource<bool> heldStrictAppend = NewSignal();
    private readonly TaskCompletionSource<bool> releaseHeldStrictAppend = NewSignal();
    private int? failingStrictCommit;
    private int strictCommitCount;

    public Task HeldStrictAppend => heldStrictAppend.Task;

    public IReadOnlyList<CommitObservation> Observations
    {
        get
        {
            lock (gate) return observations.ToArray();
        }
    }

    public void FailNextStrictAppend() => FailStrictCommitNumber(2);
    public void FailStrictCommitNumber(int commitNumber) => failingStrictCommit = commitNumber;
    public void ReleaseHeldStrictAppend() => releaseHeldStrictAppend.TrySetResult(true);

    public async Task CommitAsync(SessionSnapshot snapshot, SaveKind kind, CancellationToken cancellationToken = default)
    {
        CommitObservation observation;
        var holdAndFail = false;
        lock (gate)
        {
            if (kind == SaveKind.Strict && ++strictCommitCount == failingStrictCommit)
            {
                failingStrictCommit = null;
                holdAndFail = true;
            }

            observation = new CommitObservation(
                kind,
                snapshot.Busy,
                snapshot.Stopping,
                QueueValues(snapshot.Queue),
                snapshot.History.Select(message => message.ToJsonString()).ToArray(),
                "started");
            observations.Add(observation);
        }

        if (holdAndFail)
        {
            heldStrictAppend.TrySetResult(true);
            await releaseHeldStrictAppend.Task.WaitAsync(cancellationToken);
            observation.Outcome = "failed";
            throw new InvalidOperationException("planned strict append failure");
        }

        lock (gate)
        {
            snapshots[snapshot.Id] = Clone(snapshot);
            observation.Outcome = "committed";
        }
    }

    public Task<SessionSnapshot?> LoadAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        lock (gate)
        {
            snapshots.TryGetValue(sessionId, out var snapshot);
            return Task.FromResult(snapshot is null ? null : Clone(snapshot));
        }
    }

    private static string[] QueueValues(IEnumerable<QueueItem> items) => items.Select(item =>
        item.Parts?.FirstOrDefault()?["text"]?.GetValue<string>() ?? item.Type.ToString()).ToArray();

    private static SessionSnapshot Clone(SessionSnapshot snapshot) => new(
        snapshot.Id,
        snapshot.History.Select(message => (JsonObject)message.DeepClone()).ToArray(),
        snapshot.Queue.Select(item => item.CloneItem()).ToArray(),
        snapshot.Busy,
        snapshot.BusyStartedAt,
        snapshot.Stopping,
        (JsonObject)snapshot.Meta.DeepClone());

    private static TaskCompletionSource<bool> NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public sealed class CommitObservation
    {
        public CommitObservation(SaveKind kind, bool busy, bool stopping, string[] queue, string[] history, string outcome)
        {
            Kind = kind;
            Busy = busy;
            Stopping = stopping;
            Queue = queue;
            History = history;
            Outcome = outcome;
        }

        public SaveKind Kind { get; }
        public bool Busy { get; }
        public bool Stopping { get; }
        public string[] Queue { get; }
        public string[] History { get; }
        public string Outcome { get; set; }
    }
}

internal static class SessionEntryTestExtensions
{
    public static void WithStateForTest(this SessionEntry entry, Action<SessionState> action)
    {
        var gate = entry.StateGate;
        lock (gate) action(entry.State);
    }
}
