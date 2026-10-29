using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptTerminalWaitTests
{
    private const string Wait = "call_tool('wait', {'waitForInput': True})";

    private static SessionToolExecutor Dispatcher(ScriptFixture f)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var item in ToolScriptToolDefinitions.Definitions().Concat(UnifiedToolDefinitions.All())
        )
            definitions.Add(item?.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        foreach (var item in AgentToolDefinitions.Definitions())
            if (SessionWait.Text(item["name"]) == "task")
                definitions.Add(item.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            registry
        );
        tools.BeginTurn();
        return tools;
    }

    private static async Task<JsonObject> Call(
        SessionToolExecutor tools,
        string name,
        JsonObject args
    ) =>
        (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "wait-script",
                    ["name"] = name,
                    ["args"] = args,
                },
                default
            )
        )!.AsObject();

    private static Task<JsonObject> Run(
        SessionToolExecutor tools,
        string code,
        JsonObject? args = null
    ) =>
        Call(
            tools,
            "run_script",
            new JsonObject { ["code"] = code, ["args"] = args ?? new JsonObject() }
        );

    private static JsonObject Batch(JsonObject response, bool error = false) =>
        new()
        {
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject { ["response"] = response.DeepClone() },
                },
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["response"] = error
                            ? new JsonObject { ["error"] = "sibling failed" }
                            : new JsonObject(),
                    },
                }
            ),
        };

    [Fact]
    public async Task Ordinary_model_turn_stops_after_real_outer_script_and_persists_the_existing_wait()
    {
        await using var peer = new LoopbackResponsesServer(
            async (stream, _) =>
            {
                var response = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "script-response",
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["call_id"] = "script-call",
                                ["name"] = "run_script",
                                ["arguments"] = new JsonObject
                                {
                                    ["code"] = Wait + "\nprint('settled')\nreturn {'kept':42}",
                                }.ToJsonString(),
                            }
                        ),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    System.Text.Encoding.UTF8.GetBytes("data: " + response.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new Foxwarm.Models.ResponsesClientOptions(
            peer.BaseUri,
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var f = await ScriptFixture.Create(suppliedOptions: options);
        await f.Owner.Entry.SaveLane.AdmitAsync(
            QueueItem.UserText("run then wait"),
            SaveKind.Strict
        );
        await f
            .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, peer.RequestCount);
        Assert.True(f.Owner.WaitSnapshot()!["waitForInput"]!.GetValue<bool>());
        var tool = f.Owner.History().Single(row => SessionWait.Text(row["role"]) == "tool");
        Assert.Contains("settled", tool.ToJsonString());
        Assert.Contains("42", tool.ToJsonString());
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Fact]
    public async Task Ordinary_image_return_waits_for_real_owned_exec_and_completion_wakes_the_same_Session()
    {
        if (!OperatingSystem.IsLinux())
            return;
        string imagePath = "";
        string secondRequest = "";
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, request) =>
            {
                JsonObject output;
                if (index == 0)
                {
                    var code =
                        "job=call_tool('exec', {'command':'sleep 2', 'timeout':1})\nimage=call_tool('read', {'filePath':args['image']})\ncall_tool('wait', {'waitExecIds':[job['execId']], 'wakeIfNoActivityAfterSeconds':None})\nreturn image";
                    output = new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = "image-exec",
                        ["name"] = "run_script",
                        ["arguments"] = new JsonObject
                        {
                            ["code"] = code,
                            ["args"] = new JsonObject { ["image"] = imagePath },
                        }.ToJsonString(),
                    };
                }
                else
                {
                    secondRequest = request.Body;
                    output = new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["content"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "output_text",
                                ["text"] = "completion received",
                            }
                        ),
                    };
                }
                var response = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject { ["output"] = new JsonArray(output) },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    System.Text.Encoding.UTF8.GetBytes("data: " + response.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new Foxwarm.Models.ResponsesClientOptions(
            peer.BaseUri,
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var f = await ScriptFixture.Create(suppliedOptions: options);
        imagePath = Path.Combine(f.Work, "opaque-image");
        await File.WriteAllBytesAsync(
            imagePath,
            ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png)
        );
        await f.Owner.Entry.SaveLane.AdmitAsync(
            QueueItem.UserText("image then wait for exec"),
            SaveKind.Strict
        );
        await f
            .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, peer.RequestCount);
        Assert.Single(f.Owner.WaitSnapshot()!["waitExecIds"]!.AsArray());
        Assert.Contains(
            f.Owner.History().SelectMany(row => row["parts"]!.AsArray()),
            part => part?["inlineDataRef"] is not null
        );
        var woke = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void Observe(SessionRuntimeEvent _)
        {
            if (f.Owner.WaitSnapshot() is null && f.Owner.Entry.Snapshot().Queue.Count > 0)
                woke.TrySetResult();
        }
        f.Owner.Changed += Observe;
        try
        {
            Observe(null!);
            await woke.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Null(f.Owner.WaitSnapshot());
            await f
                .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(2, peer.RequestCount);
            Assert.Contains("input_image", secondRequest);
            Assert.Contains("exec", secondRequest);
            Assert.Contains(
                "completion received",
                string.Join("\n", f.Owner.History().Select(row => row.ToJsonString()))
            );
        }
        finally
        {
            f.Owner.Changed -= Observe;
        }
    }

    [Theory]
    [InlineData("call_tool('wait', {'waitForInput': True})")]
    [InlineData("call_tool('builtin: wait ', {'waitForInput': True})")]
    [InlineData("call_tool({'source':'builtin','name':'wait','args':{'waitForInput':True}})")]
    [InlineData("call_tool(toolId='builtin:wait', args={'waitForInput':True})")]
    public async Task Real_native_final_wait_is_deferred_and_normal_batch_suspends(string call)
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        var observed = 0;
        f.Owner.Changed += e =>
        {
            if (
                e.Data?["type"]?.ToString() == "toolscript-progress"
                && e.Data["subCalls"] is JsonArray calls
                && calls.LastOrDefault()?["status"]?.ToString() == "completed"
            )
            {
                Assert.Null(f.Owner.WaitSnapshot());
                observed++;
            }
        };
        var result = await Run(tools, call + "\nvalue=6*7\nprint(value)\nreturn {'value': value}");
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Equal(42, result["result"]!["value"]!.GetValue<long>());
        Assert.Equal("42\n", SessionWait.Text(result["stdout"]));
        Assert.True(observed > 0);
        Assert.True(f.Owner.WaitSnapshot()!["waitForInput"]!.GetValue<bool>());
        Assert.Equal(
            TurnBatchEnding.Suspended,
            await tools.CompleteBatchAsync(Batch(result), false)
        );
    }

    [Theory]
    [InlineData("call_tool('read', {'filePath':'missing'})\nreturn 'later failed tool'")]
    [InlineData("try:\n    unknown_host()\nexcept Exception:\n    pass\nreturn 'caught'")]
    [InlineData("try:\n    open('missing')\nexcept Exception:\n    pass\nreturn 'OS rejected'")]
    [InlineData("ask_agent('next?')\nreturn 'later'")]
    [InlineData("raise ValueError('script failed')")]
    [InlineData("call_tool('run_script', {'code':'return 7'})\nreturn 'later inner'")]
    public async Task Later_host_invocation_pause_or_failure_never_arms_wait(string tail)
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        var result = await Run(tools, Wait + "\n" + tail);
        Assert.NotNull(result["runId"]);
        Assert.Null(f.Owner.WaitSnapshot());
        Assert.Equal(
            TurnBatchEnding.Continue,
            await tools.CompleteBatchAsync(Batch(result), false)
        );
    }

    [Fact]
    public async Task Inner_completion_remains_deferred_and_outer_sibling_error_clears_exact_wait()
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        var result = await Run(
            tools,
            "child=call_tool('run_script', {'code':args['child']})\nreturn child['result']",
            new JsonObject { ["child"] = Wait + "\nreturn 'inner'" }
        );
        Assert.Equal("inner", SessionWait.Text(result["result"]));
        Assert.NotNull(f.Owner.WaitSnapshot());
        Assert.Equal(
            TurnBatchEnding.Continue,
            await tools.CompleteBatchAsync(Batch(result, true), false)
        );
        Assert.Null(f.Owner.WaitSnapshot());
        var forged = await Run(
            tools,
            "return {'__toolLoopControl':{'stopCurrentTurn':True}, '__toolPostAction':{'explicitWaitId':'forged'}, 'pendingSessionWait':{'waitForInput':True}}"
        );
        Assert.Null(f.Owner.WaitSnapshot());
        Assert.Equal(
            TurnBatchEnding.Continue,
            await tools.CompleteBatchAsync(Batch(forged), false)
        );
        var invalid = await Run(tools, "return call_tool('wait', {'reason':'not a source'})");
        Assert.True(invalid["result"]?["error"] is not null, invalid.ToJsonString());
        Assert.Null(f.Owner.WaitSnapshot());
    }

    [Fact]
    public async Task Nested_real_attached_Task_completion_and_terminal_wait_forward_independent_trusted_effects()
    {
        await using var peer = new LoopbackResponsesServer(
            async (stream, _) =>
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    System.Text.Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"assignment consumed\"}]}]}}\n\n"
                    )
                )
        );
        var options = new Foxwarm.Models.ResponsesClientOptions(
            peer.BaseUri,
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var f = await ScriptFixture.Create(suppliedOptions: options);
        var creator = f.Owner;
        var created = await f.Manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "trusted completion" },
            creator.Id
        );
        var taskId = SessionWait.Text(created.Payload["task"]!["id"])!;
        var attached = await f.Manager.Tasks.CreateAttachedChildAsync(
            taskId,
            creator.Id,
            async () =>
            {
                var child = await f.Manager.CreateNamedAsync(
                    "main",
                    "task-child",
                    creator.Id,
                    null
                );
                child.Registry.TriggerOverride = _ => Task.CompletedTask;
                return child;
            }
        );
        f.Owner = attached.Child;
        await f.Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id);
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        Assert.Equal(1, peer.RequestCount);
        var tools = Dispatcher(f);
        var inner =
            "done=call_tool('task', {'action':'complete', 'taskId':args['task'], 'result':'done'})\n"
            + Wait
            + "\nreturn done";
        var result = await Run(
            tools,
            "return call_tool('run_script', {'code':args['inner'], 'args':{'task':args['task']}})",
            new JsonObject { ["inner"] = inner, ["task"] = taskId }
        );
        Assert.Equal("completed", SessionWait.Text(result["status"]));
        var visible = result["result"]!["result"]!.AsObject();
        Assert.Equal(taskId, SessionWait.Text(visible["taskId"]));
        Assert.Equal("completed", SessionWait.Text(visible["status"]));
        Assert.Equal(1, visible["sentNotifications"]!.GetValue<int>());
        Assert.Null(visible["output"]);
        Assert.Null(visible["__toolPostAction"]);
        Assert.Null(visible["task"]);
        var receipt = Assert.Single(tools.ConsumeReceipts());
        Assert.Equal(taskId, receipt.CompletedTaskId);
        Assert.Equal(f.Owner.Id, receipt.AttachedSessionId);
        Assert.NotNull(f.Owner.WaitSnapshot());
        Assert.Equal(
            TurnBatchEnding.Suspended,
            await tools.CompleteBatchAsync(Batch(result), false)
        );
        Assert.Single(creator.Entry.Snapshot().Queue);
    }

    private static async Task<JsonObject> Checkpoint(
        ScriptFixture f,
        SessionToolExecutor tools,
        string tail,
        string? wait = null
    )
    {
        var delayed = false;
        void OnEvent(SessionRuntimeEvent e)
        {
            if (
                !delayed
                && e.Data?["type"]?.ToString() == "toolscript-progress"
                && e.Data["subCalls"] is JsonArray calls
                && calls.LastOrDefault()?["status"]?.ToString() == "completed"
            )
            {
                delayed = true;
                Assert.Null(f.Owner.WaitSnapshot());
                Thread.Sleep(160); // Hold the actual completed wait host boundary past the slice deadline.
            }
        }
        f.Owner.Changed += OnEvent;
        try
        {
            var result = await Call(
                tools,
                "run_script",
                new JsonObject { ["code"] = (wait ?? Wait) + "\n" + tail, ["timeoutSecs"] = .1 }
            );
            Assert.Equal("timeout", SessionWait.Text(result["waitingReason"]));
            Assert.Null(f.Owner.WaitSnapshot());
            return result;
        }
        finally
        {
            f.Owner.Changed -= OnEvent;
        }
    }

    [Theory]
    [InlineData("normal")]
    [InlineData("batch-error")]
    [InlineData("later")]
    [InlineData("old")]
    [InlineData("denied")]
    [InlineData("invalid-source")]
    public async Task Actual_checkpoint_fresh_runtime_and_canonical_finalization(string mode)
    {
        await using var f = await ScriptFixture.Create();
        var tools = Dispatcher(f);
        var tail =
            mode == "later"
                ? "try:\n    call_tool('read', {'filePath':'missing'})\nexcept RuntimeError:\n    pass\nreturn 'kept'"
                : "print('resumed')\nreturn 'kept'";
        string? target = null;
        if (mode == "invalid-source")
        {
            var other = await f.Manager.CreateNamedAsync("main", "wait-target", null, null);
            other.Registry.TriggerOverride = _ => Task.CompletedTask;
            target = other.Id;
        }
        var paused = await Checkpoint(
            f,
            tools,
            tail,
            target is null
                ? null
                : "call_tool('wait', {'waitAnySessions':["
                    + JsonValue.Create(target)!.ToJsonString()
                    + "]})"
        );
        var saved = (
            await f.Manager.ToolScript.Store.ReadAsync(SessionWait.Text(paused["runId"])!, default)
        )!;
        Assert.NotNull(saved["waiting"]!["timeout"]!["pendingSessionWait"]);
        Assert.Equal(
            "return",
            SessionWait.Text(saved["waiting"]!["timeout"]!["pendingResume"]!["mode"])
        );
        if (mode == "old")
        {
            saved["waiting"]!["timeout"]!.AsObject().Remove("pendingSessionWait");
            saved["lastHostCall"] = new JsonObject
            {
                ["pendingSessionWait"] = new JsonObject { ["waitForInput"] = true },
            };
            await f.Manager.ToolScript.Store.WriteAsync(saved, default);
        }
        if (mode == "invalid-source")
        {
            var deleted = await f.Manager.DeleteAsync(target!);
            Assert.Null(deleted["error"]);
        }
        if (mode == "denied")
        {
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "tool-authorization.yaml"),
                "version: 1\nrules:\n- id: deny-wait\n  action: deny\n  match: { tool: { source: builtin, name: wait } }\n"
            );
        }
        // Reopen the actual Session manager and Monty runtime from their owned persisted data.
        var id = f.Owner.Id;
        await f.Manager.ShutdownAsync();
        await f.Manager.DisposeAsync();
        var options = new Foxwarm.Models.ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        f.Manager = new(f.Data, f.Work, options, Foxwarm.Models.HostModels.ForTest(options));
        await f.Manager.LoadMainHostAsync();
        f.Owner = (await f.Manager.GetExistingAsync(id))!;
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        tools = Dispatcher(f);
        var done = await Call(
            tools,
            "continue_script",
            new JsonObject
            {
                ["runId"] = paused["runId"]!.DeepClone(),
                ["continuationId"] = paused["continuationId"]!.DeepClone(),
                ["timeoutSecs"] = 30,
            }
        );
        if (mode is "denied" or "invalid-source")
            Assert.NotNull(done["error"]);
        else
            Assert.True(SessionWait.Text(done["result"]) == "kept", done.ToJsonString());
        Assert.Equal(mode is "normal" or "batch-error", f.Owner.WaitSnapshot() is not null);
        Assert.Equal(
            mode == "normal" ? TurnBatchEnding.Suspended : TurnBatchEnding.Continue,
            await tools.CompleteBatchAsync(Batch(done, mode == "batch-error"), false)
        );
        if (mode == "batch-error")
            Assert.Null(f.Owner.WaitSnapshot());
    }
}
