using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class SessionShutdownTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(5);

    [Theory]
    [InlineData("none")]
    [InlineData("stop")]
    [InlineData("runQueued")]
    public async Task Normal_manager_shutdown_cancels_foreground_pure_VM_work_after_grace(
        string priorControl
    )
    {
        if (!Foxwarm.ToolScript.MontyWorker.IsSupported)
            return;
        using var temp = new TempDirectory();
        var marker = Path.Combine(temp.Path, "vm-entered");
        var script =
            "call_tool('write', {'filePath': "
            + JsonSerializer.Serialize(marker)
            + ", 'content': 'ready'})\nwhile True:\n    pass\n";
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (context, _) =>
            {
                var call = new JsonObject
                {
                    ["type"] = "function_call",
                    ["id"] = "fc_loop",
                    ["call_id"] = "loop",
                    ["name"] = "run_script",
                    ["arguments"] = new JsonObject
                    {
                        ["code"] = script,
                        ["timeoutSecs"] = 30,
                    }.ToJsonString(),
                };
                await context.Send(ResponsesPrefixCommitTests.Done(0, call));
                await context.Send(ResponsesPrefixCommitTests.Completed(call));
            }
        );
        var options = new ResponsesClientOptions(
            peer.Uri,
            "offline",
            "fixture/offline",
            "",
            "",
            713
        );
        var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        Task? processing = null;
        try
        {
            await manager.LoadMainHostAsync();
            var owner = await manager.CreateNamedAsync("main", "pure-vm-shutdown", null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.UserText("Run pure VM work.")
            );
            processing = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
            using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
                while (!File.Exists(marker))
                    await Task.Delay(10, deadline.Token);
            // Allow the completed marker write to resume into native computation.
            await Task.Delay(100);
            if (priorControl == "runQueued")
            {
                await owner.Registry.Ingress.EnqueueAsync(
                    owner.Id,
                    QueueItem.UserText("Keep queued for restart.")
                );
                await owner.Registry.Control.DequeueAsync(owner.Id);
            }
            else if (priorControl == "stop")
                await owner.Registry.Control.StopAsync(owner.Id);
            if (priorControl != "none")
            {
                // Ordinary foreground control is not pure-VM preemption.
                await Task.Delay(100);
                Assert.False(processing.IsCompleted);
            }
            await manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(15));
            await processing;
            Assert.Equal(priorControl == "none", owner.Entry.ShutdownCancellationRequested);
            Assert.Equal(0, owner.Entry.BackgroundProcessorFailureCount);
            Assert.Single(peer.Requests);
            var run = Assert.Single(
                await manager.ToolScript.Store.ListAsync(owner.Id, 10, null, default)
            );
            Assert.Equal("cancelled", run["status"]!.GetValue<string>());
            Assert.Equal("ready", await File.ReadAllTextAsync(marker));
            Assert.Equal(priorControl == "runQueued" ? 1 : 0, owner.Entry.Snapshot().Queue.Count);
        }
        finally
        {
            // Retire the owned worker even if a regression leaves the foreground drain failed.
            manager.ToolScript.BeginShutdown();
            if (processing is not null)
                await processing.WaitAsync(Deadline);
            try
            {
                await manager.DisposeAsync();
            }
            catch (SessionTurnDrainException) { }
        }
    }

    [Fact]
    public async Task Normal_manager_shutdown_keeps_an_accepted_script_timer_independent_of_foreground_cancellation()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var marker = Path.Combine(temp.Path, "vm-entered");
        var timerReady = Path.Combine(temp.Path, "timer-entered");
        var timerRelease = Path.Combine(temp.Path, "timer-release");
        var timerEffect = Path.Combine(temp.Path, "timer-effect");
        var script =
            "call_tool('write', {'filePath': "
            + JsonSerializer.Serialize(marker)
            + ", 'content':'ready'})\nwhile True:\n    pass\n";
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (context, _) =>
            {
                var call = new JsonObject
                {
                    ["type"] = "function_call",
                    ["id"] = "fc_loop",
                    ["call_id"] = "loop",
                    ["name"] = "run_script",
                    ["arguments"] = new JsonObject
                    {
                        ["code"] = script,
                        ["timeoutSecs"] = 30,
                    }.ToJsonString(),
                };
                await context.Send(ResponsesPrefixCommitTests.Done(0, call));
                await context.Send(ResponsesPrefixCommitTests.Completed(call));
            }
        );
        var options = new ResponsesClientOptions(
            peer.Uri,
            "offline",
            "fixture/offline",
            "",
            "",
            713
        );
        var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        Task? running = null;
        try
        {
            await manager.LoadMainHostAsync();
            var owner = await manager.CreateNamedAsync("main", "timer-shutdown", null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            await owner.Registry.Ingress.EnqueueAsync(
                owner.Id,
                QueueItem.UserText("Run pure VM work.")
            );
            running = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
            await Until(() => File.Exists(marker));
            var command =
                $"printf ready > '{timerReady}'; for n in $(seq 1 500); do test -f '{timerRelease}' && break; sleep 0.02; done";
            var timer = await manager.ExecuteTimerToolAsync(
                owner,
                "create_timer",
                new JsonObject
                {
                    ["action"] = "toolscript",
                    ["afterSeconds"] = .03,
                    ["script"] = new JsonObject
                    {
                        ["code"] =
                            "call_tool('exec', {'command': "
                            + JsonSerializer.Serialize(command)
                            + ", 'timeout': 10})\ncall_tool('write', {'filePath': "
                            + JsonSerializer.Serialize(timerEffect)
                            + ", 'content': 'independent'})\nreturn 'independent timer'\n",
                    },
                },
                default
            );
            Assert.Null(timer["error"]);
            manager.Timers.Start();
            await Until(() => File.Exists(timerReady));
            var shutdown = manager.ShutdownAsync();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(owner.Entry.ShutdownCancellationRequested);
            Assert.False(shutdown.IsCompleted);
            Assert.False(File.Exists(timerEffect));
            await File.WriteAllTextAsync(timerRelease, "release");
            await shutdown.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("independent", await File.ReadAllTextAsync(timerEffect));
            var runs = await manager.ToolScript.Store.ListAsync(owner.Id, 10, null, default);
            Assert.Equal(2, runs.Count);
            Assert.Single(runs, row => row["status"]?.ToString() == "cancelled");
            var completed = Assert.Single(runs, row => row["status"]?.ToString() == "completed");
            Assert.Equal("independent timer", completed["lastResult"]!.GetValue<string>());
            Assert.Single(peer.Requests);
        }
        finally
        {
            await File.WriteAllTextAsync(timerRelease, "release");
            manager.ToolScript.BeginShutdown();
            if (running is not null)
                await running.WaitAsync(TimeSpan.FromSeconds(5));
            try
            {
                await manager.DisposeAsync();
            }
            catch (SessionTurnDrainException) { }
        }
    }

    private static async Task Until(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition())
            await Task.Delay(10, deadline.Token);
    }

    [Fact]
    public async Task Interrupted_provider_preserves_busy_and_unconsumed_input_without_a_terminal_error()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new FakeChatService();
        chat.EnqueuePlan(async token =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return "unreachable";
        });
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("seed", clientMessageId: "seed")
        );
        var processing = registry.Runner.ProcessQueueAsync("s");
        await chat.FirstCallStarted.Task.WaitAsync(Deadline);
        await registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("later", clientMessageId: "later")
        );
        await registry.Runner.ShutdownAsync(TimeSpan.Zero, Deadline);
        await processing;
        var snapshot = (await store.LoadAsync("s"))!;
        Assert.True(snapshot.Busy);
        Assert.False(snapshot.Stopping);
        Assert.Equal("later", Assert.Single(snapshot.Queue).ClientMessageId);
        Assert.Single(snapshot.History);
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
        Assert.True(entry.ShutdownCancellationRequested);
        await registry.Runner.ProcessQueueAsync("s");
        await Assert.ThrowsAsync<SessionTurnShutdownException>(() =>
            registry.Runner.ProcessQueueAsync("s", retry: true)
        );
        Assert.Single(chat.Calls);
        Assert.Equal(1, entry.ProcessorClaimCount);
    }

    [Fact]
    public async Task A_real_final_settling_during_closure_is_terminal_even_with_later_input()
    {
        var release = Signal();
        var chat = new FakeChatService();
        chat.EnqueuePlan(async _ =>
        {
            await release.Task;
            return "actual final";
        });
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("seed"));
        var processing = registry.Runner.ProcessQueueAsync("s");
        await chat.FirstCallStarted.Task.WaitAsync(Deadline);
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("later"));
        var shutdown = registry.Runner.ShutdownAsync(Deadline, Deadline);
        Assert.False(shutdown.IsCompleted);
        release.TrySetResult();
        await shutdown;
        await processing;
        var snapshot = (await store.LoadAsync("s"))!;
        Assert.False(snapshot.Busy);
        Assert.Single(snapshot.Queue);
        Assert.Equal(
            "actual final",
            snapshot.History.Materialize()[^1]["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
        Assert.Single(chat.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Launched_tools_settle_with_complete_pairs_and_unstarted_calls_do_not_execute(
        bool terminal
    )
    {
        var tools = new HeldTools(terminal);
        var chat = new CallsChat(terminal ? 1 : 2);
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, chat, tools);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("seed"));
        var processing = registry.Runner.ProcessQueueAsync("s");
        await tools.Started.Task.WaitAsync(Deadline);
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("later"));
        var shutdown = registry.Runner.ShutdownAsync(TimeSpan.Zero, Deadline);
        await tools.Cancelled.Task.WaitAsync(Deadline);
        Assert.False(shutdown.IsCompleted);
        tools.Release.TrySetResult();
        await shutdown;
        await processing;
        Assert.Equal(1, tools.Effects);
        Assert.Equal(1, tools.Completions);
        Assert.Equal(1, tools.Invocations);
        var snapshot = (await store.LoadAsync("s"))!;
        Assert.Equal(!terminal, snapshot.Busy);
        Assert.Single(snapshot.Queue);
        var rows = snapshot.History.Materialize();
        Assert.Equal(3, rows.Length);
        Assert.Equal("model", rows[1]["role"]!.GetValue<string>());
        Assert.Equal("tool", rows[2]["role"]!.GetValue<string>());
        Assert.Equal(terminal ? 1 : 2, rows[2]["parts"]!.AsArray().Count);
        Assert.Equal(
            "committed effect",
            rows[2]["parts"]![0]!["functionResponse"]!["response"]!["output"]!.GetValue<string>()
        );
        if (!terminal)
        {
            var skipped = rows[2]["parts"]![1]!["functionResponse"]!;
            Assert.Equal("call-1", skipped["tool_use_id"]!.GetValue<string>());
            Assert.Contains(
                "not started because process shutdown",
                skipped["response"]!.ToJsonString()
            );
        }
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
        Assert.Equal(1, chat.Invocations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Concurrent_explicit_Stop_is_terminal_but_RunQueued_keeps_later_work_for_restart(
        bool runQueued
    )
    {
        var chat = new FakeChatService();
        var release = Signal();
        chat.EnqueuePlan(async token =>
        {
            await release.Task;
            token.ThrowIfCancellationRequested();
            return "unreachable";
        });
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("seed"));
        var processing = registry.Runner.ProcessQueueAsync("s");
        await chat.FirstCallStarted.Task.WaitAsync(Deadline);
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("later"));
        registry.Runner.CloseAdmission();
        if (runQueued)
            await registry.Control.DequeueAsync("s");
        else
            await registry.Control.StopAsync("s");
        var shutdown = registry.Runner.ShutdownAsync(Deadline, Deadline);
        release.TrySetResult();
        await shutdown;
        await processing;
        var snapshot = (await store.LoadAsync("s"))!;
        Assert.False(snapshot.Stopping);
        Assert.False(snapshot.Meta.ContainsKey("runQueuedAfterStop"));
        Assert.Equal(runQueued, snapshot.Busy);
        Assert.Equal(runQueued ? 1 : 0, snapshot.Queue.Count);
        Assert.Equal(runQueued ? 1 : 2, snapshot.History.Count);
        Assert.Single(chat.Calls);
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
    }

    [Fact]
    public async Task Closure_during_preselection_save_does_not_consume_input_or_start_a_provider()
    {
        var store = new InMemorySessionAuthorityStore();
        var chat = new FakeChatService();
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("unselected"));
        var selecting = Signal();
        registry.OnTurnStarting = _ =>
        {
            store.ResetCommitSignal("s");
            store.Hold("s");
            selecting.TrySetResult();
            return Task.CompletedTask;
        };
        var processing = registry.Runner.ProcessQueueAsync("s");
        await selecting.Task.WaitAsync(Deadline);
        await store.WaitForCommitAsync("s").WaitAsync(Deadline);
        var shutdown = registry.Runner.ShutdownAsync(Deadline, Deadline);
        store.Release("s");
        await shutdown;
        await processing;
        Assert.Empty(chat.Calls);
        var snapshot = (await store.LoadAsync("s"))!;
        Assert.False(snapshot.Busy);
        Assert.Empty(snapshot.History);
        Assert.Single(snapshot.Queue);
        Assert.Equal(1, entry.ProcessorClaimCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Selected_canonical_append_settles_before_interrupted_owner_yields(
        bool explicitStop
    )
    {
        var store = new HeldAppendStore();
        var chat = new FakeChatService();
        var registry = new SessionRegistry(store, chat);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("selected", clientMessageId: "selected")
        );
        var processing = registry.Runner.ProcessQueueAsync("s");
        await store.Appending.Task.WaitAsync(Deadline);
        var stop = explicitStop ? registry.Control.StopAsync("s") : Task.CompletedTask;
        var shutdown = registry.Runner.ShutdownAsync(Deadline, Deadline);
        Assert.False(shutdown.IsCompleted);
        store.Release.TrySetResult();
        await shutdown;
        await processing;
        await stop;
        var snapshot = (await store.LoadAsync("s"))!;
        Assert.Equal(!explicitStop, snapshot.Busy);
        Assert.False(snapshot.Stopping);
        Assert.Empty(snapshot.Queue);
        Assert.Single(snapshot.History);
        Assert.Empty(chat.Calls);
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
    }

    [Fact]
    public async Task Cancellation_ignoring_owner_causes_a_failed_drain_not_a_false_settlement()
    {
        var chat = new FakeChatService();
        var release = Signal();
        chat.EnqueuePlan(async _ =>
        {
            await release.Task;
            return "late actual final";
        });
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, chat);
        var entry = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("seed"));
        var processing = registry.Runner.ProcessQueueAsync("s");
        await chat.FirstCallStarted.Task.WaitAsync(Deadline);
        var shutdown = registry.Runner.ShutdownAsync(TimeSpan.Zero, TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAsync<SessionTurnDrainException>(() => shutdown);
        Assert.False(processing.IsCompleted);
        Assert.True(entry.Snapshot().Busy);
        Assert.True(entry.ShutdownCancellationRequested);
        Assert.Same(shutdown, registry.Runner.ShutdownAsync());
        release.TrySetResult();
        await processing.WaitAsync(Deadline);
        Assert.False(entry.Snapshot().Busy);
        Assert.Equal(2, entry.Snapshot().History.Count);
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_wait_or_finish_handoff_settles_its_pair_and_terminal_state_before_manager_teardown(
        bool handoff
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "sender", null, null);
        var target = await manager.CreateNamedAsync("main", "target", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        IEnumerable<JsonObject> definitions = handoff
            ? AgentToolDefinitions.Definitions()
            : [WaitToolDefinitions.Definition()];
        var registry = SessionToolExecutor.CreateRegistry(
            new JsonArray(definitions.Select(value => (JsonNode)value.DeepClone()).ToArray()),
            manager.OutboundMcp,
            _ => work,
            manager.Nodes
        );
        var actual = new SessionToolExecutor(
            manager.IdentityWorkspace(owner),
            owner,
            manager,
            registry
        );
        var held = new SettledTools(actual);
        var args = handoff
            ? new JsonObject
            {
                ["sessionId"] = target.Id,
                ["message"] = "actual committed handoff",
                ["afterSend"] = "finish",
            }
            : new JsonObject { ["waitForInput"] = true };
        var chat = new CallsChat(1, handoff ? "send_to_session" : "wait", args);
        var entry = owner.Entry;
        var turns = new SessionRegistry(owner.AuthorityStore, chat, held);
        turns.BindIdentity(owner.Id, entry);
        owner.Registry = turns;
        turns.TriggerOverride = _ => owner.StartProcessing();
        try
        {
            await turns.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("seed"));
            await held.Settled.Task.WaitAsync(Deadline);
            if (handoff)
                Assert.Contains(
                    "actual committed handoff",
                    Assert.Single(target.Entry.Snapshot().Queue).Parts![0].ToJsonString()
                );
            else
                Assert.NotNull(SessionWait.Current(entry.Snapshot().Meta));
            var shutdown = manager.ShutdownAsync();
            Assert.False(shutdown.IsCompleted);
            held.Release.TrySetResult();
            await shutdown.WaitAsync(Deadline);
            var saved = (await owner.AuthorityStore.LoadAsync(owner.Id))!;
            Assert.False(saved.Busy);
            Assert.False(saved.Stopping);
            Assert.Equal(3, saved.History.Count);
            var rows = saved.History.Materialize();
            Assert.Equal(
                "call-0",
                rows[^1]["parts"]![0]!["functionResponse"]!["tool_use_id"]!.GetValue<string>()
            );
            Assert.Null(rows[^1]["parts"]![0]!["functionResponse"]!["response"]!["error"]);
            Assert.Equal(0, entry.BackgroundProcessorFailureCount);
            Assert.Equal(1, chat.Invocations);
            if (!handoff)
                Assert.NotNull(SessionWait.Current(saved.Meta));
        }
        finally
        {
            held.Release.TrySetResult();
        }
    }

    [Fact]
    public async Task Accepted_turn_scope_does_not_make_busy_deletion_wait_before_sending_Stop()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "busy-target", null, null);
        var entry = owner.Entry;
        var chat = new FakeChatService();
        chat.EnqueuePlan(async token =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return "unreachable";
        });
        var turns = new SessionRegistry(owner.AuthorityStore, chat);
        turns.BindIdentity(owner.Id, entry);
        owner.Registry = turns;
        turns.TriggerOverride = _ => owner.StartProcessing();
        await turns.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("seed"));
        await chat.FirstCallStarted.Task.WaitAsync(Deadline);
        var result = await manager.DeleteAsync(owner.Id).WaitAsync(Deadline);
        Assert.Equal("busy", result["status"]!.GetValue<string>());
        Assert.Equal(1, result["abortedInFlightCount"]!.GetValue<int>());
        await owner.DrainForegroundAsync().WaitAsync(Deadline);
        Assert.False(entry.Snapshot().Busy);
        Assert.NotNull(manager.Catalog.Get(owner.Id));
        Assert.Equal(0, entry.BackgroundProcessorFailureCount);
    }

    private sealed class SettledTools(SessionToolExecutor actual)
        : ITurnToolExecutor,
            ITurnToolControl
    {
        internal readonly TaskCompletionSource Settled = Signal(),
            Release = Signal();

        public void BeginTurn() => actual.BeginTurn();

        public bool ConsumeFinishAfterBatch() => actual.ConsumeFinishAfterBatch();

        public Task<TurnBatchEnding> CompleteBatchAsync(JsonObject message, bool stopping) =>
            actual.CompleteBatchAsync(message, stopping);

        public async Task<JsonNode?> ExecuteAsync(JsonObject call, CancellationToken token)
        {
            var result = await actual.ExecuteAsync(call, token);
            Settled.TrySetResult();
            await Release.Task;
            return result;
        }
    }

    private sealed class CallsChat(int calls, string name = "write", JsonObject? args = null)
        : IChatService
    {
        internal int Invocations;

        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        )
        {
            Invocations++;
            return Task.FromResult(
                new ChatResult(
                    new JsonObject
                    {
                        ["role"] = "model",
                        ["parts"] = new JsonArray(
                            Enumerable
                                .Range(0, calls)
                                .Select(index =>
                                    (JsonNode)
                                        new JsonObject
                                        {
                                            ["functionCall"] = new JsonObject
                                            {
                                                ["id"] = "call-" + index,
                                                ["name"] = name,
                                                ["args"] = args?.DeepClone() ?? new JsonObject(),
                                            },
                                        }
                                )
                                .ToArray()
                        ),
                    }
                )
            );
        }
    }

    private sealed class HeldTools(bool terminal) : ITurnToolExecutor, ITurnToolControl
    {
        internal readonly TaskCompletionSource Started = Signal(),
            Cancelled = Signal(),
            Release = Signal();
        internal int Effects,
            Completions,
            Invocations;

        public void BeginTurn() { }

        public bool ConsumeFinishAfterBatch() => terminal;

        public async Task<JsonNode?> ExecuteAsync(JsonObject call, CancellationToken token)
        {
            Invocations++;
            Effects++;
            Started.TrySetResult();
            using var registration = token.Register(() => Cancelled.TrySetResult());
            // A completed effect must retain its actual result even after cancellation.
            await Release.Task;
            Completions++;
            return new JsonObject { ["output"] = "committed effect" };
        }
    }

    private sealed class HeldAppendStore : ISessionAuthorityStore, ICanonicalAppendAuthorityStore
    {
        private readonly InMemorySessionAuthorityStore inner = new();
        internal readonly TaskCompletionSource Appending = Signal(),
            Release = Signal();

        public Task CommitAsync(
            SessionSnapshot value,
            SaveKind kind,
            CancellationToken token = default
        ) => inner.CommitAsync(value, kind, token);

        public Task<SessionSnapshot?> LoadAsync(string id, CancellationToken token = default) =>
            inner.LoadAsync(id, token);

        public async Task CommitCanonicalAppendAsync(
            SessionSnapshot value,
            IReadOnlyList<JsonObject> rows,
            CancellationToken token = default
        )
        {
            Appending.TrySetResult();
            await Release.Task;
            await inner.CommitCanonicalAppendAsync(value, rows, token);
        }
    }
}
