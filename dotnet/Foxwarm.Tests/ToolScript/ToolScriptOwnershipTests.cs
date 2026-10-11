using System.Text.Json.Nodes;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptOwnershipTests
{
    private static SessionToolExecutor Dispatcher(ScriptFixture f)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in UnifiedToolDefinitions.All())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in LocalExecManager.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in AgentToolDefinitions.Definitions())
            definitions.Add(definition.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var dispatcher = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            registry
        );
        dispatcher.BeginTurn();
        return dispatcher;
    }

    private static async Task<JsonObject> Call(
        SessionToolExecutor dispatcher,
        string name,
        JsonObject args
    ) => (await dispatcher.ExecuteAsync(
            new JsonObject
            {
                ["id"] = "ownership",
                ["name"] = name,
                ["args"] = args,
            },
            default
        ))!.AsObject();

    [Fact]
    public async Task Self_move_then_nested_pause_creates_new_owner_record_without_rewriting_outer_or_literal_caller()
    {
        await using var f = await ScriptFixture.Create();
        var dispatcher = Dispatcher(f);
        var old = f.Owner.Id;
        var child = "ask_agent('nested')\nreturn 11\n";
        var outer = await Call(
            dispatcher,
            "run_script",
            new JsonObject
            {
                ["args"] = new JsonObject { ["child"] = child },
                ["code"] =
                    "call_tool('move_session', {'newSessionId':'moved'})\nx=call_tool('run_script', {'code':args['child']})\ntry:\n    call_tool('get_toolscript_run', {'runId':x['runId']})\nexcept RuntimeError:\n    return {'child':x,'oldCallerRejected':True}\nreturn {'child':x,'oldCallerRejected':False}\n",
            }
        );
        Assert.Equal("completed", outer["status"]!.GetValue<string>());
        Assert.Equal("moved", f.Owner.Id);
        Assert.True(outer["result"]!["oldCallerRejected"]!.GetValue<bool>());
        var nested = outer["result"]!["child"]!;
        var id = nested["runId"]!.GetValue<string>();
        var outerRecord = (
            await f.Manager.ToolScript.Store.ReadAsync(outer["runId"]!.GetValue<string>(), default)
        )!;
        var childRecord = (await f.Manager.ToolScript.Store.ReadAsync(id, default))!;
        Assert.Equal(old, outerRecord["ownerSessionId"]!.GetValue<string>());
        Assert.Equal(f.Owner.Id, childRecord["ownerSessionId"]!.GetValue<string>());
        var inspected = await Call(
            dispatcher,
            "get_toolscript_run",
            new JsonObject { ["runId"] = id }
        );
        Assert.Null(inspected["error"]);
        var done = await Call(
            dispatcher,
            "continue_script",
            new JsonObject
            {
                ["runId"] = id,
                ["continuationId"] = nested["continuationId"]!.DeepClone(),
                ["input"] = "new caller",
            }
        );
        Assert.Equal("completed", done["status"]!.GetValue<string>());
        Assert.Equal(11, done["result"]!.GetValue<long>());
        Assert.Equal(
            old,
            (
                await f.Manager.ToolScript.Store.ReadAsync(
                    outer["runId"]!.GetValue<string>(),
                    default
                )
            )!["ownerSessionId"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Moved_owner_can_cancel_new_nested_active_run_using_the_same_owner_as_its_persisted_record()
    {
        await using var f = await ScriptFixture.Create();
        var dispatcher = Dispatcher(f);
        var old = f.Owner.Id;
        var born = Path.Combine(f.Work, "born");
        var forbidden = Path.Combine(f.Work, "forbidden");
        var shell = "printf born > '" + born + "'; sleep 2";
        var child =
            "call_tool('exec', {'command':"
            + System.Text.Json.JsonSerializer.Serialize(shell)
            + ", 'timeout':10})\ncall_tool('write', {'filePath':'forbidden','content':'wrong'})\nreturn True\n";
        var execution = Call(
            dispatcher,
            "run_script",
            new JsonObject
            {
                ["args"] = new JsonObject { ["child"] = child },
                ["code"] =
                    "call_tool('move_session', {'newSessionId':'moved'})\nreturn call_tool('run_script', {'code':args['child']})\n",
            }
        );
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!File.Exists(born))
            await Task.Delay(10, deadline.Token);
        var records = new List<JsonObject>();
        foreach (var file in Directory.GetFiles(Path.Combine(f.Data, "state", "toolscript-runs")))
            records.Add(
                (
                    await f.Manager.ToolScript.Store.ReadAsync(
                        Path.GetFileNameWithoutExtension(file),
                        default
                    )
                )!
            );
        var childRecord = Assert.Single(
            records,
            record => record["ownerSessionId"]!.GetValue<string>() == f.Owner.Id
        );
        var outerRecord = Assert.Single(
            records,
            record => record["ownerSessionId"]!.GetValue<string>() == old
        );
        var id = childRecord["runId"]!.GetValue<string>();
        var cancelled = await Call(
            dispatcher,
            "cancel_toolscript_run",
            new JsonObject { ["runId"] = id }
        );
        Assert.Null(cancelled["error"]);
        Assert.True(cancelled["cancellationRequested"]!.GetValue<bool>());
        Assert.Equal("running", cancelled["status"]!.GetValue<string>());
        var done = await execution.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("completed", done["status"]!.GetValue<string>());
        Assert.Equal("cancelled", done["result"]!["status"]!.GetValue<string>());
        Assert.False(File.Exists(forbidden));
        var settled = (await f.Manager.ToolScript.Store.ReadAsync(id, default))!;
        Assert.Equal(f.Owner.Id, settled["ownerSessionId"]!.GetValue<string>());
        Assert.Equal("cancelled", settled["status"]!.GetValue<string>());
        Assert.Equal(
            old,
            (
                await f.Manager.ToolScript.Store.ReadAsync(
                    outerRecord["runId"]!.GetValue<string>(),
                    default
                )
            )!["ownerSessionId"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Normal_created_and_updated_runs_list_newest_first_and_native_nested_limit_one_is_honored()
    {
        await using var f = await ScriptFixture.Create();
        var paused = new List<JsonObject>();
        for (var index = 0; index < 5; index++)
        {
            paused.Add(
                await f.Call(
                    "run_script",
                    new JsonObject { ["code"] = "ask_agent('next')\nreturn 1\n" }
                )
            );
            await Task.Delay(10);
        }
        var expected = paused
            .AsEnumerable()
            .Reverse()
            .Select(run => run["runId"]!.GetValue<string>())
            .ToArray();
        var initial = await f.Call(
            "list_toolscript_runs",
            JsonNode.Parse("{\"limit\":5}")!.AsObject()
        );
        Assert.Equal(
            expected,
            initial["runs"]!.AsArray().Select(run => run!["runId"]!.GetValue<string>()).ToArray()
        );
        foreach (var index in new[] { 1, 4, 0, 3, 2 })
        {
            var run = paused[index];
            await f.Call(
                "continue_script",
                new JsonObject
                {
                    ["runId"] = run["runId"]!.DeepClone(),
                    ["continuationId"] = run["continuationId"]!.DeepClone(),
                }
            );
            var updated = await f.Call(
                "list_toolscript_runs",
                JsonNode.Parse("{\"limit\":5}")!.AsObject()
            );
            Assert.Equal(
                run["runId"]!.GetValue<string>(),
                updated["runs"]![0]!["runId"]!.GetValue<string>()
            );
            await Task.Delay(10);
        }
        var nested = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('list_toolscript_runs', {'limit':1,'status':'completed'})['runs']\n",
            }
        );
        var row = Assert.Single(nested["result"]!.AsArray());
        Assert.Equal(paused[2]["runId"]!.GetValue<string>(), row!["runId"]!.GetValue<string>());
    }
}
