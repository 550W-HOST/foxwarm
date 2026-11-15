using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Phase-1 attribution through ToolScript, creation-target rules and the external boundary.
public sealed partial class ToolAuthorizationEffectsTests
{
    private const string SelectPolicy = """
        version: 1
        defaultAction: allow
        rules:
          - id: no-select
            tool: {source: builtin, name: node}
            args: {action: select}
            action: deny
        """;

    // A ToolScript ctl command runs as its concrete capability and keeps the command it came
    // from, as a direct ctl call does. The command is display only: fingerprints ignore it.
    [Fact]
    public async Task Nested_ctl_denials_name_the_command_and_fingerprints_ignore_it()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var node = NodeToolDefinitions
            .All()
            .OfType<JsonObject>()
            .Single(item => item["name"]!.GetValue<string>() == "node");
        execution.Registry.Register(
            node,
            "builtin",
            false,
            (caller, args, token) => manager.ExecuteNodeToolAsync(caller.Hosted, args, token)
        );
        await Policy(manager, SelectPolicy);

        var direct = await Call(execution.Tools, "ctl", Obj("""{"command":"node select master"}"""));
        Assert.EndsWith("called as `ctl node select`.", Message(direct));
        var nested = await Call(
            execution.Tools,
            "run_script",
            Obj("""{"code":"return ctl('node select master')"}""")
        );
        var text = nested["error"]!.GetValue<string>();
        Assert.Contains(
            "Rule `no-select` (#1) in the global policy denied `builtin:node`, called as `ctl node select`.",
            text
        );
        Assert.DoesNotContain("called as `call_tool`", text);

        var resolved = execution.Registry.Resolve("ctl", Obj("""{"command":"node select master"}"""));
        Assert.Equal("node select", resolved.Command);
        var request = new ToolAuthorizationRequest(
            "builtin",
            "node",
            null,
            resolved.Args,
            [],
            "alpha",
            owner.Id,
            "master",
            "/w",
            "/a",
            "/a/m"
        );
        Assert.Equal(
            ToolApprovalScope.Fingerprint(resolved with { Command = null }, request),
            ToolApprovalScope.Fingerprint(resolved, request)
        );
    }

    // A creation-target probe keeps the rule that settled it, in full and compact explain
    // output and in the timer's denial; null is the default action.
    [Fact]
    public async Task Creation_target_results_name_the_deciding_rule()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, OperationPolicy);

        var args = Obj(
            """
            {"probes":[
              {"sessionId":"opaque","toolId":"builtin:create_timer","args":{"newSession":true,"agentName":"beta","message":"later","afterSeconds":3600}},
              {"sessionId":"opaque","toolId":"builtin:create_timer","args":{"newSession":true,"agentName":"alpha","message":"later","afterSeconds":3600}}
            ]}
            """
        );
        var full = (await Explain(execution.Tools, (JsonObject)args.DeepClone()))["probes"]!.AsArray();
        JsonObject Target(JsonNode probe) =>
            probe["active"]!["obligations"]!
                .AsArray()
                .OfType<JsonObject>()
                .Single(item => item["id"]!.GetValue<string>() == "creation-target");
        var denied = Target(full[0]!);
        Assert.Equal("deny", denied["decision"]!.GetValue<string>());
        Assert.True(
            JsonNode.DeepEquals(
                Obj("""{"layer":"global","decision":"deny","rule":{"index":3,"id":"no-new-beta"}}"""),
                denied["layers"]![0]
            ),
            denied.ToJsonString()
        );
        var allowed = Target(full[1]!)["layers"]![0]!;
        Assert.Null(allowed["rule"]);
        Assert.Equal("allow", allowed["default"]!.GetValue<string>());

        args["compact"] = true;
        var compact = (await Explain(execution.Tools, args))["probes"]!.AsArray();
        Assert.True(
            JsonNode.DeepEquals(
                Obj("""{"id":"creation-target","decision":"deny","rule":"no-new-beta"}"""),
                compact[0]!["obligation"]
            ),
            compact[0]!.ToJsonString()
        );
        Assert.Null(compact[1]!["obligation"]);
    }

    // External denials keep their generic text; no rule, layer or command reaches the peer.
    [Fact]
    public async Task External_denials_disclose_no_policy_detail()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
              - id: hidden-session-rule
                tool: {source: builtin, name: session}
                action: deny
                reason: private reason
            """
        );
        var access = new AccessConfiguration(InboundMcpFixture.App());
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(access, InboundMcpFixture.Alpha)!
        );
        var external = new McpExternalAuthorization(manager.Authorization, temp.Path);
        var request = external.Request(
            context,
            "builtin",
            "session",
            new JsonObject { ["action"] = "list" }
        );
        var error = await Assert.ThrowsAsync<McpInboundSafeException>(() =>
            external.RequireAsync(context, request, default)
        );
        Assert.Equal("Tool action is not permitted.", error.Message);
        var again = Assert.Throws<McpInboundSafeException>(() => external.Require(context, request));
        Assert.Equal("Tool action is not permitted.", again.Message);
    }
}
