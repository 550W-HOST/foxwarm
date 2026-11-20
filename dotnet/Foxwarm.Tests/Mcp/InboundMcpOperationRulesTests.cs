using System.Text.Json.Nodes;
using Foxwarm;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Inbound MCP under operation rules (operation authorization phase 3): each external action
// keeps its identity and raw arguments and gains its operations; an op deny, an ask or an
// unresolved operation is the same fixed denial as a version-1 deny, with nothing disclosed.
public sealed class InboundMcpOperationRulesTests
{
    [Fact]
    public async Task External_actions_are_decided_by_op_rules_with_the_same_fixed_denial()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(f.Configuration.Access, InboundMcpFixture.Alpha)!
        );
        var authorization = new McpExternalAuthorization(f.Manager.Authorization, f.Work);
        var view = authorization.Request(
            context,
            "builtin",
            "view_session",
            new JsonObject { ["sessionId"] = f.Target.Id }
        );
        var list = authorization.Request(context, "builtin", "session", new JsonObject { ["action"] = "list" });
        var status = authorization.Request(
            context,
            "builtin",
            "node",
            new JsonObject { ["action"] = "status", ["nodeId"] = "master" },
            node: "master"
        );

        async Task<string?> Denial(ToolAuthorizationRequest request)
        {
            try
            {
                await authorization.RequireAsync(context, request, default);
                return null;
            }
            catch (McpInboundSafeException error)
            {
                return error.Message;
            }
        }

        // Version-1 baseline.
        await f.PolicyAsync("version: 1\ndefaultAction: allow\nrules:\n- {id: v1, tool: {source: builtin, name: view_session}, action: deny}\n");
        var baseline = await Denial(view);
        Assert.Equal("Tool action is not permitted.", baseline);

        // Grants by canonical Session ID and the external-only node status as node.view.
        await f.PolicyAsync(
            $"version: 1\ndefaultAction: allow\nrules:\n- {{id: target, op: session.view, targetSession: {{id: [\"{f.Target.Id}\"]}}, externalId: alpha, action: allow}}\n- {{id: no-views, op: session.view, action: deny}}\n- {{id: no-status, op: node.view, node: {{exact: master}}, action: deny}}\n- {{id: lists, op: session.list, action: allow}}\n"
        );
        Assert.Null(await Denial(view));
        Assert.Null(await Denial(list));
        Assert.Equal(baseline, await Denial(status));

        // Relation selectors never match external principals; ask is a deny.
        await f.PolicyAsync(
            "version: 1\ndefaultAction: allow\nrules:\n- {id: own, op: session.view, targetSession: {session: {self: true}}, action: allow}\n- {id: confirm, op: session.list, action: ask}\n- {id: views, op: session.view, action: deny}\n"
        );
        Assert.Equal(baseline, await Denial(view));
        Assert.Equal(baseline, await Denial(list));

        // An operation the rules cannot decide is the same fixed denial.
        var missing = authorization.Request(
            context,
            "builtin",
            "node",
            new JsonObject { ["action"] = "teleport" }
        );
        await f.PolicyAsync("version: 1\ndefaultAction: allow\nrules:\n- {id: marker, op: node.select, action: deny}\n");
        Assert.Equal(baseline, await Denial(missing));
    }
}
