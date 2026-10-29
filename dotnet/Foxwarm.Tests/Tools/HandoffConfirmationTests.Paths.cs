using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class HandoffConfirmationTests
{
    [Theory]
    [InlineData("direct")]
    [InlineData("unified")]
    [InlineData("native")]
    [InlineData("management")]
    [InlineData("script")]
    public async Task Supported_send_and_child_paths_require_final_consent_before_effects(string path)
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        var models = HostModels.Parse(
            Obj("""{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]}}}"""),
            new JsonObject { ["handoffConfirmation"] = true }
        );
        await using var manager = new SessionManager(data, work, options, models);
        await manager.LoadMainHostAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var target = await manager.CreateNamedAsync("main", "target", null, null);
        parent.Registry.TriggerOverride = _ => Task.CompletedTask;
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        manager.TopologyChanged += () =>
        {
            foreach (var owner in manager.Owners())
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        };
        var definitions = manager.ModelDefinitions(parent);
        var registry = SessionToolExecutor.CreateRegistry(
            definitions, manager.OutboundMcp, _ => work, manager.Nodes, manager.NodeProviders
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(work), parent, manager, registry);
        tools.BeginTurn();

        async Task<JsonObject> Execute(string name, JsonObject args)
        {
            if (path == "management")
                return (await manager.ExecuteAgentToolAsync(parent, name, args)).Response;
            if (path == "native")
                return (await registry.ExecuteAsync(new("native", "builtin", name, args), tools, default))!.AsObject();
            var callName = path == "script" ? "run_script" : path == "unified" ? "call_tool" : name;
            var callArgs = path == "script"
                ? new JsonObject { ["code"] = "return call_tool('" + name + "', args)", ["args"] = args }
                : path == "unified"
                    ? new JsonObject { ["toolId"] = "builtin:" + name, ["args"] = args }
                    : args;
            return (await tools.ExecuteAsync(new JsonObject { ["id"] = "handoff", ["name"] = callName, ["args"] = callArgs }, default))!.AsObject();
        }

        foreach (var name in new[] { "send_to_session", "create_child_session" })
        {
            JsonObject Input(JsonNode? confirmation) => new()
            {
                [name == "send_to_session" ? "sessionId" : "suffix"] = name == "send_to_session" ? target.Id : "worker",
                ["handoffRecall"] = "The assigned recipient needs the bounded work result.",
                ["message"] = "handoff payload",
                ["handoffConfirmation"] = confirmation,
            };
            foreach (var ending in new[] { "missing", "nonempty", "wrong", "nonterminal" })
            {
                var invalid = Input(ending switch
                {
                    "nonempty" => "Reviewed and found an unresolved blocker.",
                    "wrong" => "Reviewed. I confirm this handoff may proceed.",
                    "nonterminal" => Review() + " Cancel instead.",
                    _ => null,
                });
                if (ending == "missing")
                    invalid.Remove("handoffConfirmation");
                var rejected = await Execute(name, invalid);
                Assert.NotNull(rejected["error"] ?? rejected["result"]?["error"]);
                Assert.Equal(name == "send_to_session" ? 0 : 1, target.Entry.Snapshot().Queue.Count);
                Assert.Null(manager.Catalog.Get(parent.Id + "_worker"));
            }
            var approved = Input(Review());
            if (name == "create_child_session")
                approved.Remove("message");
            var result = await Execute(name, approved);
            Assert.Null(result["error"]);
            Assert.Null(result["result"]?["error"]);
            if (name == "send_to_session")
            {
                var incoming = Assert.Single(target.Entry.Snapshot().Queue);
                var delivered = string.Join("", incoming.Parts!.Select(part => part.ToJsonString()));
                Assert.Contains("handoff payload", delivered);
                Assert.DoesNotContain("handoffRecall", delivered);
                Assert.DoesNotContain("handoffConfirmation", delivered);
                Assert.DoesNotContain("bounded work result", delivered);
                Assert.DoesNotContain("I confirm this handoff should proceed.", delivered);
            }
            else
                Assert.NotNull(manager.Catalog.Get(parent.Id + "_worker"));
        }

        var task = await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "bounded work", ["description"] = "stored task description" }, parent.Id
        );
        var assigned = await Execute("create_child_session", new JsonObject
        {
            ["suffix"] = "assigned", ["taskId"] = task.Payload["task"]!["id"]!.GetValue<string>(),
            ["handoffRecall"] = "The child needs the stored assignment and this additional result.",
            ["message"] = "additional task context", ["handoffConfirmation"] = Review()
        });
        Assert.Null(assigned["error"]);
        Assert.Null(assigned["result"]?["error"]);
        var child = await manager.RequiredAsync(parent.Id + "_assigned");
        var assignment = Assert.Single(child.Entry.Snapshot().Queue);
        var assignmentText = string.Join("", assignment.Parts!.Select(part => part.ToJsonString()));
        Assert.Contains("stored task description", assignmentText);
        Assert.Contains("additional task context", assignmentText);
        Assert.DoesNotContain("The child needs the stored assignment", assignmentText);
        Assert.DoesNotContain("I confirm this handoff should proceed.", assignmentText);
    }
}
