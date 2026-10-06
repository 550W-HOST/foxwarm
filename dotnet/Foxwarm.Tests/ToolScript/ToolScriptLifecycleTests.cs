using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptLifecycleTests
{
    private static ToolScriptContext Context(
        ScriptFixture f,
        Func<JsonObject, ToolScriptDataBudget, CancellationToken, Task<JsonObject>>? call = null
    ) =>
        new(
            f.Owner,
            f.Owner.Id,
            call ?? ((_, _, _) => throw new InvalidOperationException("No repeated effects.")),
            (_, _, _, _) => throw new InvalidOperationException("No model request."),
            (_, _, _) => throw new InvalidOperationException("No source reread.")
        );

    private static JsonObject Resume(JsonObject paused) =>
        new()
        {
            ["runId"] = paused["runId"]!.DeepClone(),
            ["continuationId"] = paused["continuationId"]!.DeepClone(),
        };

    [Theory]
    [InlineData("native", "agent")]
    [InlineData("native", "return")]
    [InlineData("native", "exception")]
    [InlineData("wasm", "agent")]
    [InlineData("wasm", "return")]
    [InlineData("wasm", "exception")]
    public async Task Production_driver_resumes_actual_Source_native_and_WASM_snapshot_without_source_or_repeated_host_effects(
        string backend,
        string kind
    )
    {
        await using var f = await ScriptFixture.Create();
        var fixture = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "ToolScript",
                        "Fixtures",
                        $"source-{backend}-{kind}.json"
                    )
                )
            )!
            .AsObject();
        var record = new JsonObject
        {
            ["runId"] = fixture["runId"]!.DeepClone(),
            ["ownerSessionId"] = f.Owner.Id,
            ["agentName"] = f.Owner.Agent,
            ["status"] = "waiting",
            ["mode"] = "background",
            ["timeoutSecs"] = 30,
            ["scriptName"] = "inline.py",
            ["scriptPath"] = "<inline>",
            ["filePath"] = "<inline>",
            ["vmRuntime"] = fixture["vmRuntime"]!.DeepClone(),
            ["snapshotBase64"] = fixture["snapshotBase64"]!.DeepClone(),
            ["stdout"] = fixture["stdout"]!.DeepClone(),
            ["executedTools"] = new JsonArray(),
            ["relatedManagedSessions"] = new JsonArray(),
            ["waiting"] = new JsonObject
            {
                ["reason"] = kind == "agent" ? "agent" : "timeout",
                ["continuationId"] = "source-continuation",
            },
        };
        if (kind != "agent")
            record["waiting"]!["timeout"] = new JsonObject
            {
                ["pendingResume"] =
                    kind == "return"
                        ? new JsonObject
                        {
                            ["mode"] = "return",
                            ["value"] = fixture["resumeValue"]!.DeepClone(),
                        }
                        : new JsonObject
                        {
                            ["mode"] = "exception",
                            ["exception"] = new JsonObject
                            {
                                ["type"] = "RuntimeError",
                                ["message"] = fixture["pendingException"]!.DeepClone(),
                            },
                        },
            };
        await f.Manager.ToolScript.Store.WriteAsync(record, default);
        var result = await f.Manager.ToolScript.ExecuteAsync(
            "continue_script",
            new JsonObject
            {
                ["runId"] = record["runId"]!.DeepClone(),
                ["continuationId"] = "source-continuation",
                ["input"] = "agent-input",
            },
            Context(f),
            default
        );
        Assert.Equal("completed", result["status"]!.GetValue<string>());
        Assert.Null(result["error"]);
        if (kind == "agent")
        {
            var values = result["result"]!.AsArray();
            Assert.Equal("agent-input", values[0]!.GetValue<string>());
            Assert.Null(values[1]);
            Assert.False(values[2]!.GetValue<bool>());
            Assert.Equal(0, values[3]!.GetValue<long>());
            Assert.Equal(
                new[] { "first", "second" },
                values[4]!.AsObject().Select(pair => pair.Key)
            );
        }
        if (kind == "return")
            Assert.Equal(
                "qualified-source-text\n",
                result["result"]!["content"]!.GetValue<string>()
            );
        if (kind == "exception")
            Assert.Equal(
                fixture["pendingException"]!.GetValue<string>(),
                result["result"]!["error"]!.GetValue<string>()
            );
        var saved = await f.Manager.ToolScript.Store.ReadAsync(
            record["runId"]!.GetValue<string>(),
            default
        );
        Assert.Equal(
            "source-before\n" + result["stdout"]!.GetValue<string>(),
            saved!["stdout"]!.GetValue<string>()
        );
        Assert.Null(saved["snapshotBase64"]);
    }

    [Fact]
    public async Task Actual_native_multislice_64MiB_UTF8_boundary_retains_effects_prefix_and_fails_before_next_hostcall()
    {
        await using var f = await ScriptFixture.Create();
        var calls = 0;
        var context = Context(
            f,
            async (wrapper, budget, token) =>
            {
                calls++;
                return await f.Tools.ExecuteAsync(
                    new JsonObject { ["name"] = "call_tool", ["args"] = wrapper.DeepClone() },
                    token
                );
            }
        );
        var script =
            "call_tool('write', {'filePath':'before', 'content':'real'})\nfor stage in range(8):\n    for index in range(128):\n        print(args['chunk'], end='')\n    ask_agent('next')\nprint('🦊', end='')\ncall_tool('write', {'filePath':'after', 'content':'must not happen'})\nreturn 'not completed'\n";
        var run = await f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject
            {
                ["code"] = script,
                ["args"] = new JsonObject { ["chunk"] = new string('é', 32768) },
            },
            context,
            default
        );
        for (var slice = 1; slice <= 8; slice++)
        {
            Assert.True(
                run["status"]!.GetValue<string>() == "waiting",
                run["error"]?.ToJsonString()
            );
            Assert.Equal(
                8 * 1024 * 1024,
                Encoding.UTF8.GetByteCount(run["stdout"]!.GetValue<string>())
            );
            run = await f.Manager.ToolScript.ExecuteAsync(
                "continue_script",
                Resume(run),
                context,
                default
            );
        }
        Assert.Equal("failed", run["status"]!.GetValue<string>());
        Assert.Contains("64 MiB", run["error"]!.GetValue<string>());
        Assert.Equal(1, calls);
        Assert.Equal("real", await File.ReadAllTextAsync(Path.Combine(f.Work, "before")));
        Assert.False(File.Exists(Path.Combine(f.Work, "after")));
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            run["runId"]!.GetValue<string>(),
            default
        );
        Assert.Equal(
            ToolScriptStdout.Limit,
            Encoding.UTF8.GetByteCount(record!["stdout"]!.GetValue<string>())
        );
        Assert.Null(record["snapshotBase64"]);
        Assert.Null(record["waiting"]);
        Assert.Equal('é', record["stdout"]!.GetValue<string>()[^1]);
    }

    [Fact]
    public async Task Active_cancel_returns_request_and_execution_owner_waits_for_started_hostwork_then_settles_cancelled()
    {
        await using var f = await ScriptFixture.Create();
        var reached = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        var context = Context(
            f,
            async (_, _, _) =>
            {
                calls++;
                var files = Directory.GetFiles(Path.Combine(f.Data, "state", "toolscript-runs"));
                var id = Path.GetFileNameWithoutExtension(files.Single());
                reached.SetResult(id);
                await release.Task;
                await File.WriteAllTextAsync(Path.Combine(f.Work, "settled-effect"), "real");
                return new JsonObject { ["value"] = false };
            }
        );
        var pending = f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject
            {
                ["code"] = "call_tool('read', {})\ncall_tool('write', {})\nreturn True\n",
            },
            context,
            default
        );
        var id = await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var request = await f.Manager.ToolScript.ExecuteAsync(
            "cancel_toolscript_run",
            new JsonObject { ["runId"] = id },
            context,
            default
        );
        Assert.True(request["cancellationRequested"]!.GetValue<bool>());
        Assert.Equal("running", request["status"]!.GetValue<string>());
        Assert.False(pending.IsCompleted);
        Assert.Equal(
            "running",
            (await f.Manager.ToolScript.Store.ReadAsync(id, default))!["status"]!.GetValue<string>()
        );
        release.SetResult();
        var final = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("cancelled", final["status"]!.GetValue<string>());
        Assert.Equal(1, calls);
        Assert.True(File.Exists(Path.Combine(f.Work, "settled-effect")));
        Assert.Equal(
            "cancelled",
            (await f.Manager.ToolScript.Store.ReadAsync(id, default))!["status"]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Waiting_save_fault_preserves_truthful_pre_or_postrename_state_without_replaying_effects(
        bool afterRename
    )
    {
        await using var f = await ScriptFixture.Create();
        var calls = 0;
        var writes = 0;
        f.Manager.ToolScript.Store.StageForTests = (_, stage) =>
        {
            if (
                stage
                    == (
                        afterRename
                            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            : AtomicJsonWriteStage.BeforeRename
                    )
                && ++writes == 2
            )
                throw new IOException("record boundary fault");
            return Task.CompletedTask;
        };
        var run = await f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject
            {
                ["code"] = "call_tool('write', {})\nask_agent('next')\nreturn True\n",
            },
            Context(
                f,
                (_, _, _) =>
                {
                    calls++;
                    return Task.FromResult(new JsonObject { ["value"] = 0 });
                }
            ),
            default
        );
        Assert.True(run["recordPersistenceFailed"]!.GetValue<bool>());
        Assert.Equal(1, calls);
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            run["runId"]!.GetValue<string>(),
            default
        );
        Assert.Equal(afterRename ? "waiting" : "running", record!["status"]!.GetValue<string>());
        Assert.Equal(afterRename, record["snapshotBase64"] is not null);
        Assert.Equal(afterRename, record["waiting"] is not null);
        Assert.Equal(afterRename, run["continuationId"] is not null);
        f.Manager.ToolScript.Store.StageForTests = null;
        if (afterRename)
        {
            var done = await f.Manager.ToolScript.ExecuteAsync(
                "continue_script",
                new JsonObject
                {
                    ["runId"] = record["runId"]!.DeepClone(),
                    ["continuationId"] = record["waiting"]!["continuationId"]!.DeepClone(),
                },
                Context(f),
                default
            );
            Assert.Equal("completed", done["status"]!.GetValue<string>());
        }
        else
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.ToolScript.ExecuteAsync(
                    "continue_script",
                    new JsonObject
                    {
                        ["runId"] = record["runId"]!.DeepClone(),
                        ["continuationId"] = "uncommitted",
                    },
                    Context(f),
                    default
                )
            );
    }

    [Fact]
    public async Task Managed_and_incompatible_records_remain_unchanged_and_concurrent_continue_is_single_execution()
    {
        await using var f = await ScriptFixture.Create();
        var run = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "ask_agent('next')\nreturn False\n" }
        );
        var id = run["runId"]!.GetValue<string>();
        var record = (await f.Manager.ToolScript.Store.ReadAsync(id, default))!;
        record["relatedManagedSessions"] = new JsonArray(
            new JsonObject { ["sessionId"] = "unknown", ["leaseId"] = "old" }
        );
        await f.Manager.ToolScript.Store.WriteAsync(record, default);
        var original = await File.ReadAllBytesAsync(f.Manager.ToolScript.Store.PathFor(id));
        foreach (var tool in new[] { "continue_script", "cancel_toolscript_run" })
            await Assert.ThrowsAsync<NotSupportedException>(() =>
                f.Manager.ToolScript.ExecuteAsync(tool, Resume(run), Context(f), default)
            );
        Assert.Equal(
            original,
            await File.ReadAllBytesAsync(f.Manager.ToolScript.Store.PathFor(id))
        );
        record["relatedManagedSessions"] = new JsonArray();
        record["vmRuntime"]!["version"] = "unknown";
        await f.Manager.ToolScript.Store.WriteAsync(record, default);
        original = await File.ReadAllBytesAsync(f.Manager.ToolScript.Store.PathFor(id));
        await Assert.ThrowsAsync<NotSupportedException>(() =>
            f.Manager.ToolScript.ExecuteAsync("continue_script", Resume(run), Context(f), default)
        );
        Assert.Equal(
            original,
            await File.ReadAllBytesAsync(f.Manager.ToolScript.Store.PathFor(id))
        );
        record["vmRuntime"]!["version"] = "0.0.19";
        var snapshot = record["snapshotBase64"]!.DeepClone();
        record["snapshotBase64"] = "not-valid-base64";
        await f.Manager.ToolScript.Store.WriteAsync(record, default);
        original = await File.ReadAllBytesAsync(f.Manager.ToolScript.Store.PathFor(id));
        await Assert.ThrowsAsync<FormatException>(() =>
            f.Manager.ToolScript.ExecuteAsync("continue_script", Resume(run), Context(f), default)
        );
        Assert.Equal(
            original,
            await File.ReadAllBytesAsync(f.Manager.ToolScript.Store.PathFor(id))
        );
        record["snapshotBase64"] = snapshot;
        await f.Manager.ToolScript.Store.WriteAsync(record, default);
        var first = f.Manager.ToolScript.ExecuteAsync(
            "continue_script",
            Resume(run),
            Context(f),
            default
        );
        var second = f.Manager.ToolScript.ExecuteAsync(
            "continue_script",
            Resume(run),
            Context(f),
            default
        );
        Assert.Equal("completed", (await first)["status"]!.GetValue<string>());
        await Assert.ThrowsAnyAsync<SystemException>(async () => await second);
    }

    [Fact]
    public async Task Native_self_and_nested_ancestor_cancellation_do_not_wait_on_their_own_settlement()
    {
        await using var f = await ScriptFixture.Create();
        var self = await f.Call(
                "run_script",
                new JsonObject
                {
                    ["code"] =
                        "runs=call_tool('list_toolscript_runs', {'status':'running'})['runs']\nr=runs[0]['runId']\ncall_tool('cancel_toolscript_run', {'runId':r})\ncall_tool('write', {'filePath':'self-after','content':'forbidden'})\nreturn True\n",
                }
            )
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("cancelled", self["status"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(f.Work, "self-after")));
        var child =
            "call_tool('cancel_toolscript_run', {'runId':args['parent']})\ncall_tool('write', {'filePath':'ancestor-after','content':'forbidden'})\nreturn True\n";
        var ancestor = await f.Call(
                "run_script",
                new JsonObject
                {
                    ["args"] = new JsonObject { ["child"] = child },
                    ["code"] =
                        "parent=call_tool('list_toolscript_runs', {'status':'running'})['runs'][0]['runId']\ncall_tool('run_script', {'code':args['child'], 'args':{'parent':parent}})\nreturn True\n",
                }
            )
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("cancelled", ancestor["status"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(f.Work, "ancestor-after")));
    }

    [Fact]
    public async Task Initial_record_failure_never_starts_VM_and_shutdown_drains_accepted_host_work_before_disposal()
    {
        await using var f = await ScriptFixture.Create();
        var calls = 0;
        f.Manager.ToolScript.Store.StageForTests = (_, stage) =>
            stage == AtomicJsonWriteStage.BeforeRename
                ? Task.FromException(new IOException("initial record boundary"))
                : Task.CompletedTask;
        var initial = await f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject { ["code"] = "call_tool('write', {})\nreturn True\n" },
            Context(
                f,
                (_, _, _) =>
                {
                    calls++;
                    return Task.FromResult(new JsonObject());
                }
            ),
            default
        );
        Assert.Equal(0, calls);
        Assert.True(initial["recordPersistenceFailed"]!.GetValue<bool>());
        Assert.False(f.Manager.ToolScript.Store.Exists(initial["runId"]!.GetValue<string>()));
        f.Manager.ToolScript.Store.StageForTests = null;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var active = f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject { ["code"] = "call_tool('write', {})\nreturn True\n" },
            Context(
                f,
                async (_, _, _) =>
                {
                    started.SetResult();
                    await release.Task;
                    return new JsonObject();
                }
            ),
            default
        );
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var drain = f.Manager.ToolScript.DisposeAsync().AsTask();
        Assert.False(drain.IsCompleted);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            f.Manager.ToolScript.ExecuteAsync(
                "list_toolscript_runs",
                new JsonObject(),
                Context(f),
                default
            )
        );
        release.SetResult();
        Assert.Equal(
            "cancelled",
            (await active.WaitAsync(TimeSpan.FromSeconds(5)))["status"]!.GetValue<string>()
        );
        await drain.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Terminal_save_fault_reports_committed_state_and_retains_started_effects(
        bool afterRename
    )
    {
        await using var f = await ScriptFixture.Create();
        var calls = 0;
        var writes = 0;
        f.Manager.ToolScript.Store.StageForTests = (_, stage) =>
        {
            if (
                stage
                    == (
                        afterRename
                            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            : AtomicJsonWriteStage.BeforeRename
                    )
                && ++writes == 2
            )
                throw new IOException("terminal boundary");
            return Task.CompletedTask;
        };
        var result = await f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject { ["code"] = "call_tool('write', {})\nreturn False\n" },
            Context(
                f,
                (_, _, _) =>
                {
                    calls++;
                    return Task.FromResult(new JsonObject());
                }
            ),
            default
        );
        Assert.Equal(1, calls);
        Assert.True(result["recordPersistenceFailed"]!.GetValue<bool>());
        Assert.Equal(afterRename ? "completed" : "running", result["status"]!.GetValue<string>());
        Assert.Equal(afterRename, result.ContainsKey("result"));
        var record = (
            await f.Manager.ToolScript.Store.ReadAsync(result["runId"]!.GetValue<string>(), default)
        )!;
        Assert.Equal(afterRename ? "completed" : "running", record["status"]!.GetValue<string>());
        Assert.Null(record["snapshotBase64"]);
        Assert.Null(record["waiting"]);
    }

    [Fact]
    public async Task Native_wide_repeated_none_result_obeys_combined_parent_budget_after_real_started_effect()
    {
        await using var f = await ScriptFixture.Create();
        var result = await f.Call(
                "run_script",
                new JsonObject
                {
                    ["code"] =
                        "call_tool('write', {'filePath':'budget-before','content':'real'})\nreturn [None] * 2900000\n",
                }
            )
            .WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal("failed", result["status"]!.GetValue<string>());
        Assert.Contains("1 GiB", result["error"]!.GetValue<string>());
        Assert.Equal("real", await File.ReadAllTextAsync(Path.Combine(f.Work, "budget-before")));
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            result["runId"]!.GetValue<string>(),
            default
        );
        Assert.Equal("failed", record!["status"]!.GetValue<string>());
        Assert.Null(record["lastResult"]);
        Assert.Null(record["snapshotBase64"]);
    }
}
