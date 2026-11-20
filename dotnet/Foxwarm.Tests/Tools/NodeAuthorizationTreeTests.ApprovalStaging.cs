using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using static Foxwarm.Tests.ApprovalStagingSupport;

namespace Foxwarm.Tests;

// Staged approval of a node_remove cascade (phase 2): each member is a retained final request
// with its own raw arguments, assessed in the call's plan and again inside the registry mutation.
public sealed partial class NodeAuthorizationTreeTests
{
    private const string CascadeAsk = """
        version: 1
        rules:
          - {id: confirm-root, tool: node_remove, node: {exact: root}, action: ask, approval: {timeoutSeconds: 600, approvers: [ops, nodes]}}
          - {id: confirm-child, tool: node_remove, node: {exact: child}, action: ask, approval: {timeoutSeconds: 120, approvers: [ops]}}
          - {id: confirm-other, tool: node_remove, action: ask}
        """;

    private static readonly JsonObject CascadeRoot = Obj("""{"nodeId":"root","cascade":true}""");

    private static bool Registered(Fixture f, string id) =>
        f.Manager.Nodes.Registry.Forest().Contains(id);

    [Fact]
    public async Task Cascade_members_are_approved_with_the_call_in_one_request()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("root");
        f.Manager.Nodes.Registry.Create("child", "root");
        await f.Policy(CascadeAsk.Replace("  - {id: confirm-other, tool: node_remove, action: ask}\n", "", StringComparison.Ordinal));
        var call = f.Call("node_remove", CascadeRoot);
        var pending = await PendingAsync(f.Owner);
        Assert.Equal("node_remove", pending["tool"]!["name"]!.GetValue<string>());
        // The root member is the call's own request; the child member is listed with its Node.
        Assert.Equal(["member:child"], CheckIds(pending));
        Assert.Equal(
            ["child"],
            pending["checks"]![0]!["facts"]!["nodeTargets"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        Assert.Equal(["ops"], Approvers(pending));
        Assert.Equal(120, pending["timeoutSeconds"]!.GetValue<long>());
        Assert.True(Registered(f, "child"));
        await Approve(f.Manager, f.Owner, pending);
        Success(await call.WaitAsync(TimeSpan.FromSeconds(30)));
        Assert.False(Registered(f, "root"));
        Assert.False(Registered(f, "child"));
        Assert.Single(Records(f.Owner));
    }

    [Fact]
    public async Task Denied_cascade_member_prevents_the_approval_and_keeps_every_Node()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("root");
        f.Manager.Nodes.Registry.Create("child", "root");
        await f.Policy(
            CascadeAsk.Replace(
                "{id: confirm-child, tool: node_remove, node: {exact: child}, action: ask, approval: {timeoutSeconds: 120, approvers: [ops]}}",
                "{id: keep-child, tool: node_remove, node: {exact: child}, action: deny}",
                StringComparison.Ordinal
            )
        );
        var result = await f.Call("node_remove", CascadeRoot);
        Assert.Equal("tool_authorization_denied", ErrorType(result));
        Assert.Contains("`keep-child`", result?.FailureMessage());
        Assert.Empty(Records(f.Owner));
        Assert.True(Registered(f, "root"));
        Assert.True(Registered(f, "child"));
    }

