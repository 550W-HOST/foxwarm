using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class LegacyWaitAuthorityTests
{

    [Fact]
    public async Task Current_wait_tool_still_requires_two_distinct_targets_without_mutating_an_existing_wait()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        var definitions = new JsonArray(WaitToolDefinitions.Definition());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            registry
        );
        tools.BeginTurn();
        async Task<JsonObject> Wait(JsonArray targets) =>
            (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "current-wait",
                        ["name"] = "wait",
                        ["args"] = new JsonObject { ["waitAllSessions"] = targets },
                    },
                    default
                )
            )!.AsObject();
        await f.Manager.DeclareWaitAsync(f.Owner, new JsonObject { ["waitForInput"] = true });
        var before = f.Owner.WaitSnapshot()!.DeepClone();
        var file = Path.Combine(f.Data, "state", "sessions", f.Owner.Id + ".json");
        var persisted = await File.ReadAllTextAsync(file);
        foreach (
            var targets in new[] { new JsonArray(first.Id), new JsonArray(first.Id, first.Id) }
        )
        {
            var rejected = await Wait(targets);
            Assert.NotNull(rejected["error"]);
            Assert.True(JsonNode.DeepEquals(before, f.Owner.WaitSnapshot()));
            Assert.Equal(persisted, await File.ReadAllTextAsync(file));
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        }
        var accepted = await Wait(new JsonArray(first.Id, second.Id));
        Assert.Null(accepted["error"]);
        var wait = f.Owner.WaitSnapshot()!;
        Assert.Equal(1, wait["declarationVersion"]!.GetValue<int>());
        Assert.Equal(
            new[] { first.Id, second.Id },
            SessionWait.Strings(wait["waitAll"]!["sessions"])
        );
    }
}
