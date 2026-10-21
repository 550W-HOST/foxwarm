using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptTimerTests
{
    private static SessionToolExecutor Dispatcher(ScriptFixture f, SessionOwner? owner = null)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var item in ToolScriptToolDefinitions
                .Definitions()
                .Concat(TimerToolDefinitions.Definitions())
                .Concat(AgentToolDefinitions.Definitions())
                .Concat(UnifiedToolDefinitions.All())
                .Concat(LocalExecManager.Definitions())
        )
            definitions.Add(item?.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        return new(
            new WorkspaceTools(f.Work),
            owner ?? f.Owner,
            f.Manager,
            SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work)
        );
    }

    private static async Task<JsonObject> Call(
        SessionToolExecutor tools,
        string name,
        JsonObject args
    ) =>
        (
            await tools.ExecuteAsync(new JsonObject { ["name"] = name, ["args"] = args }, default)
        )!.AsObject();

    private static Task<JsonObject> Register(
        ScriptFixture f,
        JsonObject script,
        double seconds = .03
    ) =>
        f.Manager.ExecuteTimerToolAsync(
            f.Owner,
            "create_timer",
            new JsonObject
            {
                ["action"] = "toolscript",
                ["script"] = script,
                ["afterSeconds"] = seconds,
            },
            default
        );

    private static async Task Until(Func<bool> ready)
    {
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (!ready() && DateTime.UtcNow < deadline)
            await Task.Delay(10);
        Assert.True(ready());
    }

    private static async Task Finished(ScriptFixture f, JsonObject receipt)
    {
        Assert.Null(receipt["error"]);
        var id = SessionWait.Text(receipt["timer"]!["id"])!;
        await Until(() =>
            !f.Manager.Timers.List(f.Owner.Id).Any(row => SessionWait.Text(row?["id"]) == id)
        );
    }

    private static JsonObject Send(string id) =>
        new() { ["sessionId"] = id, ["message"] = "monitor alert" };

    private static JsonObject Inline(string code) => new() { ["code"] = code };

    private static JsonObject Continue(JsonObject paused) =>
        new()
        {
            ["runId"] = paused["runId"]!.DeepClone(),
            ["continuationId"] = paused["continuationId"]!.DeepClone(),
            ["input"] = "yes",
        };

    [Fact]
    public async Task Actual_Monty_timer_rereads_current_source_while_model_is_busy_and_Stop_keeps_its_own_abort_slot()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new LoopbackResponsesServer(
            async (stream, _) =>
            {
                await release.Task;
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n"
                    )
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var f = await ScriptFixture.Create(suppliedOptions: options);
        try
        {
            await f.Owner.Entry.SaveLane.AdmitAsync(
                QueueItem.UserText("long request"),
                SaveKind.Strict
            );
            var foreground = f.Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id);
            await peer.Request.WaitAsync(TimeSpan.FromSeconds(5));
            var before = f.Owner.History().Select(row => row.ToJsonString()).ToArray();
            var source = Path.Combine(f.Work, "monitor.py");
            var output = Path.Combine(f.Work, "checked.txt");
            // No registration-time source I/O: this file does not yet exist.
            var receipt = await Register(
                f,
                new JsonObject
                {
                    ["filePath"] = source,
                    ["node"] = "master",
                    ["argsJson"] = new JsonObject
                    {
                        ["filePath"] = output,
                        ["started"] = Path.Combine(f.Work, "started.txt"),
                    }.ToJsonString(),
                },
                .15
            );
            await File.WriteAllTextAsync(
                source,
                "call_tool('write', {'filePath':args['started'], 'content':'started'})\ncall_tool('exec', {'command':'sleep 1', 'timeout':10})\nreturn call_tool('write', {'filePath':args['filePath'], 'content':'checked'})"
            );
            await Until(() => File.Exists(Path.Combine(f.Work, "started.txt")));
            Assert.Equal(before, f.Owner.History().Select(row => row.ToJsonString()));
            Assert.True(f.Owner.Entry.Snapshot().Busy);
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
            Assert.Equal(1, peer.RequestCount);
            // Stop settles the foreground request while the independent scheduled slice continues.
            await f.Owner.Registry.Control.StopAsync(f.Owner.Id).WaitAsync(TimeSpan.FromSeconds(3));
            await foreground.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.False(f.Owner.Entry.Snapshot().Busy);
            await Finished(f, receipt);
            Assert.Equal("checked", await File.ReadAllTextAsync(output));
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Run_continuation_and_scheduled_native_self_notifications_use_actual_run_ID_and_no_self_reply_route()
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        Assert.NotNull((await Call(tools, "send_to_session", Send(f.Owner.Id)))["error"]);
        var forged = Send(f.Owner.Id);
        forged["toolScriptRunId"] = "tsr_forged";
        Assert.NotNull((await Call(tools, "send_to_session", forged))["error"]);
        var code = "return call_tool('send_to_session', args)";
        var direct = await Call(
            tools,
            "run_script",
            new JsonObject { ["code"] = code, ["args"] = Send(f.Owner.Id) }
        );
        Assert.Equal("completed", SessionWait.Text(direct["status"]));
        CheckWrapper(direct["runId"]!);
        var paused = await Call(
            tools,
            "run_script",
            new JsonObject
            {
                ["code"] = "ask_agent('Proceed?')\n" + code,
                ["args"] = Send(f.Owner.Id),
            }
        );
        var done = await Call(tools, "continue_script", Continue(paused));
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        CheckWrapper(done["runId"]!);
        var receipt = await Register(
            f,
            new JsonObject { ["code"] = code, ["args"] = Send(f.Owner.Id) }
        );
        await Finished(f, receipt);
        var runs = await f.Manager.ToolScript.Store.ListAsync(f.Owner.Id, 20, null, default);
        var timerRun = runs.Single(row =>
            SessionWait.Text(row["runId"]) != SessionWait.Text(done["runId"])
            && SessionWait.Text(row["runId"]) != SessionWait.Text(direct["runId"])
        );
        CheckWrapper(timerRun["runId"]!);
        Assert.Empty(f.Owner.History());
        var before = f.Owner.Entry.Snapshot().Queue.Count;
        await Call(tools, "run_script", Inline("return {'toolScriptRunId':'tsr_forged'}"));
        Assert.NotNull((await Call(tools, "send_to_session", Send(f.Owner.Id)))["error"]);
        Assert.Equal(before, f.Owner.Entry.Snapshot().Queue.Count);
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n- id: deny-send\n  action: deny\n  match: { tool: { source: builtin, name: send_to_session } }\n"
            ),
            default
        );
        var denied = await Call(
            tools,
            "run_script",
            new JsonObject { ["code"] = code, ["args"] = Send(f.Owner.Id) }
        );
        Assert.Equal("failed", SessionWait.Text(denied["status"]));
        Assert.Equal(before, f.Owner.Entry.Snapshot().Queue.Count);

        void CheckWrapper(JsonNode runId)
        {
            var wrapper = f.Owner.Entry.Snapshot().Queue.Last().Parts![0]![
                "system"
            ]!.GetValue<string>();
            Assert.Contains("type=\"toolscript\"", wrapper);
            Assert.Contains("runId=\"" + SessionWait.Text(runId) + "\"", wrapper);
            Assert.DoesNotContain("replyVia", wrapper);
            Assert.DoesNotContain("replyTargetSessionId", wrapper);
        }
    }

    [Theory]
    [InlineData("run_script", "builtin")]
    [InlineData("read", "node")]
    [InlineData("write", "node")]
    public async Task Scheduled_execution_reauthorizes_starter_source_read_and_nested_effects(
        string name,
        string source
    )
    {
        await using var f = await ScriptFixture.Create();
        var path = Path.Combine(f.Work, "source.py");
        var output = Path.Combine(f.Work, "forbidden.txt");
        var receipt = await Register(f, new JsonObject { ["filePath"] = path }, .15);
        await File.WriteAllTextAsync(
            path,
            "call_tool('write', {'filePath':"
                + JsonValue.Create(output)!.ToJsonString()
                + ", 'content':'forbidden'})"
        );
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                $"version: 1\nrules:\n- id: deny-current\n  action: deny\n  match: {{ tool: {{ source: {source}, name: {name} }} }}\n"
            ),
            default
        );
        await Finished(f, receipt);
        Assert.False(File.Exists(output));
        Assert.Empty(f.Owner.History());
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task CRUD_preserves_owner_boundary_trimmed_ID_inherited_action_whole_spec_replacement_and_action_switch()
    {
        await using var f = await ScriptFixture.Create();
        var other = await f.Manager.CreateNamedAsync("main", "foreign", null, null);
        var script = new JsonObject { ["code"] = "return args", ["argsJson"] = "{\"old\":true}" };
        var receipt = await Register(f, script, 600);
        var timer = receipt["timer"]!.AsObject();
        var id = SessionWait.Text(timer["id"])!;
        Assert.True(timer["script"]!["args"]!["old"]!.GetValue<bool>());
        var args = new JsonObject
        {
            ["timerId"] = " \t" + id + "\n",
            ["sessionId"] = f.Owner.Id,
            ["script"] = Inline("return 2"),
        };
        var denied = await Call(Dispatcher(f, other), "update_timer", args);
        Assert.NotNull(denied["error"]);
        var replaced = await Call(
            Dispatcher(f),
            "update_timer",
            new JsonObject { ["timerId"] = id, ["script"] = Inline("return 2") }
        );
        Assert.Empty(replaced["timer"]!["script"]!["args"]!.AsObject());
        var message = await Call(
            Dispatcher(f),
            "update_timer",
            new JsonObject
            {
                ["timerId"] = id,
                ["action"] = "message",
                ["message"] = "new message",
                ["newSession"] = true,
            }
        );
        Assert.Null(message["error"]);
        Assert.Null(message["timer"]!["script"]);
        var back = await Call(
            Dispatcher(f),
            "update_timer",
            new JsonObject
            {
                ["timerId"] = id,
                ["action"] = "toolscript",
                ["script"] = Inline("return 3"),
            }
        );
        Assert.Null(back["error"]);
        foreach (
            var key in new[] { "sessionPrefix", "agentName", "currentNode", "model", "effort" }
        )
            Assert.Null(back["timer"]![key]);
        Assert.False(back["timer"]!["newSession"]!.GetValue<bool>());
        Assert.Equal("", SessionWait.Text(back["timer"]!["message"]));
        var foreign = await Call(
            Dispatcher(f, other),
            "create_timer",
            new JsonObject
            {
                ["sessionId"] = f.Owner.Id,
                ["action"] = "toolscript",
                ["afterSeconds"] = 600,
                ["script"] = Inline("return 0"),
            }
        );
        Assert.NotNull(foreign["error"]);
    }

    [Fact]
    public async Task Unattended_wait_pause_failure_and_explicit_continuation_do_not_automatically_touch_owner_wait_or_history()
    {
        await using var f = await ScriptFixture.Create();
        await f.Manager.DeclareWaitAsync(f.Owner, new JsonObject { ["waitForInput"] = true });
        var wait = f.Owner.WaitSnapshot()!.ToJsonString();
        var script =
            "return call_tool('run_script', {'code':\"return call_tool('wait', {'waitForInput':True})\"})";
        await Finished(f, await Register(f, Inline(script)));
        await Finished(f, await Register(f, Inline("raise ValueError('monitor failed')")));
        var output = Path.Combine(f.Work, "continued.txt");
        await Finished(
            f,
            await Register(
                f,
                Inline(
                    "ask_agent('Need input')\nreturn call_tool('write', {'filePath':"
                        + JsonValue.Create(output)!.ToJsonString()
                        + ", 'content':'continued'})"
                )
            )
        );
        Assert.Equal(wait, f.Owner.WaitSnapshot()!.ToJsonString());
        Assert.Empty(f.Owner.History());
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        Assert.False(File.Exists(output));
        var tools = Dispatcher(f);
        var runs = await Call(tools, "list_toolscript_runs", new());
        var paused = runs["runs"]!
            .AsArray()
            .Single(row => SessionWait.Text(row?["status"]) == "waiting")!
            .AsObject();
        Assert.Equal(
            "completed",
            SessionWait.Text((await Call(tools, "continue_script", Continue(paused)))["status"])
        );
        Assert.Equal("continued", await File.ReadAllTextAsync(output));
        Assert.Equal(wait, f.Owner.WaitSnapshot()!.ToJsonString());
    }

    [Fact]
    public async Task Shutdown_closes_new_timer_admission_but_drains_accepted_Monty_slice_before_services_close()
    {
        await using var f = await ScriptFixture.Create();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.Timers.BeforeDelivery = async _ =>
        {
            reached.TrySetResult();
            await release.Task;
        };
        var output = Path.Combine(f.Work, "settled.txt");
        await Register(
            f,
            Inline(
                "call_tool('write', {'filePath':"
                    + JsonValue.Create(output)!.ToJsonString()
                    + ", 'content':'settled'})"
            )
        );
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var stop = f.Manager.ShutdownAsync();
            Assert.False(stop.IsCompleted);
            release.TrySetResult();
            await stop.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("settled", await File.ReadAllTextAsync(output));
            Assert.Empty(f.Owner.History());
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Restart_fires_persisted_once_and_continuation_uses_saved_VM_not_source_or_replayed_effects()
    {
        await using var f = await ScriptFixture.Create();
        var file = Path.Combine(f.Work, "restart.py");
        var effect = Path.Combine(f.Work, "before-pause.txt");
        await File.WriteAllTextAsync(
            file,
            "call_tool('write', {'filePath':"
                + JsonValue.Create(effect)!.ToJsonString()
                + ", 'content':'once'})\nask_agent('Need input')\nreturn call_tool('send_to_session', args)"
        );
        var receipt = await Register(
            f,
            new JsonObject { ["filePath"] = file, ["args"] = Send(f.Owner.Id) },
            600
        );
        var timerId = SessionWait.Text(receipt["timer"]!["id"])!;
        var ownerId = f.Owner.Id;
        await f.Manager.ShutdownAsync();
        await f.Manager.DisposeAsync();
        // Make the real persisted record overdue while the process is stopped.
        var path = Path.Combine(f.Data, "state", "timers.json");
        var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        document["timers"]![0]!["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1;
        await File.WriteAllTextAsync(path, document.ToJsonString());
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
        // Keep explicit self-send durable without invoking a provider in this owned fixture.
        await f.Manager.LoadAsync();
        f.Owner = await f.Manager.RequiredAsync(ownerId);
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        f.Manager.Timers.Start();
        await Until(() =>
            !f.Manager.Timers.List(ownerId).Any(row => SessionWait.Text(row?["id"]) == timerId)
        );
        Assert.Equal("once", await File.ReadAllTextAsync(effect));
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        var tools = Dispatcher(f);
        var runs = await Call(tools, "list_toolscript_runs", new());
        var paused = Assert.Single(runs["runs"]!.AsArray())!.AsObject();
        Assert.Equal("waiting", SessionWait.Text(paused["status"]));
        await File.WriteAllTextAsync(file, "raise ValueError('must not reread')");
        await File.WriteAllTextAsync(effect, "not replayed");
        var done = await Call(tools, "continue_script", Continue(paused));
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        Assert.Equal("not replayed", await File.ReadAllTextAsync(effect));
        var wrapper = Assert.Single(f.Owner.Entry.Snapshot().Queue).Parts![0]![
            "system"
        ]!.GetValue<string>();
        Assert.Contains("runId=\"" + SessionWait.Text(paused["runId"]) + "\"", wrapper);
        Assert.Empty(f.Owner.History());
    }

    [Fact]
    public async Task Scheduled_timeout_checkpoint_keeps_real_pending_wait_for_manual_continuation_only()
    {
        await using var f = await ScriptFixture.Create();
        await f.Manager.DeclareWaitAsync(f.Owner, new JsonObject { ["waitForInput"] = true });
        var wait = f.Owner.WaitSnapshot()!.ToJsonString();
        var delayed = false;
        void Observe(SessionRuntimeEvent e)
        {
            if (
                !delayed
                && e.Data?["type"]?.ToString() == "toolscript-progress"
                && e.Data["subCalls"] is JsonArray calls
                && calls.LastOrDefault()?["status"]?.ToString() == "completed"
            )
            {
                delayed = true;
                Thread.Sleep(180); // Hold the actual final wait host boundary past the slice budget.
            }
        }
        f.Owner.Changed += Observe;
        try
        {
            var script = Inline("call_tool('wait', {'waitForInput':True})\nreturn 7");
            script["timeoutSecs"] = .1;
            await Finished(f, await Register(f, script));
        }
        finally
        {
            f.Owner.Changed -= Observe;
        }
        Assert.True(delayed);
        Assert.Equal(wait, f.Owner.WaitSnapshot()!.ToJsonString());
        Assert.Empty(f.Owner.History());
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        var saved = Assert.Single(
            await f.Manager.ToolScript.Store.ListAsync(f.Owner.Id, 20, null, default)
        )!;
        Assert.NotNull(saved["waiting"]!["timeout"]!["pendingSessionWait"]);
        var paused = new JsonObject
        {
            ["runId"] = saved["runId"]!.DeepClone(),
            ["continuationId"] = saved["waiting"]!["continuationId"]!.DeepClone(),
        };
        var done = await Call(Dispatcher(f), "continue_script", Continue(paused));
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        Assert.Equal(7, done["result"]!.GetValue<long>());
        Assert.NotEqual(wait, f.Owner.WaitSnapshot()!.ToJsonString());
    }

    [Fact]
    public async Task Shutdown_drains_a_scheduled_slice_already_accepted_during_cold_exact_owner_admission()
    {
        await using var f = await ScriptFixture.Create();
        var ownerId = f.Owner.Id;
        var output = Path.Combine(f.Work, "cold-settled.txt");
        await Register(
            f,
            Inline(
                "call_tool('write', {'filePath':"
                    + JsonValue.Create(output)!.ToJsonString()
                    + ", 'content':'settled'})"
            ),
            600
        );
        await f.Manager.ShutdownAsync();
        await f.Manager.DisposeAsync();
        var path = Path.Combine(f.Data, "state", "timers.json");
        var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        document["timers"]![0]!["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1;
        await File.WriteAllTextAsync(path, document.ToJsonString());
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeAdmissionRead = async (id, token) =>
        {
            if (id == ownerId)
            {
                reached.TrySetResult();
                await release.Task.WaitAsync(token);
            }
        };
        await f.Manager.LoadMainHostAsync();
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var stop = f.Manager.ShutdownAsync();
            Assert.False(stop.IsCompleted);
            release.TrySetResult();
            await stop.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("settled", await File.ReadAllTextAsync(output));
            f.Owner = f.Manager.Find(ownerId)!;
            Assert.NotNull(f.Owner);
            Assert.Empty(f.Owner.History());
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Scheduled_explicit_one_shot_and_background_exec_keep_their_normal_effects_without_automatic_model_history()
    {
        await using var peer = new LoopbackResponsesServer(
            async (stream, _) =>
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"one-shot answer\"}]}]}}\n\n"
                    )
                )
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var f = await ScriptFixture.Create(suppliedOptions: options);
        var code =
            "answer=request_model_without_context('explicit scheduled question')\njob=call_tool('exec', {'command':'sleep 2', 'timeout':1})\ncall_tool('wait', {'waitExecIds':[job['execId']], 'wakeIfNoActivityAfterSeconds':None})\nreturn answer";
        await Finished(f, await Register(f, Inline(code)));
        Assert.Equal(1, peer.RequestCount);
        Assert.Contains("explicit scheduled question", (await peer.Request).Body);
        Assert.Null(f.Owner.WaitSnapshot());
        Assert.Empty(f.Owner.History());
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count > 0);
        Assert.Contains(
            "exec",
            string.Join(
                "",
                f.Owner.Entry.Snapshot().Queue.Last().Parts!.Select(part => part!.ToJsonString())
            )
        );
        Assert.Equal(1, peer.RequestCount);
        var saved = Assert.Single(
            await f.Manager.ToolScript.Store.ListAsync(f.Owner.Id, 20, null, default)
        )!;
        Assert.Equal("one-shot answer", SessionWait.Text(saved["lastResult"]!["text"]));
    }

    [Fact]
    public async Task Script_self_send_retains_configured_handoff_recall_and_confirmation_validation()
    {
        await using var f = await ScriptFixture.Create();
        var ownerId = f.Owner.Id;
        await f.Manager.ShutdownAsync();
        await f.Manager.DisposeAsync();
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        var models = HostModels.Parse(
            JsonNode
                .Parse(
                    """{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]}}}"""
                )!
                .AsObject(),
            new JsonObject { ["handoffConfirmation"] = true }
        );
        f.Manager = new(f.Data, f.Work, options, models);
        await f.Manager.LoadAsync();
        f.Owner = await f.Manager.RequiredAsync(ownerId);
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var tools = Dispatcher(f);
        var code = "return call_tool('send_to_session', args)";
        var rejected = await Call(
            tools,
            "run_script",
            new JsonObject { ["code"] = code, ["args"] = Send(ownerId) }
        );
        Assert.NotNull(rejected["result"]?["error"] ?? rejected["error"]);
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        var approved = new JsonObject
        {
            ["sessionId"] = ownerId,
            ["handoffRecall"] =
                HandoffConfirmation.RecallPrefix
                + "\nThe requested monitor reports an actionable condition to its owner.",
            ["message"] = "condition reached",
            ["handoffConfirmation"] =
                HandoffConfirmation.Prefix
                + "\nThis notification reports the requested condition, not an acknowledgement.\n"
                + HandoffConfirmation.Suffix,
        };
        var done = await Call(
            tools,
            "run_script",
            new JsonObject { ["code"] = code, ["args"] = approved }
        );
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task File_source_and_nested_default_cwd_are_resolved_at_fire_not_registration()
    {
        await using var f = await ScriptFixture.Create();
        var before = Path.Combine(f.Work, "old");
        var current = Path.Combine(f.Work, "current");
        Directory.CreateDirectory(before);
        Directory.CreateDirectory(current);
        await File.WriteAllTextAsync(
            Path.Combine(before, "monitor.py"),
            "raise ValueError('old source')"
        );
        await File.WriteAllTextAsync(
            Path.Combine(current, "monitor.py"),
            "return call_tool('write', {'filePath':'checked.txt','content':'current'})"
        );
        await f.Owner.UpdateCwdAsync(before);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.Timers.BeforeDelivery = async _ =>
        {
            reached.TrySetResult();
            await release.Task;
        };
        var receipt = await Register(
            f,
            new JsonObject
            {
                ["filePath"] = "monitor.py",
                ["node"] = "current",
                ["mode"] = "background",
            }
        );
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await f.Owner.UpdateCwdAsync(current);
            release.TrySetResult();
            await Finished(f, receipt);
            Assert.Equal(
                "current",
                await File.ReadAllTextAsync(Path.Combine(current, "checked.txt"))
            );
            Assert.False(File.Exists(Path.Combine(before, "checked.txt")));
            Assert.Empty(f.Owner.History());
        }
        finally
        {
            release.TrySetResult();
        }
    }
}
