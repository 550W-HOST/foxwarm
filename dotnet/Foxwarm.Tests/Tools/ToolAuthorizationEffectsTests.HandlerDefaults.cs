using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Operation facts through real dispatch: handler defaults and the owners of target facts
// (operation authorization phase 3).
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Operation_facts_apply_handler_defaults_through_dispatch()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "reviewer", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        RegisterNode(manager, execution);

        // create_agent creates its main Session unless told not to.
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"default-main"}""")))
        );
        Assert.Null(manager.Catalog.Get("default-main/main"));
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"explicit-main","createMainSession":true}""")))
        );
        Assert.Null(
            Error(await Call(execution.Tools, "create_agent", Obj("""{"agentName":"no-main","createMainSession":false}""")))
        );

        // A child without agentName is created in the caller's Agent...
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, targetAgent: {self: true}, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_child_session", Obj("""{"suffix":"inherited"}""")))
        );
        Assert.Null(manager.Catalog.Get("alpha/reviewer_inherited"));

        // ...and on the caller's current Node.
        await Policy(manager, "version: 1\nrules:\n- {op: session.create, node: master, action: deny}\n");
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_child_session", Obj("""{"suffix":"inheritednode"}""")))
        );
        Assert.Null(manager.Catalog.Get("alpha/reviewer_inheritednode"));
        // A new Session of another Agent starts on that Agent's default Node.
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_session", Obj("""{"agentName":"beta","sessionName":"placed"}""")))
        );

        // Runtime and fork defaults are stated values.
        await Policy(
            manager,
            "version: 1\nrules:\n- {op: session.create, with: {runtime: foxwarm, fork: false}, action: deny}\n"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "create_child_session", Obj("""{"suffix":"defaults"}""")))
        );
    }

    [Fact]
    public async Task Operation_targets_come_from_their_fact_owners()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;

        // A control capability without a registered resolver targets sessionId, or the caller.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {op: session.control, targetSession: {id: direct}, action: allow}\n"
        );
        Assert.Null(
            Error(await Call(execution.Tools, "refresh_session_snapshot", Obj("""{"sessionId":"direct"}""")))
        );
        await Policy(
            manager,
            "version: 1\nrules:\n- {op: session.control, targetSession: {session: {self: true}}, action: deny}\n"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(await Call(execution.Tools, "refresh_session_snapshot", Obj("{}")))
        );
        Assert.Null(
            Error(await Call(execution.Tools, "refresh_session_snapshot", Obj("""{"sessionId":"direct"}""")))
        );

        // Every context fact a declaration needs is supplied on the enforcement path.
        var context = manager.OperationContext(owner, execution.Files);
        foreach (var declaration in OperationDeclarations.Capabilities)
        foreach (var branch in declaration.Branches)
        foreach (var template in branch.Operations)
        foreach (var expression in template.Resources.Values.Concat(template.With.Values))
        foreach (var member in OperationPlan.FactSource(declaration, branch, expression)?.Context ?? [])
            Assert.True(
                typeof(PlanContext).GetProperty(member, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(context) is not null,
                $"{declaration.Capability} {expression} needs {member}"
            );
    }
}
