using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// Background run_script: wait like exec, then detach and report the outcome as an event.
public sealed class ToolScriptBackgroundTests
{
    private static bool Supported => OperatingSystem.IsLinux() && MontyWorker.IsSupported;

    private static async Task<JsonObject> Call(
        ScriptFixture f,
        string name,
        JsonObject args,
        CancellationToken token = default
    ) =>
        (
            await f.Tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "background-script",
                    ["name"] = name,
                    ["args"] = args.DeepClone(),
                },
                token
            )
        )!.AsObject();

    private static JsonObject Background(string code, double? timeoutSecs = 1)
    {
        var args = new JsonObject { ["code"] = code, ["mode"] = "background" };
        if (timeoutSecs is double seconds)
            args["timeoutSecs"] = seconds;
        return args;
    }

    // A nested exec that blocks until the test creates the release file.
    private static string Blocking(string release) =>
        "call_tool('exec', {'command': "
        + JsonSerializer.Serialize(
            $"for n in $(seq 1 1500); do test -f '{release}' && break; sleep 0.02; done"
        )
        + ", 'timeout': 60})\n";

    private static string Directory(ScriptFixture f) =>
        f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;

    private static async Task<QueueItem> Event(SessionOwner owner, string runId)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (true)
        {
            var item = owner.Entry.WithState(state =>
                state.Queue.FirstOrDefault(value =>
                    SessionWait.Text(value.OpenFields?["execId"]) == runId
                )
            );
            if (item is not null)
                return item;
            await Task.Delay(20, deadline.Token);
        }
    }

    private static string Text(QueueItem item) => item.Parts![0]["system"]!.GetValue<string>();

    private static int Events(SessionOwner owner, string runId) =>
        owner.Entry.WithState(state =>
            state.Queue.Count(value => SessionWait.Text(value.OpenFields?["execId"]) == runId)
        );

    private static async Task Until(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!condition())
            await Task.Delay(20, deadline.Token);
    }

    [Fact]
    public async Task A_run_finishing_within_the_wait_returns_inline_without_an_event()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var result = await Call(f, "run_script", Background("print('hi')\nreturn {'n': 2}", 10));
        Assert.Equal("completed", SessionWait.Text(result["status"]));
        Assert.Equal(2, result["result"]!["n"]!.GetValue<int>());
        Assert.Equal("hi\n", SessionWait.Text(result["stdout"]));
        Assert.False(result.ContainsKey("notice"));
        var runId = SessionWait.Text(result["runId"])!;
        Assert.False(f.Manager.ToolScript.IsDetached(f.Owner.Id, runId));
        await Task.Delay(100);
        Assert.Equal(0, Events(f.Owner, runId));
    }

    [Fact]
    public async Task A_longer_run_detaches_runs_past_its_wait_and_reports_completion_once()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var release = Path.Combine(Directory(f), "release");
        var after = Path.Combine(Directory(f), "after");
        var started = DateTimeOffset.UtcNow;
        var receipt = await Call(
            f,
            "run_script",
            Background(
                "print('before')\n"
                    + Blocking(release)
                    + "call_tool('write', {'filePath': "
                    + JsonSerializer.Serialize(after)
                    + ", 'content': 'x'})\nprint('after')\nreturn {'done': True}\n"
            )
        );
        Assert.True(DateTimeOffset.UtcNow - started < TimeSpan.FromSeconds(10));
        Assert.Equal("running", SessionWait.Text(receipt["status"]));
        Assert.Equal("before\n", SessionWait.Text(receipt["stdout"]));
        Assert.NotNull(receipt["notice"]);
        var runId = SessionWait.Text(receipt["runId"])!;
        Assert.True(f.Manager.ToolScript.IsDetached(f.Owner.Id, runId));
        // The run ID is an ordinary wait source of its owner only.
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        Assert.Throws<InvalidDataException>(() =>
            f.Manager.ValidateWait(other, new JsonObject { ["waitExecIds"] = new JsonArray(runId) })
        );
        await f.Manager.DeclareWaitAsync(
            f.Owner,
            new JsonObject
            {
                ["waitExecIds"] = new JsonArray(runId),
                ["wakeIfNoActivityAfterSeconds"] = null,
            }
        );
        Assert.NotNull(f.Owner.WaitSnapshot());
        await File.WriteAllTextAsync(release, "go");
        var completion = await Event(f.Owner, runId);
        var text = Text(completion);
        Assert.Contains("type=\"background-script-finished\"", text);
        Assert.Contains("runId: " + runId, text);
        Assert.Contains("status: completed", text);
        Assert.Contains("result: {\"done\":true}", text);
        Assert.True(File.Exists(after));
        Assert.Null(f.Owner.WaitSnapshot());
        // The wait limit is not a time budget: the run did not pause at a checkpoint.
        var record = await Call(f, "get_toolscript_run", new JsonObject { ["runId"] = runId });
        Assert.Equal("completed", SessionWait.Text(record["status"]));
        Assert.Equal("before\nafter\n", SessionWait.Text(record["stdout"]));
        await Until(() => !f.Manager.ToolScript.IsDetached(f.Owner.Id, runId));
        await Task.Delay(100);
        Assert.Equal(1, Events(f.Owner, runId));
        // A queued completion remains a valid wait source.
        f.Manager.ValidateWait(f.Owner, new JsonObject { ["waitExecIds"] = new JsonArray(runId) });
    }

    [Fact]
    public async Task Stop_during_the_wait_ends_only_the_wait_and_the_next_nested_call_runs()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var release = Path.Combine(Directory(f), "release");
        var after = Path.Combine(Directory(f), "after");
        using var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        var started = DateTimeOffset.UtcNow;
        var receipt = await Call(
            f,
            "run_script",
            Background(
                Blocking(release)
                    + "call_tool('write', {'filePath': "
                    + JsonSerializer.Serialize(after)
                    + ", 'content': 'x'})\nreturn 'written'\n",
                60
            ),
            stop.Token
        );
        Assert.True(DateTimeOffset.UtcNow - started < TimeSpan.FromSeconds(20));
        Assert.Equal("running", SessionWait.Text(receipt["status"]));
        var runId = SessionWait.Text(receipt["runId"])!;
        await File.WriteAllTextAsync(release, "go");
        var text = Text(await Event(f.Owner, runId));
        Assert.Contains("status: completed", text);
        Assert.Contains("result: written", text);
        Assert.True(File.Exists(after));
    }

    [Fact]
    public async Task Session_Stop_while_a_model_turn_waits_leaves_the_run_and_its_next_call_running()
    {
        if (!Supported)
            return;
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        string? code = null;
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (ctx, number) =>
            {
                var item =
                    number == 1
                        ? new JsonObject
                        {
                            ["type"] = "function_call",
                            ["id"] = "fc_script",
                            ["call_id"] = "script",
                            ["name"] = "run_script",
                            ["arguments"] = new JsonObject
                            {
                                ["code"] = code,
                                ["mode"] = "background",
                                ["timeoutSecs"] = 60,
                            }.ToJsonString(),
                        }
                        : new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "final_answer",
                            ["status"] = "completed",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                            ),
                        };
                await ctx.Send(ResponsesPrefixCommitTests.Done(0, item));
                await ctx.Send(ResponsesPrefixCommitTests.Completed(item));
            }
        );
        var models = Foxwarm.Models.HostModels.Parse(
            new JsonObject
            {
                ["default"] = "fixture/offline",
                ["providers"] = new JsonObject
                {
                    ["fixture"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.Uri.ToString(),
                        ["models"] = new JsonArray("offline"),
                    },
                },
            },
            new JsonObject()
        );
        var defaults = new Foxwarm.Models.ResponsesClientOptions(
            peer.Uri,
            "offline",
            "fixture/offline",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(root, work, defaults, models);
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "background-stop", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var toolWork = manager.IdentityWorkspace(owner)!.ToolDirectory;
        var ready = Path.Combine(toolWork, "launched");
        var release = Path.Combine(toolWork, "release");
        var after = Path.Combine(toolWork, "after");
        code =
            "call_tool('exec', {'command': "
            + JsonSerializer.Serialize(
                $"printf x > '{ready}'; for n in $(seq 1 1500); do test -f '{release}' && break; sleep 0.02; done"
            )
            + ", 'timeout': 60})\ncall_tool('write', {'filePath': "
            + JsonSerializer.Serialize(after)
            + ", 'content': 'x'})\nreturn 'written'\n";
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Start it."));
        var running = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        await Until(() => File.Exists(ready));
        await owner.Registry.Control.StopAsync(owner.Id);
        await running.WaitAsync(TimeSpan.FromSeconds(20));
        var outer = owner
            .History()
            .SelectMany(row => row["parts"]!.AsArray())
            .Select(part => part?["functionResponse"])
            .OfType<JsonObject>()
            .Single(response => response["name"]?.GetValue<string>() == "run_script");
        Assert.Equal("running", outer["response"]!["status"]!.GetValue<string>());
        var runId = outer["response"]!["runId"]!.GetValue<string>();
        Assert.False(owner.Entry.Snapshot().Busy);
        await File.WriteAllTextAsync(release, "go");
        var text = Text(await Event(owner, runId));
        Assert.Contains("status: completed", text);
        Assert.Contains("result: written", text);
        Assert.True(File.Exists(after));
        var record = await manager.ToolScript.Store.ReadAsync(runId, default);
        Assert.Equal(
            ["exec", "write"],
            record!["executedTools"]!.AsArray().Select(value => value!.GetValue<string>())
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_detached_run_cannot_end_or_suspend_the_turn_that_started_it(bool detach)
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var item in ToolScriptToolDefinitions.Definitions().Concat(UnifiedToolDefinitions.All())
        )
            definitions.Add(item?.DeepClone());
        foreach (var item in LocalExecManager.Definitions())
            definitions.Add(item?.DeepClone());
        foreach (var item in AgentToolDefinitions.Definitions())
            definitions.Add(item?.DeepClone());
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work)
        );
        tools.BeginTurn();
        var target = await f.Manager.CreateNamedAsync("main", "target", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        var release = Path.Combine(Directory(f), "release");
        if (!detach)
            await File.WriteAllTextAsync(release, "go");
        var receipt = (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "handoff-script",
                    ["name"] = "run_script",
                    ["args"] = Background(
                        Blocking(release)
                            + "return call_tool('send_to_session', {'sessionId': "
                            + JsonSerializer.Serialize(target.Id)
                            + ", 'message': 'report', 'currentSessionTurnAction': 'end_turn'})\n",
                        detach ? 1 : 30
                    ),
                },
                default
            )
        )!.AsObject();
        if (detach)
        {
            Assert.Equal("running", SessionWait.Text(receipt["status"]));
            await File.WriteAllTextAsync(release, "go");
            var text = Text(await Event(f.Owner, SessionWait.Text(receipt["runId"])!));
            Assert.Contains("status: completed", text);
        }
        else
            Assert.Equal("completed", SessionWait.Text(receipt["status"]));
        Assert.Contains(
            target.Entry.Snapshot().Queue,
            item => JsonSerializer.Serialize(item).Contains("report", StringComparison.Ordinal)
        );
        Assert.Equal(!detach, tools.ConsumeFinishAfterBatch());
    }

    [Fact]
    public async Task Explicit_cancellation_ends_a_detached_run_and_reports_it()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        // Pure computation outlasting the wait: a detached run has no execution-time budget.
        var receipt = await Call(f, "run_script", Background("while True:\n    pass\n"));
        Assert.Equal("running", SessionWait.Text(receipt["status"]));
        var runId = SessionWait.Text(receipt["runId"])!;
        await Task.Delay(1500);
        Assert.True(
            f.Manager.ToolScript.IsDetached(f.Owner.Id, runId),
            (await f.Manager.ToolScript.Store.ReadAsync(runId, default))?.ToJsonString()
        );
        var cancel = await Call(f, "cancel_toolscript_run", new JsonObject { ["runId"] = runId });
        Assert.True(cancel["cancellationRequested"]!.GetValue<bool>());
        var text = Text(await Event(f.Owner, runId));
        Assert.Contains("status: cancelled", text);
        var record = await f.Manager.ToolScript.Store.ReadAsync(runId, default);
        Assert.Equal("cancelled", SessionWait.Text(record!["status"]));
    }

    [Fact]
    public async Task An_ask_agent_pause_after_detaching_is_reported_and_continues_in_background_mode()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var release = Path.Combine(Directory(f), "release");
        var receipt = await Call(
            f,
            "run_script",
            Background(
                Blocking(release) + "answer = ask_agent('Which one?')\nreturn 'got ' + answer\n"
            )
        );
        var runId = SessionWait.Text(receipt["runId"])!;
        Assert.Equal("running", SessionWait.Text(receipt["status"]));
        await File.WriteAllTextAsync(release, "go");
        var text = Text(await Event(f.Owner, runId));
        Assert.Contains("type=\"background-script-waiting\"", text);
        Assert.Contains("status: waiting", text);
        Assert.Contains("question: Which one?", text);
        var record = await f.Manager.ToolScript.Store.ReadAsync(runId, default);
        var continuation = SessionWait.Text(record!["waiting"]!["continuationId"])!;
        Assert.Contains("continuationId: " + continuation, text);
        var resumed = await Call(
            f,
            "continue_script",
            new JsonObject
            {
                ["runId"] = runId,
                ["continuationId"] = continuation,
                ["input"] = "B",
            }
        );
        Assert.Equal("completed", SessionWait.Text(resumed["status"]));
        Assert.Equal("got B", SessionWait.Text(resumed["result"]));
        await Task.Delay(100);
        Assert.Equal(1, Events(f.Owner, runId));
    }

    [Fact]
    public async Task Unattended_background_slices_keep_the_time_budget_pause()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        // Timer and webhook scripts share this owner-bound unattended path.
        var result = await f.Manager.RunWebhookScriptAsync(
            f.Owner.Id,
            MainToolScript.NormalizeStartArgs(
                new JsonObject
                {
                    ["code"] =
                        "call_tool('exec', {'command': 'sleep 1.5', 'timeout': 10})\nreturn 1\n",
                    ["mode"] = "background",
                    ["timeoutSecs"] = 1,
                }
            )
        );
        Assert.Equal("waiting", SessionWait.Text(result!["status"]));
        Assert.Equal("timeout", SessionWait.Text(result["waitingReason"]));
        var runId = SessionWait.Text(result["runId"])!;
        await Task.Delay(100);
        Assert.Equal(0, Events(f.Owner, runId));
    }

    [Fact]
    public async Task Foreground_mode_keeps_the_time_budget_pause()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var result = await Call(
            f,
            "run_script",
            new JsonObject
            {
                ["code"] = "call_tool('exec', {'command': 'sleep 1.5', 'timeout': 10})\nreturn 1\n",
                ["timeoutSecs"] = 1,
            }
        );
        Assert.Equal("waiting", SessionWait.Text(result["status"]));
        Assert.Equal("timeout", SessionWait.Text(result["waitingReason"]));
    }

    [Fact]
    public async Task Background_wait_is_capped_at_60_seconds_with_a_warning()
    {
        if (!Supported)
            return;
        await using var f = await ScriptFixture.Create();
        var result = await Call(f, "run_script", Background("return 1", 600));
        Assert.Equal("completed", SessionWait.Text(result["status"]));
        Assert.Contains("60s", SessionWait.Text(result["warning"]));
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            SessionWait.Text(result["runId"])!,
            default
        );
        Assert.Equal(60, MainToolScript.Number(record!["timeoutSecs"], 0));
        var defaulted = await Call(f, "run_script", Background("return 1", null));
        record = await f.Manager.ToolScript.Store.ReadAsync(
            SessionWait.Text(defaulted["runId"])!,
            default
        );
        Assert.Equal(15, MainToolScript.Number(record!["timeoutSecs"], 0));
    }

    [Fact]
    public async Task Shutdown_cancels_a_detached_run_without_an_event_and_restart_drops_its_wait()
    {
        if (!Supported)
            return;
        var f = await ScriptFixture.Create();
        string runId;
        try
        {
            var receipt = await Call(f, "run_script", Background("while True:\n    pass\n"));
            runId = SessionWait.Text(receipt["runId"])!;
            await f.Manager.DeclareWaitAsync(
                f.Owner,
                new JsonObject { ["waitExecIds"] = new JsonArray(runId) }
            );
            await f.Manager.ShutdownAsync();
            var record = await new ToolScriptRunStore(f.Data).ReadAsync(runId, default);
            Assert.Equal("cancelled", SessionWait.Text(record!["status"]));
            Assert.Equal(MainToolScript.ShutdownCancellation, SessionWait.Text(record["error"]));
            Assert.Equal(0, Events(f.Owner, runId));
        }
        finally
        {
            await f.DisposeAsync();
        }
        Assert.True(SessionSaveLane.LostAfterRestart(runId));
        Assert.False(SessionSaveLane.LostAfterRestart("exec_like_id"));
    }

    [Fact]
    public void Event_text_is_bounded_and_names_the_continuation_of_a_pause()
    {
        var finished = SessionManager.ToolScriptRunEvent(
            new JsonObject
            {
                ["status"] = "failed",
                ["runId"] = "tsr_1",
                ["error"] = new string('e', 5000),
            }
        );
        Assert.StartsWith(
            "<foxwarm-system kind=\"event\" type=\"background-script-finished\">\n",
            finished
        );
        Assert.Contains("status: failed", finished);
        Assert.Contains("[truncated]", finished);
        Assert.True(finished.Length < 1500);
        var paused = SessionManager.ToolScriptRunEvent(
            new JsonObject
            {
                ["status"] = "waiting",
                ["runId"] = "tsr_2",
                ["continuationId"] = "tsc_9",
                ["question"] = "line one\nline two",
            }
        );
        Assert.Contains("type=\"background-script-waiting\"", paused);
        Assert.Contains("continuationId: tsc_9", paused);
        Assert.Contains("question: line one\n  line two", paused);
        Assert.EndsWith("\n</foxwarm-system>", paused);
    }
}
