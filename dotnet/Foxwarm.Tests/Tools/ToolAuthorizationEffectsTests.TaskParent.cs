using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public void Task_Session_matchers_require_the_registered_argument_and_builtin_resolver()
    {
        ToolAuthorizationPolicy Parse(string selector, string arguments) =>
            ToolAuthorizationYaml.Parse(
                Encoding.UTF8.GetBytes(
                    $"version: 1\ndefaultAction: deny\nrules: [{{action: allow, tool: {selector}, args: {arguments}}}]"
                )
            );
        const string target = "{ownerSessionId: {session: {relation: parent}}}";
        var policy = Parse("{source: builtin, name: task}", target);
        Parse("{source: builtin, name: [task]}", target);
        foreach (var selector in new[]
        {
            "task",
            "{source: mcp, name: task}",
            "{source: node, name: task}",
            "{source: builtin, name: task, server: peer}",
            "{source: builtin, name: [task, view_session]}",
            "{source: builtin, name: recall}",
            "{source: builtin, name: {equals: task}}",
        })
            Assert.Throws<InvalidDataException>(() => Parse(selector, target));
        foreach (var arguments in new[]
        {
            "{sessionId: {session: {relation: parent}}}",
            "{taskId: {session: {relation: parent}}}",
            "{ownerSessionId.id: {session: {relation: parent}}}",
            "{ownerSessionId: {session: {relation: parent}}, sessionId: {session: {self: true}}}",
        })
            Assert.Throws<InvalidDataException>(() => Parse("{source: builtin, name: task}", arguments));

        var request = new ToolAuthorizationRequest(
            "builtin", "task", null, Obj("""{"ownerSessionId":"parent"}"""), [],
            "alpha", "child", "master", ".", ".", ".",
            SourceParent: "parent", SessionTarget: new("parent", "alpha", null)
        );
        Assert.True(ToolAuthorizationEvaluation.NeedsTarget(policy, request));
        Assert.False(ToolAuthorizationEvaluation.NeedsTaskTarget(policy, request));
        Assert.True(ToolAuthorizationEvaluation.Visible(policy, request));
        Assert.True(ToolAuthorizationEvaluation.Evaluate(policy, request).Allowed);
        Assert.False(ToolAuthorizationEvaluation.Evaluate(policy, request with { SessionTarget = null }).Allowed);
        // Even supplied target facts cannot turn an external principal into an internal relation.
        Assert.False(ToolAuthorizationEvaluation.Evaluate(policy, request with { Principal = "external", ExternalId = "peer" }).Allowed);
    }

    [Fact]
    public async Task Task_owner_relations_use_live_catalog_aliases_without_hydrating_targets()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var child = await manager.RequiredAsync("kid");
        foreach (var (matcher, allowed, denied) in new[]
        {
            ("{self: true}", "kid", "self"),
            ("{sameAgent: true}", "self", "outside"),
            ("{relation: parent}", "self", "outside"),
            ("{relation: child}", "kid", "outside"),
        })
        {
            var source = matcher == "{relation: child}" ? await manager.RequiredAsync("self") : child;
            await Policy(manager, $"version: 1\ndefaultAction: deny\nrules: [{{action: allow, tool: {{source: builtin, name: task}}, args: {{ownerSessionId: {{session: {matcher}}}}}}}]");
            await manager.AuthorizeToolAsync(source, new("task", "builtin", "task", new JsonObject { ["ownerSessionId"] = allowed }), null, default);
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(source, new("task", "builtin", "task", new JsonObject { ["ownerSessionId"] = denied }), null, default));
            Assert.DoesNotContain(manager.Owners(), owner => owner.Id == "foreign");
            if (source == child)
                Assert.Single(manager.Owners());
        }
        await Policy(manager, "version: 1\ndefaultAction: deny\nrules: [{action: allow, tool: {source: builtin, name: task}, args: {ownerSessionId: {session: {relation: parent}}}}]");
        // The relationship comes from current catalog metadata, not a hydrated owner's snapshot.
        manager.Catalog.Upsert([SessionCatalogTests.Row("direct", 0, "foreign", "alpha", ["kid"])]);
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => manager.AuthorizeToolAsync(
            child, new("task", "builtin", "task", Obj("""{"ownerSessionId":"self"}""")), null, default));
        await manager.AuthorizeToolAsync(child, new("task", "builtin", "task", Obj("""{"ownerSessionId":"outside"}""")), null, default);
        Assert.DoesNotContain(manager.Owners(), owner => owner.Id == "foreign");
    }

    [Theory]
    [InlineData("task")]
    [InlineData("call_tool")]
    [InlineData("run_script")]
    public async Task Parent_question_creation_is_narrow_and_parent_answer_returns_to_child(string entry)
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        // Admit and persist ordinary notifications without starting provider requests.
        manager.TopologyChanged += () =>
        {
            foreach (var owner in manager.Owners())
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        };
        await manager.LoadAsync();
        var child = await manager.RequiredAsync("kid");
        var execution = Executor(manager, child, temp.Path);
        await using var mcp = execution.Mcp;
        var work = (await manager.Tasks.ExecuteAsync(
            Obj("""{"action":"create","title":"assigned work","ownerSessionId":"kid"}"""), "self"
        )).Payload["task"]!["id"]!.GetValue<string>();
        await Policy(manager, """
            version: 1
            defaultAction: deny
            rules:
            - action: allow
              tool: {source: builtin, name: run_script}
            - action: allow
              tool: {source: builtin, name: send_to_session}
              args:
                sessionId: {session: {relation: [parent, child]}}
            - action: allow
              tool: {source: builtin, name: task}
              args:
                action: create
                ownerSessionId: {session: {relation: parent}}
            - action: allow
              tool: {source: builtin, name: task}
              args:
                action: [get, list]
            - action: allow
              tool: {source: builtin, name: task}
              args:
                taskId: {task: {owned: true}}
            """);
        async Task<JsonObject> Invoke(JsonObject args)
        {
            if (entry == "task")
                return await Call(execution.Tools, entry, args);
            if (entry == "call_tool")
                return await Call(execution.Tools, entry, new JsonObject { ["toolId"] = "builtin:task", ["args"] = args });
            var script = await Call(execution.Tools, entry, new JsonObject
            {
                ["code"] = "return call_tool('run_script', {'code': \"return call_tool('builtin:task', args)\", 'args': args})",
                ["args"] = args,
            });
            Assert.True(SessionWait.Text(script["status"]) == "completed", script.ToJsonString());
            var nested = script["result"]!.AsObject();
            if (SessionWait.Text(nested["status"]) == "failed")
                return nested;
            Assert.True(SessionWait.Text(nested["status"]) == "completed", nested.ToJsonString());
            return nested["result"]!.AsObject();
        }
        async Task Denied(JsonObject args)
        {
            var result = await Invoke(args);
            if (entry == "run_script")
            {
                Assert.Equal("failed", SessionWait.Text(result["status"]));
                Assert.Contains("Tool authorization", SessionWait.Text(result["error"]));
                Assert.Null(result["result"]);
            }
            else
                Assert.Equal("tool_authorization_denied", Error(result));
        }
        Assert.True(manager.ToolVisible(child, "builtin", "task"));
        Assert.Contains(manager.ModelDefinitions(child), value => SessionWait.Text(value?["name"]) == "task");
        foreach (var target in new JsonNode?[] { JsonValue.Create("kid"), JsonValue.Create("direct"), JsonValue.Create("outside"), JsonValue.Create("missing"), JsonValue.Create(""), JsonValue.Create(true), null })
        {
            await Denied(new JsonObject { ["action"] = "create", ["title"] = "denied question", ["ownerSessionId"] = target });
        }
        await Denied(Obj("""{"action":"create","title":"unassigned"}"""));
        // A proposed parent assignment is not a grant to mutate an unrelated/unowned Task.
        await Denied(new JsonObject { ["action"] = "assign", ["taskId"] = "task_missing", ["ownerSessionId"] = "self" });
        await manager.AuthorizeToolAsync(child, new("task", "builtin", "task", Obj("""{"action":"create","ownerSessionId":"opaque"}""")), null, default);
        await manager.AuthorizeToolAsync(child, new("task", "builtin", "task", Obj("""{"action":"create","ownerSessionId":"self"}""")), null, default);
        Assert.Single(manager.Owners());
        var before = await Invoke(Obj("""{"action":"list","scope":"all"}"""));
        Assert.Single(before["tasks"]!.AsArray());
        var created = await Invoke(new JsonObject
        {
            ["action"] = "create", ["title"] = "Which option?", ["description"] = "Choose A or B for the assigned work.",
            ["parentTaskId"] = work, ["ownerSessionId"] = "self", ["notifySession"] = true,
        });
        Assert.Null(Error(created));
        Assert.Equal("opaque", SessionWait.Text(created["ownerSessionId"]));
        Assert.Equal(1, created["sentNotifications"]!.GetValue<int>());
        var question = created["taskId"]!.GetValue<string>();
        var parent = await manager.RequiredAsync("self");
        var assignment = SessionWait.Text(Assert.Single(Assert.Single(parent.Entry.Snapshot().Queue).Parts!)["system"]);
        Assert.Contains(question, assignment);
        Assert.Contains("Choose A or B", assignment);
        await Denied(new JsonObject { ["action"] = "complete", ["taskId"] = question, ["result"] = "child cannot answer as owner" });
        var parentExecution = Executor(manager, parent, temp.Path);
        await using var parentMcp = parentExecution.Mcp;
        var completed = await Call(parentExecution.Tools, "task", new JsonObject { ["action"] = "complete", ["taskId"] = question, ["result"] = "Use option B." });
        Assert.Null(Error(completed));
        Assert.Equal("completed", SessionWait.Text(completed["status"]));
        Assert.Equal(1, completed["sentNotifications"]!.GetValue<int>());
        var answer = Assert.Single(child.Entry.Snapshot().Queue);
        Assert.True(answer.Trigger);
        var text = SessionWait.Text(Assert.Single(answer.Parts!)["system"]);
        Assert.Contains("event=\"completed\"", text);
        Assert.Contains(question, text);
        Assert.Contains("Use option B.", text);
        var detail = await Invoke(new JsonObject { ["action"] = "get", ["taskId"] = question });
        Assert.Equal(work, SessionWait.Text(detail["task"]?["parentTaskId"]));
        Assert.Equal(child.Id, SessionWait.Text(detail["task"]?["createdBySessionId"]));
        Assert.Equal(parent.Id, SessionWait.Text(detail["task"]?["ownerSessionId"]));
        Assert.Equal("Use option B.", SessionWait.Text(detail["task"]?["result"]));
        // Existing owned-Task authority still lets the child continue its original assignment.
        Assert.Null(Error(await Invoke(new JsonObject { ["action"] = "update", ["taskId"] = work, ["note"] = "Parent chose B; continuing." })));
        await manager.ShutdownAsync();
    }
}
