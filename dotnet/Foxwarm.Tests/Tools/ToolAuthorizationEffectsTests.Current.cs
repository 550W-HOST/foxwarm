using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Actual_Task_authority_is_canonical_and_changes_next_direct_unified_and_native_script_evaluation()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        async Task<string> Create(string? assigned, string actor = "direct", bool user = false)
        {
            var args = new JsonObject
            {
                ["action"] = "create",
                ["title"] = "policy task",
                ["ownerSessionId"] = assigned,
                ["notifySession"] = false,
            };
            var result = user
                ? await manager.Tasks.ExecuteAsUserAsync(args)
                : (await manager.Tasks.ExecuteAsync(args, actor)).Payload;
            return result["task"]!["id"]!.GetValue<string>();
        }
        var own = await Create("self");
        var creatorOnly = await Create("kid", "self");
        var unowned = await Create(null, "self");
        var userOwned = await Create("self", user: true);
        var taskDefinition = manager
            .ModelDefinitions(owner)
            .OfType<JsonObject>()
            .Single(value => SessionWait.Text(value["name"]) == "task");
        Assert.Contains(
            "owned",
            taskDefinition["parameters"]!["properties"]!["scope"]!["enum"]!
                .AsArray()
                .Select(SessionWait.Text)
        );
        var owned = await manager.Tasks.ExecuteAsync(
            Obj("""{"action":"list","scope":"owned"}"""),
            "self"
        );
        Assert.Equal(
            new[] { own, userOwned }.Order(),
            owned.Payload["tasks"]!
                .AsArray()
                .Select(task => task!["id"]!.GetValue<string>())
                .Order()
        );
        var defaultList = await Call(execution.Tools, "task", Obj("""{"action":"list"}"""));
        Assert.Equal(4, defaultList["total"]!.GetValue<int>());
        // Shared note/description authority is unchanged without the optional ownership policy.
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "task",
                    new JsonObject
                    {
                        ["action"] = "update",
                        ["taskId"] = creatorOnly,
                        ["note"] = "shared",
                    }
                )
            )
        );
        await Policy(
            manager,
            """
            version: 1
            defaultAction: deny
            rules:
            - action: allow
              tool: {source: builtin, name: run_script}
            - action: allow
              tool: {source: builtin, name: task}
              args:
                action: [get, list]
            - action: allow
              session: opaque
              tool: {source: builtin, name: task}
              args:
                taskId: {task: {owned: true}}
            """
        );
        async Task<JsonObject> Update(string id, string entry = "task")
        {
            var args = new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["description"] = "owned change",
            };
            return await Call(
                execution.Tools,
                entry,
                entry == "call_tool"
                    ? new JsonObject { ["toolId"] = "builtin:task", ["args"] = args }
                    : args
            );
        }
        Assert.True(manager.ToolVisible(owner, "builtin", "task"));
        Assert.Null(Error(await Update(own)));
        Assert.Null(Error(await Update(userOwned, "call_tool")));
        foreach (var id in new[] { creatorOnly, unowned, "task_missing" })
            Assert.Equal("tool_authorization_denied", Error(await Update(id)));
        var script = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('task', {'action':'update','taskId':args['task'],'note':'native owned'})",
                ["args"] = new JsonObject { ["task"] = own },
            }
        );
        Assert.Null(Error(script));
        var changed = await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "get", ["taskId"] = own },
            owner.Id
        );
        Assert.Contains(
            changed.Payload["notes"]!.AsArray(),
            note => SessionWait.Text(note?["text"]) == "native owned"
        );
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "task",
                    new JsonObject
                    {
                        ["action"] = "assign",
                        ["taskId"] = own,
                        ["ownerSessionId"] = "kid",
                    }
                )
            )
        );
        Assert.Equal("tool_authorization_denied", Error(await Update(own, "call_tool")));
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new(
                    "task",
                    "builtin",
                    "task",
                    new JsonObject
                    {
                        ["action"] = "assign",
                        ["taskId"] = own,
                        ["ownerSessionId"] = "self",
                    }
                ),
                null,
                default
            )
        );
        await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = own,
                ["ownerSessionId"] = "self",
            },
            "direct"
        );
        Assert.Null(Error(await Update(own)));
        await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = own,
                ["ownerSessionId"] = null,
            },
            "self"
        );
        Assert.Equal("tool_authorization_denied", Error(await Update(own)));
    }

    [Fact]
    public async Task Registered_Node_effects_cover_model_discovery_direct_resolved_and_native_script_not_unrelated_arguments_or_VM()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        await File.WriteAllTextAsync(Path.Combine(own, "source"), "native effect");
        await Policy(
            manager,
            """
            version: 1
            defaultAction: deny
            rules:
            - action: allow
              node: {current: true}
            - action: allow
              tool: {source: builtin, name: run_script}
            """
        );
        var definitions = manager.ModelDefinitions(owner);
        Assert.Contains(definitions, value => SessionWait.Text(value?["name"]) == "read");
        Assert.Contains(
            definitions,
            value => SessionWait.Text(value?["name"]) == "copy_between_nodes"
        );
        Assert.Contains(definitions, value => SessionWait.Text(value?["name"]) == "node");
        Assert.DoesNotContain(definitions, value => SessionWait.Text(value?["name"]) == "task");
        Assert.Null(Error(await Call(execution.Tools, "read", Obj("""{"filePath":"source"}"""))));
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "call_tool",
                    Obj(
                        """{"toolId":"node:master/write","args":{"filePath":"resolved","content":"one"}}"""
                    )
                )
            )
        );
        var script = await Call(
            execution.Tools,
            "run_script",
            Obj("""{"code":"return call_tool('read', {'filePath':'source'})['content']"}""")
        );
        Assert.Null(Error(script));
        Assert.Equal("native effect", script["result"]!.GetValue<string>());
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "copy_between_nodes",
                    Obj(
                        """{"sourceNode":"master","sourcePath":"source","targetNode":"master","targetPath":"copy"}"""
                    )
                )
            )
        );
        Assert.Equal("native effect", await File.ReadAllTextAsync(Path.Combine(own, "copy")));
        await manager.AuthorizeToolAsync(
            owner,
            new("node", "builtin", "node", Obj("""{"action":"inspect","nodeId":"master"}""")),
            null,
            default
        );
        foreach (var name in new[] { "session", "run_script", "read" })
        {
            var source = name == "read" ? "mcp" : "builtin";
            // Remove the explicit VM grant: a file-source selector is not a VM Node effect.
            await Policy(
                manager,
                "version: 1\ndefaultAction: deny\nrules: [{action: allow, node: '*'}]"
            );
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(
                    owner,
                    new(name, source, name, Obj("""{"nodeId":"master","node":"master"}""")),
                    execution.Files,
                    default
                )
            );
        }
        Assert.False(manager.ToolVisible(owner, "builtin", "run_script"));
        Assert.False(manager.ToolVisible(owner, "builtin", "session"));
        Assert.False(manager.ToolVisible(owner, "mcp", "read", "peer", node: "master"));
    }
}
