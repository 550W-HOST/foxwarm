using System.Text.Json.Nodes;
using Foxwarm.Limits;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests.Limits;

// The ToolScript limit counts top-level runs: a nested run uses its root run's slot.
public sealed class TenantLimitToolScriptTests
{
    private static SessionToolExecutor Dispatcher(ScriptFixture f)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in UnifiedToolDefinitions.All())
            definitions.Add(definition?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var dispatcher = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
        dispatcher.BeginTurn();
        return dispatcher;
    }

    private static async Task<JsonObject> RunAsync(SessionToolExecutor dispatcher, string code) =>
        (
            await dispatcher.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "limits",
                    ["name"] = "run_script",
                    ["args"] = new JsonObject { ["code"] = code },
                },
                default
            )
        )!.AsObject();

    [Fact]
    public async Task ANestedRunUsesItsRootRunsSlot()
    {
        await using var f = await ScriptFixture.Create();
        var slots = new AdmissionSlots(1);
        f.Manager.ToolScript.AdmitProcess = slots.EnterAsync;
        var dispatcher = Dispatcher(f);
        var outer = await RunAsync(
                dispatcher,
                "x = call_tool('run_script', {'code': 'return 41'})\nreturn x['result'] + 1\n"
            )
            .WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal("completed", outer["status"]!.GetValue<string>());
        Assert.Equal(42, outer["result"]!.GetValue<int>());
        Assert.Equal(0, slots.InUse);
    }

    [Fact]
    public async Task AFailedWorkerDisposalStillReturnsTheSlotAndEndsTheRun()
    {
        await using var f = await ScriptFixture.Create();
        var slots = new AdmissionSlots(1);
        f.Manager.ToolScript.AdmitProcess = slots.EnterAsync;
        f.Manager.ToolScript.WorkerDisposedForTest = () => throw new IOException("synthetic disposal failure");
        var dispatcher = Dispatcher(f);
        await Assert.ThrowsAnyAsync<Exception>(async () =>
        {
            var result = await RunAsync(dispatcher, "return 1\n");
            throw new InvalidOperationException(result.ToJsonString());
        });
        Assert.Equal(0, slots.InUse);
        Assert.False(f.Manager.ToolScript.Holds(f.Owner));
        f.Manager.ToolScript.WorkerDisposedForTest = null;
        var next = await RunAsync(dispatcher, "return 2\n").WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(2, next["result"]!.GetValue<int>());
    }
}
