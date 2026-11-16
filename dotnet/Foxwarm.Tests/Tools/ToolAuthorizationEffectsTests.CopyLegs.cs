using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Sessions created as a side effect carry their placement, and a copy is authorized as a read
// of everything it copies plus a write of its destination (operation authorization phase 3).
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Side_effect_sessions_carry_their_node_and_agent()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "auditor", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;

        // A new Agent without a default Node starts its main Session on master.
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, node: master, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"default-placement"}""")))
        );
        Assert.Null(manager.Catalog.Get("default-placement/main"));
        Assert.Null(
            Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"no-main","createMainSession":false}""")))
        );
        // The main Session of a new Agent with a default Node starts there.
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, node: elsewhere, action: deny}\n");
        var request = await manager.AssessToolAsync(
            owner,
            execution.Registry.Resolve("create_agent", Obj("""{"agentName":"placed","defaultNode":"elsewhere"}""")),
            execution.Files,
            CancellationToken.None
        );
        Assert.Equal(ToolAuthorizationEffect.Deny, request.Effect);

        // A source Session the call creates belongs to the Agent its ID names, on that Agent's
        // default Node.
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, targetAgent: {id: beta}, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "create_agent",
                    Obj("""{"agentName":"from-source","createMainSession":false,"sourceSessionId":"beta/new-source"}""")
                )
            )
        );
        Assert.Null(manager.Catalog.Get("beta/new-source"));
        // A conversion moves its source in as main; it creates no Session.
        var assessment = await manager.AssessToolAsync(
            owner,
            execution.Registry.Resolve(
                "create_agent",
                Obj("""{"agentName":"converted","convertSession":true}""")
            ),
            execution.Files,
            CancellationToken.None
        );
        Assert.DoesNotContain(assessment.Request.Operations ?? [], operation => operation.Op == "session.create");
    }

    [Fact]
    public async Task Memory_copies_read_everything_they_copy_and_write_their_destination()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "auditor", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var memory = Path.Combine(manager.AgentDirectory("alpha"), "memory");
        Directory.CreateDirectory(Path.Combine(memory, "notes"));
        await File.WriteAllTextAsync(Path.Combine(memory, "review.md"), "caller-only-memory");
        await File.WriteAllTextAsync(Path.Combine(memory, "notes", "private.md"), "nested");
        string? Copied(string agent) =>
            File.Exists(Path.Combine(temp.Path, "workspace", "agents", agent, "memory", "review.md"))
                ? File.ReadAllText(Path.Combine(temp.Path, "workspace", "agents", agent, "memory", "review.md"))
                : null;

        // An unrelated operation rule leaves the copy decidable: both paths come from their owner.
        await Policy(manager, "version: 1\nrules:\n- {op: node.select, action: deny}\n");
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "create_agent",
                    Obj("""{"agentName":"copied-memory","createMainSession":false,"inheritMemory":true}""")
                )
            )
        );
        Assert.Equal("caller-only-memory", Copied("copied-memory"));

        // The read leg is the caller's memory, and it covers everything inside it.
        foreach (var denied in new[] { memory, Path.Combine(memory, "review.md"), Path.Combine(memory, "notes") })
        {
            await Policy(
                manager,
                "version: 1\nrules:\n- {op: env.write, action: allow}\n- {op: env.read, path: {within: '"
                    + denied
                    + "'}, action: deny}\n"
            );
            var name = "copy-" + Path.GetFileName(denied).Replace(".", "-");
            Assert.Equal(
                "tool_authorization_denied",
                Error(
                    await Call(
                        execution.Tools,
                        "create_agent",
                        Obj($$"""{"agentName":"{{name}}","createMainSession":false,"inheritMemory":true}""")
                    )
                )
            );
            Assert.Null(Copied(name));
        }
        // A grant for part of the tree doesn't cover the copy.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: env.write, action: allow}\n- {op: agent.create, action: allow}\n- {op: env.read, path: {within: '"
                + Path.Combine(memory, "notes")
                + "'}, action: allow}\n"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "create_agent",
                    Obj("""{"agentName":"partial-grant","createMainSession":false,"inheritMemory":true}""")
                )
            )
        );
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: env.write, action: allow}\n- {op: agent.create, action: allow}\n- {op: env.read, path: {within: '"
                + memory
                + "'}, action: allow}\n"
        );
        Assert.Null(
            Error(
                await Call(
                    execution.Tools,
                    "create_agent",
                    Obj("""{"agentName":"whole-grant","createMainSession":false,"inheritMemory":true}""")
                )
            )
        );
        Assert.Equal("caller-only-memory", Copied("whole-grant"));
        // The write leg is the new Agent's memory.
        await Policy(
            manager,
            "version: 1\nrules:\n- {op: env.write, path: {within: '"
                + Path.Combine(temp.Path, "workspace", "agents", "blocked-target")
                + "'}, action: deny}\n"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "create_agent",
                    Obj("""{"agentName":"blocked-target","createMainSession":false,"inheritMemory":true}""")
                )
            )
        );

        // move_session into a new Agent copies the moved Session's Agent memory the same way.
        await Policy(
            manager,
            "version: 1\nrules:\n- {op: env.write, action: allow}\n- {op: env.read, path: {within: '"
                + Path.Combine(memory, "review.md")
                + "'}, action: deny}\n"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "move_session",
                    Obj("""{"sessionId":"alpha/auditor","createAgent":true,"newAgentName":"moved-memory","createAgentInheritMemory":true}""")
                )
            )
        );
        Assert.Null(Copied("moved-memory"));
        Assert.NotNull(manager.Catalog.Get("alpha/auditor"));
    }
}
