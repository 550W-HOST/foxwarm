using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Node operation facts on the enforcement and inbound paths, and capability visibility with
// operation attributes the caller has not stated (operation authorization phase 3).
public sealed partial class NodeAuthorizationTreeTests
{
    [Fact]
    public async Task Node_removal_supplies_its_member_facts_at_enforcement()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("victim");
        f.Manager.Nodes.Registry.Create("kept");
        // An unrelated operation rule leaves removal decidable.
        await f.Policy("version: 1\nrules:\n- {op: node.select, action: deny}\n");
        var removed = await f.Call("node_remove", Obj("{\"nodeId\":\"victim\"}"));
        Assert.True(removed?["error"] is null, removed?.ToJsonString());
        Assert.DoesNotContain("\"victim\"", f.Manager.Nodes.Registry.ListApproved().ToJsonString());
        // A rule on the member decides it.
        await f.Policy("version: 1\nrules:\n- {op: node.trust, node: kept, with: {action: revoke}, action: deny}\n");
        var denied = await f.Call("node_remove", Obj("{\"nodeId\":\"kept\"}"));
        Assert.Contains("denied", denied!.ToJsonString());
        Assert.Contains("\"kept\"", f.Manager.Nodes.Registry.ListApproved().ToJsonString());
    }

    [Fact]
    public async Task Inbound_node_status_views_the_selected_node()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var client = await f.ClientAsync();
        await f.PolicyAsync("version: 1\nrules:\n- {op: node.view, node: {exact: master}, action: allow}\n");
        var allowed = await InboundMcpFixture.CallAsync(client, "foxwarm_node", Obj("{\"action\":\"status\"}"));
        Assert.Contains("currentNode", allowed!.ToJsonString());
        Assert.DoesNotContain("not permitted", allowed.ToJsonString());
        await f.PolicyAsync("version: 1\nrules:\n- {op: node.view, node: {exact: other}, action: allow}\n");
        var denied = await InboundMcpFixture.CallAsync(client, "foxwarm_node", Obj("{\"action\":\"status\"}"));
        Assert.Contains("Tool action is not permitted.", denied!.ToJsonString());
    }

    [Fact]
    public async Task Capability_visibility_keeps_unstated_operation_attributes_unknown()
    {
        await using var f = await Fixture.Create();
        await f.Policy(
            "version: 1\ndefaultAction: deny\nrules:\n- {op: session.create, with: {placement: explicit}, action: allow}\n"
        );
        Assert.True(f.Manager.ToolVisible(f.Owner, "builtin", "create_session"));
        var created = await f.Call(
            "create_session",
            Obj("{\"agentName\":\"main\",\"sessionName\":\"explicit-placement\",\"node\":\"master\"}")
        );
        Assert.True(created?["error"] is null, created?.ToJsonString());
        Assert.Contains(
            "denied",
            (await f.Call("create_session", Obj("{\"agentName\":\"main\",\"sessionName\":\"inherited\"}")))!.ToJsonString()
        );
    }
}