    [Fact]
    public async Task Deny_installed_while_the_cascade_waited_stops_it()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("root");
        f.Manager.Nodes.Registry.Create("child", "root");
        await f.Policy(CascadeAsk);
        var call = f.Call("node_remove", CascadeRoot);
        var pending = await PendingAsync(f.Owner);
        // The member the approver sees is now denied, with nothing else changed.
        await f.Policy(
            CascadeAsk.Replace(
                "{id: confirm-child, tool: node_remove, node: {exact: child}, action: ask, approval: {timeoutSeconds: 120, approvers: [ops]}}",
                "{id: keep-child, tool: node_remove, node: {exact: child}, action: deny}",
                StringComparison.Ordinal
            )
        );
        await Approve(f.Manager, f.Owner, pending);
        var result = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal("tool_authorization_denied", ErrorType(result));
        Assert.True(Registered(f, "root"));
        Assert.True(Registered(f, "child"));
    }

    [Fact]
    public async Task Member_added_after_approval_fails_closed_inside_the_registry_mutation()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("root");
        f.Manager.Nodes.Registry.Create("child", "root");
        await f.Policy(CascadeAsk);
        var resolved = new ResolvedTool("node_remove", "builtin", "node_remove", CascadeRoot);
        var scope = new ToolApprovalScope(f.Owner) { Primary = resolved };
        using var entered = ToolApprovalScope.Enter(scope);
        var required = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.AuthorizeCallAsync(f.Owner, resolved, null, "master", default)
        );
        Assert.Equal(["primary", "member:child"], required.Checks.Select(check => check.Id));
        scope.Add(new("ap-cascade", required.Checks.Select(check => check.Fingerprint).ToHashSet(), null));
        await f.Manager.AuthorizeCallAsync(f.Owner, resolved, null, "master", default);
        // A member the approver never saw joins the subtree before the removal.
        f.Manager.Nodes.Registry.Create("late", "child");
        var error = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.RemoveNodeAsync(f.Owner, CascadeRoot, default)
        );
        Assert.Equal("tool_approval_unavailable", error.ErrorType);
        Assert.Equal("late", error.Checks.Single().Resolved.Args["nodeId"]!.GetValue<string>());
        Assert.All(new[] { "root", "child", "late" }, id => Assert.True(Registered(f, id)));
    }

    // A Node rule matches a target through its ancestry; an approval given while the target
    // was under one parent does not cover it under another.
    [Fact]
    public async Task Approval_does_not_cover_a_Node_whose_ancestry_changed_while_waiting()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("root");
        f.Manager.Nodes.Registry.Create("other");
        f.Manager.Nodes.Registry.Create("child", "root");
        await f.Policy(
            """
            version: 1
            rules:
              - {id: under-root, tool: node_remove, node: root, action: ask, approval: {approvers: [root-ops]}}
              - {id: elsewhere, tool: node_remove, action: ask, approval: {approvers: [other-ops]}}
            """
        );
        var call = f.Call("node_remove", Obj("""{"nodeId":"child"}"""));
        var pending = await PendingAsync(f.Owner);
        Assert.Equal(["root-ops"], Approvers(pending));
        f.Manager.Nodes.Registry.SetParent("child", "other");
        await Approve(f.Manager, f.Owner, pending);
        var result = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal("tool_approval_unavailable", ErrorType(result));
        Assert.Contains("under rule elsewhere", result?.FailureMessage());
        Assert.True(Registered(f, "child"));
        Assert.Equal("cancelled", SessionWait.Text(Assert.Single(Records(f.Owner))["status"]));
    }

    // `current: true` matches the caller's selected Node; an approval given while the call's
    // Node was the current one does not cover it after the selection moved.
    [Fact]
    public async Task Approval_does_not_cover_a_call_whose_current_Node_changed_while_waiting()
    {
        await using var f = await Fixture.Create(provider: true);
        await f.Policy(
            """
            version: 1
            rules:
              - {id: read-here, tool: {source: node, name: read}, node: {current: true}, action: ask, approval: {approvers: [here-ops]}}
              - {id: read-elsewhere, tool: {source: node, name: read}, action: ask, approval: {approvers: [remote-ops]}}
            """
        );
        var call = f.Call("read", Obj("""{"filePath":"seed.txt"}"""));
        var pending = await PendingAsync(f.Owner);
        Assert.Equal(["here-ops"], Approvers(pending));
        await f.Manager.SelectNodeAsync(f.Owner, "fixture/target");
        await Approve(f.Manager, f.Owner, pending);
        var result = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal("tool_approval_unavailable", ErrorType(result));
        Assert.Contains("under rule read-elsewhere", result?.FailureMessage());
        Assert.Equal("cancelled", SessionWait.Text(Assert.Single(Records(f.Owner))["status"]));
    }
}
