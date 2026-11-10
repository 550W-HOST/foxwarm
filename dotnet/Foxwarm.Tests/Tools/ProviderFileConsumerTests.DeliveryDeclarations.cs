using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// send_file and image_write_to_file choose their Node per call, so their default declarations
// must not follow the Session's current Node. The restriction is enforced when they are called.
public sealed partial class ProviderFileConsumerTests
{
    private static readonly string[] DeliveryTools = ["send_file", "image_write_to_file"];

    private static string[] DeclaredNames(string serialized) =>
        JsonNode
            .Parse(serialized)!
            .AsArray()
            .Select(tool => tool!["name"]!.GetValue<string>())
            .ToArray();

    private static async Task AssertDeclarationsStableAcrossNodes(
        Fixture f,
        params string[] expected
    )
    {
        var nodes = new[] { "master", f.Node, "fixture/readonly", "master" };
        string? canonical = null;
        foreach (var node in nodes)
        {
            await f.Manager.SelectNodeAsync(f.Owner, node);
            var serialized = f.Manager.ModelDefinitions(f.Owner).ToJsonString();
            canonical ??= serialized;
            Assert.Equal(canonical, serialized);
            Assert.Equal(
                canonical,
                f.Manager.ModelDefinitions(f.Owner, batchControls: true).ToJsonString()
            );
            var declared = DeclaredNames(serialized);
            foreach (var name in DeliveryTools)
                Assert.Equal(expected.Contains(name), declared.Contains(name));
        }
    }

    [Theory]
    [InlineData("version: 1\nrules: []\n")]
    [InlineData(
        "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: {current: true}\n"
    )]
    [InlineData(
        "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: {provider: fixture}\n"
    )]
    [InlineData(
        "version: 1\nrules:\n- action: deny\n  tool: {source: builtin, name: [send_file, image_write_to_file]}\n  node: {provider: fixture}\n"
    )]
    [InlineData(
        "version: 1\nrules:\n- action: deny\n  tool: {source: builtin, name: image_write_to_file}\n  node: {exact: master}\n"
    )]
    public async Task Delivery_declarations_are_identical_across_Node_selection_for_Node_targeted_policy(
        string policy
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            policy
        );
        f.Manager.Authorization.Invalidate();
        await AssertDeclarationsStableAcrossNodes(f, DeliveryTools);
    }

    [Fact]
    public async Task Delivery_declarations_are_identical_across_Node_selection_for_shipped_channel_assistant_rules()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var rules = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "skills",
                        "agent-management",
                        "references",
                        "memory-templates",
                        "channel-assistant.rules.json"
                    )
                )
            )!
            .AsArray();
        await f.Manager.SetAgentRulesAsync(f.Owner.Agent, rules);
        // The Agent's rules allow send_file only with arguments and give image_write_to_file no
        // allowance, so the second stays hidden on every Node.
        await AssertDeclarationsStableAcrossNodes(f, "send_file");
    }

    [Fact]
    public async Task Delivery_calls_denied_on_the_current_Node_fail_while_declarations_stay_unchanged()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        var canonical = f.Manager.ModelDefinitions(f.Owner).ToJsonString();
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules:\n- action: deny\n  tool: {source: builtin, name: [send_file, image_write_to_file]}\n  node: {provider: fixture}\n"
        );
        f.Manager.Authorization.Invalidate();
        Assert.Equal(canonical, f.Manager.ModelDefinitions(f.Owner).ToJsonString());
        var before = (await f.Requests()).Length;
        var send = await f.Call(
            "send_file",
            new JsonObject { ["filePath"] = "report.txt", ["channelTargetId"] = "chat:room" }
        );
        Assert.Equal("tool_authorization_denied", send["error"]!["type"]!.GetValue<string>());
        var image = await f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "missing", ["filePath"] = "image.png" }
        );
        Assert.Equal("tool_authorization_denied", image["error"]!["type"]!.GetValue<string>());
        var unified = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "builtin:send_file",
                ["args"] = new JsonObject
                {
                    ["filePath"] = "report.txt",
                    ["channelTargetId"] = "chat:room",
                },
            }
        );
        Assert.Equal("tool_authorization_denied", unified["error"]!["type"]!.GetValue<string>());
        Assert.Equal(before, (await f.Requests()).Length);

        // The same calls on master are not refused by this Node-targeted rule.
        await f.Manager.SelectNodeAsync(f.Owner, "master");
        Assert.Equal(canonical, f.Manager.ModelDefinitions(f.Owner).ToJsonString());
        var master = await f.Call(
            "send_file",
            new JsonObject { ["filePath"] = "report.txt", ["channelTargetId"] = "chat:room" }
        );
        Assert.NotEqual("tool_authorization_denied", master["error"]?["type"]?.GetValue<string>());
    }

    [Fact]
    public async Task Delivery_calls_outside_an_isolated_Agents_Nodes_fail_while_declarations_remain()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await f.Manager.SetAgentIsolationAsync(f.Owner.Agent, f.Node, true, null);
        Assert.True(f.Manager.AgentIsolated(f.Owner.Agent));
        Assert.Subset(
            DeclaredNames(f.Manager.ModelDefinitions(f.Owner).ToJsonString()).ToHashSet(),
            DeliveryTools.ToHashSet()
        );
        var send = await f.Call(
            "send_file",
            new JsonObject
            {
                ["filePath"] = "report.txt",
                ["node"] = "other/target",
                ["channelTargetId"] = "chat:room",
            }
        );
        Assert.Equal("tool_authorization_denied", send["error"]!["type"]!.GetValue<string>());
        Assert.Contains("bound/current Node", send["error"]!["message"]!.GetValue<string>());
        var image = await f.Call(
            "image_write_to_file",
            new JsonObject
            {
                ["id"] = "missing",
                ["filePath"] = "image.png",
                ["node"] = "other/target",
            }
        );
        Assert.Equal("tool_authorization_denied", image["error"]!["type"]!.GetValue<string>());
    }
}
