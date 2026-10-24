using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;

namespace Foxwarm.Tests;

public sealed class MainToolScriptTests
{
    internal sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        internal ToolRegistry Registry = null!;
        internal Foxwarm.McpClient Mcp => mcp;
        private Foxwarm.McpClient mcp = null!;

        internal static async Task<Fixture> Create(
            string? skillsRoot = null,
            ResponsesClientOptions? suppliedOptions = null
        )
        {
            var f = new Fixture();
            Console.WriteLine("Owned ToolScript fixture=" + f.Temp.Path);
            try
            {
                var options =
                    suppliedOptions
                    ?? new ResponsesClientOptions(
                        new Uri("http://127.0.0.1:1"),
                        "wire",
                        "a",
                        "",
                        "",
                        713
                    );
                f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options), skillsRoot);
                await f.Manager.LoadMainHostAsync();
                f.Owner = await f.Manager.CreateNamedAsync("main", "script", null, null);
                f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
                f.mcp = new(f.Data);
                var definitions = WorkspaceTools.Definitions();
                definitions.Add(ArchiveRecallTool.Definition());
                foreach (var item in FileDeliveryDefinitions.Definitions())
                    definitions.Add(item?.DeepClone());
                foreach (var item in KnowledgeToolDefinitions.Definitions())
                    definitions.Add(item?.DeepClone());
                foreach (var item in ObservationToolDefinitions.Definitions())
                    definitions.Add(item?.DeepClone());
                foreach (var item in ToolScriptToolDefinitions.Definitions())
                    definitions.Add(item?.DeepClone());
                foreach (var item in UnifiedToolDefinitions.All())
                    definitions.Add(item?.DeepClone());
                foreach (var item in LocalExecManager.Definitions())
                    definitions.Add(item?.DeepClone());
                var registry = f.Registry = SessionToolExecutor.CreateRegistry(
                    definitions,
                    f.mcp,
                    _ => f.Work
                );
                f.Tools = new(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
                f.Tools.BeginTurn();
                return f;
            }
            catch
            {
                await f.DisposeAsync();
                throw;
            }
        }

        internal async Task<JsonObject> Call(string name, JsonObject args) =>
            (
                await Tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "outer-script",
                        ["name"] = name,
                        ["args"] = args.DeepClone(),
                    },
                    default
                )
            )!.AsObject();

        public async ValueTask DisposeAsync()
        {
            if (Manager is not null)
            {
                await Manager.ShutdownAsync();
                await Manager.DisposeAsync();
            }
            if (mcp is not null)
                await mcp.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Successful_nested_file_delivery_preserves_structured_receipt_without_extra_history_or_notifications()
    {
        await using var f = await Fixture.Create();
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        var path = Path.Combine(f.Work, "nested.txt");
        await File.WriteAllTextAsync(path, "nested bytes");
        var before = f.Owner.History().Select(row => row.ToJsonString()).ToArray();
        var completed = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "result = call_tool({'toolId':'builtin:send_file'}, {'filePath':'nested.txt'})\nprint('ordinary stdout')\nreturn {'nested': [result]}\n",
            }
        );
        Assert.True(SessionWait.Text(completed["status"]) == "completed", completed.ToJsonString());
        var delivery = completed["result"]!["nested"]![0]!["fileDelivery"]!;
        Assert.Equal(f.Owner.Id, SessionWait.Text(delivery["targetId"]));
        Assert.Equal(path, SessionWait.Text(delivery["downloadPath"]));
        Assert.Equal("nested.txt", SessionWait.Text(delivery["fileName"]));
        Assert.Equal("text/plain", SessionWait.Text(delivery["mimeType"]));
        Assert.Equal(12, delivery["sizeBytes"]!.GetValue<long>());
        Assert.Equal(before, f.Owner.History().Select(row => row.ToJsonString()));
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        var runId = SessionWait.Text(completed["runId"])!;
        var inspected = await f.Call("get_toolscript_run", new JsonObject { ["runId"] = runId });
        Assert.Equal(
            SessionWait.Text(delivery["deliveryId"]),
            SessionWait.Text(inspected["result"]?["nested"]?[0]?["fileDelivery"]?["deliveryId"])
        );
    }

    [Fact]
    public async Task Real_native_run_normal_read_write_then_pause_fresh_host_continue_without_rereading_source()
    {
        await using var f = await Fixture.Create();
        await File.WriteAllTextAsync(Path.Combine(f.Work, "input.txt"), "hello 🦊\n");
        var script =
            "data = call_tool('read', {'filePath': 'input.txt'})\ncall_tool('write', {'filePath': 'effect.txt', 'content': data['content']})\nprint('before')\nanswer = ask_agent('Next?')\nprint('after')\nreturn {'false': False, 'zero': 0, 'nothing': None, 'answer': answer}\n";
        await File.WriteAllTextAsync(Path.Combine(f.Work, "program.py"), script);
        var waiting = await f.Call(
            "run_script",
            new JsonObject { ["filePath"] = "program.py", ["mode"] = "background" }
        );
        Assert.Null(waiting["error"]);
        Assert.Equal("waiting", waiting["status"]!.GetValue<string>());
        Assert.Equal("before\n", waiting["stdout"]!.GetValue<string>());
        Assert.Equal("hello 🦊\n", await File.ReadAllTextAsync(Path.Combine(f.Work, "effect.txt")));
        var id = waiting["runId"]!.GetValue<string>();
        var continuation = waiting["continuationId"]!.GetValue<string>();
        await File.WriteAllTextAsync(
            Path.Combine(f.Work, "program.py"),
            "raise RuntimeError('must not reread')"
        );
        await f.Manager.ToolScript.DisposeAsync();
        await using var restarted = new MainToolScript(f.Data);
        var context = new ToolScriptContext(
            f.Owner,
            f.Owner.Id,
            (_, _, _) => throw new InvalidOperationException("No repeated tool effects."),
            (_, _, _, _) => throw new InvalidOperationException("No model call."),
            (_, _, _) => throw new InvalidOperationException("No source reread.")
        );
        var completed = await restarted.ExecuteAsync(
            "continue_script",
            new JsonObject
            {
                ["runId"] = id,
                ["continuationId"] = continuation,
                ["input"] = "yes",
            },
            context,
            default
        );
        Assert.Equal("completed", completed["status"]!.GetValue<string>());
        Assert.Equal("after\n", completed["stdout"]!.GetValue<string>());
        var result = completed["result"]!.AsObject();
        Assert.False(result["false"]!.GetValue<bool>());
        Assert.Equal(0, result["zero"]!.GetValue<long>());
        Assert.True(result.ContainsKey("nothing"));
        Assert.Null(result["nothing"]);
        Assert.Equal("yes", result["answer"]!.GetValue<string>());
        var inspected = await restarted.ExecuteAsync(
            "get_toolscript_run",
            new JsonObject { ["runId"] = id },
            context,
            default
        );
        Assert.Equal("before\nafter\n", inspected["stdout"]!.GetValue<string>());
        Assert.Equal(2, inspected["executedTools"]!.AsArray().Count);
    }

    [Fact]
    public async Task Legacy_main_args_and_real_native_OS_denial_do_not_create_host_files()
    {
        await using var f = await Fixture.Create();
        var result = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] = "def main(args):\n    return args['value']\n",
                ["argsJson"] = "{\"value\":0}",
            }
        );
        Assert.Equal("completed", result["status"]!.GetValue<string>());
        Assert.Equal(0, result["result"]!.GetValue<long>());
        var denied = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "from pathlib import Path\ntry:\n    Path('forbidden').write_text('x')\nexcept PermissionError:\n    return 'denied'\n",
            }
        );
        Assert.Equal("completed", denied["status"]!.GetValue<string>());
        Assert.Equal("denied", denied["result"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(f.Work, "forbidden")));
    }

    [Fact]
    public async Task Official_monty_can_call_targeted_session_status_through_the_direct_path()
    {
        await using var f = await Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "monty-status-target", null, null);
        var parent = await f.Manager.CreateNamedAsync("main", "monty-parent-target", null, null);
        var child = await f.Manager.CreateNamedAsync("main", "monty-child-target", null, null);
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    $"status = call_tool('session', {{'action': 'status', 'sessionId': '{target.Id}'}})\n"
                    + $"parent = call_tool('session', {{'action': 'update-parent', 'sessionId': '{child.Id}', 'parentSessionId': '{parent.Id}'}})\n"
                    + "return {'status': status['output'], 'parent': parent}\n",
            }
        );
        Assert.True(run["status"]?.GetValue<string>() == "completed", run.ToJsonString());
        var result = run["result"]!.AsObject();
        Assert.Contains($"session id: `{target.Id}`", result["status"]!.GetValue<string>());
        Assert.Equal(child.Id, result["parent"]!["sessionId"]!.GetValue<string>());
        Assert.Equal(parent.Id, result["parent"]!["parentSessionId"]!.GetValue<string>());
    }

    [Fact]
    public async Task Native_unknown_hostcall_exception_is_catchable_but_not_a_fake_managed_result()
    {
        await using var f = await Fixture.Create();
        var result = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "try:\n    session_create()\nexcept RuntimeError as e:\n    return str(e)\n",
            }
        );
        Assert.Equal("completed", result["status"]!.GetValue<string>());
        Assert.Contains("not available", result["result"]!.GetValue<string>());
    }
}
