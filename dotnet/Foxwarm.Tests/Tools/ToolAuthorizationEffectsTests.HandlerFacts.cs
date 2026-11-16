using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Operation facts that come from the handler's own resolution, through real dispatch (operation
// authorization phase 3): canonical copy legs, default sources, side-effect Session facts,
// prospective Task owners, pairing IDs, and legacy script checkpoints.
public sealed partial class ToolAuthorizationEffectsTests
{
    // a copy leg is the physical directory the copy reads, as for an ordinary read.
    [Fact]
    public async Task Memory_copy_legs_are_canonical_physical_paths()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "link-reader", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var memory = Path.Combine(manager.AgentDirectory("alpha"), "memory");
        var physical = Path.Combine(temp.Path, "protected-memory");
        Directory.CreateDirectory(physical);
        await File.WriteAllTextAsync(Path.Combine(physical, "private.md"), "physical-denied-content");
        if (Directory.Exists(memory))
            Directory.Delete(memory, true);
        Directory.CreateSymbolicLink(memory, physical);
        await Policy(manager, "version: 1\nrules:\n- {op: env.read, path: {within: '" + physical + "'}, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "read", new JsonObject { ["filePath"] = Path.Combine(memory, "private.md") }))
        );
        var args = Obj("""{"agentName":"copy-link","createMainSession":false,"inheritMemory":true}""");
        var assessment = await manager.AssessToolAsync(owner, execution.Registry.Resolve("create_agent", args), execution.Files, default);
        var read = Assert.Single(assessment.Request.Operations ?? [], operation => operation.Op == "env.read");
        Assert.Equal(AuthorizationPaths.CanonicalPotential(physical), read.Path!.Resolved);
        Assert.Equal("tool_authorization_denied", Error(await Call(execution.Tools, "create_agent", args)));
        Assert.False(File.Exists(Path.Combine(temp.Path, "workspace", "agents", "copy-link", "memory", "private.md")));
    }

    // a conversion's source defaults to the caller.
    [Fact]
    public async Task Caller_default_conversion_is_decidable()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "converter", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, "version: 1\nrules:\n- {op: node.select, action: deny}\n");
        Assert.Null(Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"converted","convertSession":true}"""))));
        Assert.NotNull(manager.Catalog.Get("converted/main"));
        // The moved Session is the caller.
        var probe = await manager.CreateNamedAsync("alpha", "second", null, null);
        var second = TimerExecutor(manager, probe, temp.Path);
        await using var secondMcp = second.Mcp;
        await Policy(manager, "version: 1\nrules:\n- {op: session.manage, targetSession: {id: alpha/second}, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(second.Tools, "create_agent", Obj("""{"agentName":"converted-two","convertSession":true}""")))
        );
        Assert.NotNull(manager.Catalog.Get("alpha/second"));
    }

    // the main Session an Agent creation makes has its ID, runtime and descendant Agent.
    [Fact]
    public async Task Agent_main_session_carries_every_creation_fact()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "side-effects", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        foreach (var (agent, selector) in new[]
        {
            ("fact-runtime", "with: {runtime: foxwarm}"),
            ("fact-prospective", "targetSession: {id: fact-prospective/main}"),
            ("fact-descendant", "targetAgent: {descendant: true}"),
        })
        {
            await Policy(manager, "version: 1\nrules:\n- {op: session.create, " + selector + ", action: deny}\n");
            Assert.Equal(
                "tool_authorization_denied",
                Error(await Call(execution.Tools, "create_agent", new JsonObject { ["agentName"] = agent }))
            );
            Assert.Null(manager.Catalog.Get(agent + "/main"));
        }
        // An ID grant names the main Session exactly.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: agent.create, action: allow}\n- {op: session.create, targetSession: {id: granted/main}, action: allow}\n"
        );
        Assert.Null(Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"granted"}"""))));
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"other"}""")))
        );
    }

    // a Task assigned to a child created in another Agent is not same-Agent.
    [Fact]
    public async Task Prospective_child_task_assignment_keeps_the_child_agent()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "task-parent", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        async Task<string> Task()
        {
            var created = await manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "create", ["title"] = "assignment", ["notifySession"] = false },
                owner.Id
            );
            return SessionWait.Text(created.Payload["task"]!["id"])!;
        }
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: session.create, action: allow}\n- {op: task.assign, targetSession: {session: {sameAgent: true}}, action: allow}\n"
        );
        var crossTask = await Task();
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "create_child_session",
                    new JsonObject { ["suffix"] = "cross-agent-child", ["agentName"] = "beta", ["taskId"] = crossTask }
                )
            )
        );
        Assert.Null(manager.Tasks.OwnerSessionId(crossTask));
        Assert.Null(manager.Catalog.Get("beta/cross-agent-child"));
        // A same-Agent child is a same-Agent assignment.
        var sameTask = await Task();
        var args = new JsonObject { ["suffix"] = "same", ["taskId"] = sameTask };
        var assessment = await manager.AssessToolAsync(
            owner,
            execution.Registry.Resolve("create_child_session", args),
            execution.Files,
            default
        );
        Assert.Equal(ToolAuthorizationEffect.Allow, assessment.Effect);
        // A child relation grant covers the prospective child of an assignment.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: session.create, action: allow}\n- {op: task.assign, targetSession: {session: {relation: child}}, action: allow}\n"
        );
        var child = await manager.AssessToolAsync(
            owner,
            execution.Registry.Resolve("create_child_session", new JsonObject { ["suffix"] = "rel", ["agentName"] = "beta", ["taskId"] = sameTask }),
            execution.Files,
            default
        );
        Assert.Equal(ToolAuthorizationEffect.Allow, child.Effect);
    }

    // A Session create_session parents to the caller is the caller's child, by ID or alias.
    [Fact]
    public async Task Sessions_parented_to_the_caller_are_its_children()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        JsonObject Args(string name, string parent) =>
            new() { ["agentName"] = "alpha", ["sessionName"] = name, ["parentSessionId"] = parent };
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: session.create, targetSession: {session: {relation: child}}, action: allow}\n"
        );
        Assert.Null(Error(await Call(execution.Tools, "create_session", Args("by-id", "opaque"))));
        Assert.Null(Error(await Call(execution.Tools, "create_session", Args("by-alias", "self"))));
        Assert.Equal("tool_authorization_denied", Error(await Call(execution.Tools, "create_session", Args("unrelated", "foreign"))));
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, targetSession: {session: {relation: child}}, action: deny}\n");
        Assert.Equal("tool_authorization_denied", Error(await Call(execution.Tools, "create_session", Args("denied", "opaque"))));
        Assert.Null(manager.Catalog.Get("alpha/denied"));
        Assert.Null(Error(await Call(execution.Tools, "create_session", Args("sibling", "foreign"))));
    }

    // a run checkpointed before image admission completes with the old promotion.
    [Fact]
    public async Task Runs_checkpointed_before_admission_resume_under_the_old_promotion()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 13, 9);
        var reference = await manager.Images.PutAsync(bytes, "image/png", "legacy-image");
        RegisterImageProducer(execution.Registry, reference);
        await Policy(manager, "version: 1\nrules: []\n");
        const string Code =
            FirstImage + "x=first_image(call_tool('produce_image',{}))\nask_agent('pause')\nreturn {'parts':[{'inlineDataRef':x}]}";
        async Task<JsonObject> Pause() => await Call(execution.Tools, "run_script", new JsonObject { ["code"] = Code });
        async Task<JsonObject> Resume(JsonObject paused) =>
            await Call(
                execution.Tools,
                "continue_script",
                new JsonObject
                {
                    ["runId"] = paused["runId"]!.DeepClone(),
                    ["continuationId"] = paused["continuationId"]!.DeepClone(),
                    ["input"] = false,
                }
            );

        // A legacy checkpoint: the record has neither provenance field.
        var legacy = await Pause();
        Assert.Equal("waiting", SessionWait.Text(legacy["status"]));
        var record = (await manager.ToolScript.Store.ReadAsync(SessionWait.Text(legacy["runId"])!, default))!;
        Assert.NotNull(record["producedImages"]);
        record.Remove("producedImages");
        record.Remove("resultImages");
        await manager.ToolScript.Store.WriteAsync(record, default);
        var resumed = await Resume(legacy);
        Assert.Equal("", ScriptError(resumed));
        Assert.Equal(bytes, await Promoted(manager, resumed));
        var stored = (await manager.ToolScript.Store.ReadAsync(SessionWait.Text(legacy["runId"])!, default))!;
        Assert.False(stored.ContainsKey("resultImages"));

        // A run this code began keeps admission: its produced image is admitted, a foreign one
        // returned after resuming is not.
        var current = await Pause();
        var admitted = await Resume(current);
        Assert.Equal("", ScriptError(admitted));
        Assert.Equal(bytes, await Promoted(manager, admitted));
        var foreignBytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 7, 3);
        var foreign = await manager.Images.PutAsync(foreignBytes, "image/png", "foreign-resume");
        await AppendImage(await manager.RequiredAsync("foreign"), foreign, "foreign-resume");
        var paused = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = "ask_agent('pause')\nreturn {'parts':[{'inlineDataRef':args['reference']}]}",
                ["args"] = new JsonObject { ["reference"] = foreign.DeepClone() },
            }
        );
        Assert.Contains("which it can't return", ScriptError(await Resume(paused)));
    }
}

public sealed partial class NodeAuthorizationTreeTests
{
    // an approval without nodeId is decided on the ID the handler assigns.
    [Fact]
    public async Task Pairing_approval_without_node_id_uses_the_assigned_id()
    {
        await using var f = await Fixture.Create();
        JsonObject Pending(string name) =>
            f.Manager.Nodes.Registry.Request(
                new JsonObject
                {
                    ["nodeType"] = "cli-node",
                    ["requestedName"] = name,
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonArray() },
                },
                NodeConnectionHub.Protocol(new())
            );
        var pending = Pending("fact-paired");
        await f.Policy("version: 1\nrules:\n- {op: env.exec, action: deny}\n");
        var allowed = await f.Call("node_pair_approve", new JsonObject { ["pendingId"] = pending["id"]!.DeepClone() });
        Assert.Null(allowed?["error"]);
        Assert.Equal("fact-paired", SessionWait.Text(JsonNode.Parse(SessionWait.Text(allowed?["output"])!)!["nodeId"]));
        // The assigned ID is the fact: a deny on the suffixed ID it would get applies.
        var second = Pending("fact-paired");
        await f.Policy("version: 1\nrules:\n- {op: node.trust, node: fact-paired-2, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            SessionWait.Text((await f.Call("node_pair_approve", new JsonObject { ["pendingId"] = second["id"]!.DeepClone() }))?["error"]?["type"])
        );
    }
}
