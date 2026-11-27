using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// The handoff review checkpoint was removed. Persisted ToolScripts, skills and models with older
// history keep passing its fields, and existing configs keep the startup key; both are ignored.
public sealed class RemovedHandoffFieldsTests
{
    private static JsonObject Obj(string raw) => JsonNode.Parse(raw)!.AsObject();

    private const string Models =
        """{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]}}}""";

    [Theory]
    [InlineData("true")]
    [InlineData("false")]
    public async Task Configs_with_the_old_startup_key_still_start(string value)
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(root, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(root, "state", "models.yaml"),
            "default: a\nproviders: {a: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}}\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(root, "state", "config.yaml"),
            "handoffConfirmation: " + value + "\n"
        );
        var configuration = new ModelConfiguration(root);
        Assert.Equal("a", configuration.Models.DefaultKey);
    }

    [Fact]
    public void Handoff_schemas_do_not_declare_the_removed_fields()
    {
        foreach (var definition in AgentToolDefinitions.Definitions().OfType<JsonObject>())
        {
            var parameters = definition["parameters"]!.AsObject();
            Assert.False(parameters["properties"]!.AsObject().ContainsKey("handoffRecall"));
            Assert.False(parameters["properties"]!.AsObject().ContainsKey("handoffConfirmation"));
        }
    }

    [Theory]
    [InlineData("direct")]
    [InlineData("unified")]
    [InlineData("native")]
    [InlineData("management")]
    [InlineData("script")]
    public async Task Supported_send_and_child_paths_ignore_the_removed_fields(
        string path
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
        var models = HostModels.Parse(Obj(Models), new JsonObject { ["handoffConfirmation"] = true });
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
            definitions,
            manager.OutboundMcp,
            _ => work,
            manager.Nodes,
            manager.NodeProviders
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(work), parent, manager, registry);
        tools.BeginTurn();

        async Task<JsonObject> Execute(string name, JsonObject args)
        {
            if (path == "management")
                return (await manager.ExecuteAgentToolAsync(parent, name, args)).Response;
            if (path == "native")
                return (
                    await registry.ExecuteAsync(
                        new("native", "builtin", name, args),
                        tools,
                        default
                    )
                )!.AsObject();
            var callName =
                path == "script" ? "run_script"
                : path == "unified" ? "ctl"
                : name;
            var callArgs =
                path == "script"
                    ? new JsonObject
                    {
                        ["code"] = "return call_tool('" + name + "', args)",
                        ["args"] = args,
                    }
                : path == "unified"
                    ? CtlTestArgs.Unified(new JsonObject { ["toolId"] = "builtin:" + name, ["args"] = args })
                : args;
            return (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "handoff",
                        ["name"] = callName,
                        ["args"] = callArgs,
                    },
                    default
                )
            )!.AsObject();
        }

        foreach (var name in new[] { "send_to_session", "create_child_session" })
        {
            // Old callers sent the review fields in this order; values are no longer checked.
            var input = new JsonObject
            {
                [name == "send_to_session" ? "sessionId" : "suffix"] =
                    name == "send_to_session" ? target.Id : "worker",
                ["handoffRecall"] = "The assigned recipient needs the bounded work result.",
                ["message"] = "handoff payload",
                ["currentSessionTurnAction"] = "continue",
                ["handoffConfirmation"] = 123,
            };
            if (name == "create_child_session")
                input.Remove("message");
            var result = await Execute(name, input);
            Assert.Null(result["error"]);
            Assert.Null(result["result"]?["error"]);
            if (name == "send_to_session")
            {
                var incoming = Assert.Single(target.Entry.Snapshot().Queue);
                var delivered = string.Join(
                    "",
                    incoming.Parts!.Select(part => part.ToJsonString())
                );
                Assert.Contains("handoff payload", delivered);
                Assert.DoesNotContain("handoffRecall", delivered);
                Assert.DoesNotContain("handoffConfirmation", delivered);
                Assert.DoesNotContain("bounded work result", delivered);
            }
            else
            {
                var worker = await manager.RequiredAsync(parent.Id + "_worker");
                var boundary = string.Join(
                    "\n",
                    worker
                        .Entry.Snapshot()
                        .History.Materialize()
                        .SelectMany(message => message["parts"]!.AsArray())
                        .Select(part => part?["system"]?.GetValue<string>())
                        .Where(value => value is not null)
                );
                Assert.Contains("send_to_session(", boundary);
                Assert.DoesNotContain("handoffRecall", boundary);
            }
        }

        var task = await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "bounded work",
                ["description"] = "stored task description",
            },
            parent.Id
        );
        var assigned = await Execute(
            "create_child_session",
            new JsonObject
            {
                ["suffix"] = "assigned",
                ["taskId"] = task.Payload["task"]!["id"]!.GetValue<string>(),
                ["handoffRecall"] =
                    "The child needs the stored assignment and this additional result.",
                ["message"] = "additional task context",
                ["handoffConfirmation"] = "Reviewed. I confirm this handoff should proceed.",
            }
        );
        Assert.Null(assigned["error"]);
        Assert.Null(assigned["result"]?["error"]);
        var child = await manager.RequiredAsync(parent.Id + "_assigned");
        var assignment = Assert.Single(child.Entry.Snapshot().Queue);
        var assignmentText = string.Join("", assignment.Parts!.Select(part => part.ToJsonString()));
        Assert.Contains("stored task description", assignmentText);
        Assert.Contains("additional task context", assignmentText);
        Assert.DoesNotContain("The child needs the stored assignment", assignmentText);
        Assert.DoesNotContain("I confirm this handoff should proceed.", assignmentText);

        // Unknown arguments other than the removed fields are still rejected before effects.
        var unknown = await Execute(
            "send_to_session",
            new JsonObject
            {
                ["sessionId"] = target.Id,
                ["message"] = "must not arrive",
                ["handoffReview"] = "not a former field",
            }
        );
        Assert.NotNull(unknown["error"] ?? unknown["result"]?["error"]);
        Assert.Single(target.Entry.Snapshot().Queue);
    }
}
