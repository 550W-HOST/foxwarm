using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ViewSessionPolicyTests
{
    [Theory]
    [InlineData("get_session_messages")]
    [InlineData("[get_session_messages, read]")]
    [InlineData("{source: builtin, name: get_session_messages}")]
    [InlineData("{source: builtin, name: [read, get_session_messages]}")]
    [InlineData("{source: builtin, name: {equals: get_session_messages}}")]
    [InlineData("{source: builtin, name: {oneOf: [get_session_messages]}}")]
    public async Task Old_persisted_deny_selectors_cover_new_direct_unified_and_native_paths(
        string selector
    )
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n- action: deny\n  tool: " + selector + "\n"
            ),
            default
        );
        var args = new JsonObject { ["sessionId"] = f.Owner.Id };
        Assert.False(f.Manager.ToolVisible(f.Owner, "builtin", "view_session"));
        Assert.NotNull((await f.Call("view_session", args))["error"]);
        Assert.NotNull(
            (
                await f.Call(
                    "call_tool",
                    new JsonObject
                    {
                        ["toolId"] = "builtin:view_session",
                        ["args"] = args.DeepClone(),
                    }
                )
            )["error"]
        );
        var script = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] = "return call_tool('view_session', {'sessionId':'" + f.Owner.Id + "'})",
            }
        );
        Assert.NotNull(script["result"]?["error"] ?? script["error"]);
    }

    [Fact]
    public async Task Old_target_allowlist_retains_required_self_scope_and_external_read_policy()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                defaultAction: deny
                rules:
                - action: allow
                  tool: {source: builtin, name: get_session_messages}
                  args: {sessionId: {session: {self: true}}}
                """
            ),
            default
        );
        Assert.Null(
            (
                await f.Call(
                    "view_session",
                    new JsonObject { ["sessionId"] = f.Owner.Id, ["count"] = 0 }
                )
            )["error"]
        );
        Assert.NotNull(
            (await f.Call("view_session", new JsonObject { ["sessionId"] = "other/main" }))["error"]
        );
        Assert.NotNull((await f.Call("view_session", new JsonObject()))["error"]);
        await using var inbound = await InboundMcpFixture.CreateAsync(allow: false);
        await inbound.PolicyAsync(
            "version: 1\nrules:\n- action: allow\n  externalId: alpha\n  tool: {source: builtin, name: get_session_messages}\n"
        );
        await ForkClearLifecycleTests.AppendAsync(
            inbound.Target,
            VectorFixture.Message("first raw"),
            VectorFixture.Message("second raw")
        );
        await using var client = await inbound.ClientAsync();
        var read = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_session",
            new JsonObject
            {
                ["action"] = "read",
                ["sessionId"] = inbound.Target.Id,
                ["start"] = 0,
                ["count"] = 1,
            }
        );
        Assert.False(read["isError"]?.GetValue<bool>() == true, read.ToJsonString());
        var value = read["structuredContent"]!;
        Assert.Equal(0, value["start"]!.GetValue<int>());
        Assert.Equal(1, value["count"]!.GetValue<int>());
        Assert.Equal(2, value["total"]!.GetValue<int>());
        Assert.Contains("first raw", value["preview"]!.GetValue<string>());
        Assert.NotNull(value["executionState"]);
    }

}
