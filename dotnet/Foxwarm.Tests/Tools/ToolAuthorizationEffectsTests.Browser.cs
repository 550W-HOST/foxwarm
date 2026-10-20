using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Main_browser_exact_grants_cross_only_the_browser_bound_node_fence_after_generic_policy()
    {
        using var temp = new TempDirectory();
        var names = new[]
        {
            "browse_open",
            "browse_list",
            "browse_get",
            "browse_close",
            "browse_interact",
        };
        var rules = new JsonArray(
            names
                .Select(name =>
                    (JsonNode)
                        new JsonObject
                        {
                            ["source"] = "node",
                            ["node"] = "master",
                            ["tool"] = name,
                            ["effect"] = "allow",
                        }
                )
                .ToArray()
        );
        // Unrelated exact grants cannot cross the Node fence or structural restrictions.
        foreach (var name in new[] { "exec", "read" })
            rules.Add(
                new JsonObject
                {
                    ["source"] = "node",
                    ["node"] = "master",
                    ["tool"] = name,
                    ["effect"] = "allow",
                }
            );
        rules.Add(
            new JsonObject
            {
                ["source"] = "builtin",
                ["tool"] = "create_agent",
                ["effect"] = "allow",
            }
        );
        await Seed(
            temp.Path,
            new JsonObject
            {
                ["isolated"] = true,
                ["isolatedNode"] = "remote",
                ["toolRules"] = rules,
            }
        );
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        Assert.Equal("remote", manager.CurrentNode(owner));
        foreach (var name in names)
        {
            var resolved = new ResolvedTool(
                "call_tool",
                "node",
                name,
                new(),
                ExecutionNode: "master"
            );
            await manager.AuthorizeToolAsync(owner, resolved, null, CancellationToken.None);
            Assert.True(manager.ToolVisible(owner, "node", name, node: "master"));
        }
        foreach (var name in new[] { "exec", "read" })
        {
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(
                    owner,
                    new("call_tool", "node", name, new(), ExecutionNode: "master"),
                    null,
                    CancellationToken.None
                )
            );
            Assert.False(manager.ToolVisible(owner, "node", name, node: "master"));
        }
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.SelectNodeAsync(owner, "master")
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new("create_agent", "builtin", "create_agent", new()),
                null,
                CancellationToken.None
            )
        );
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
            - action: deny
              tool: {source: node, name: browse_list}
              node: master
            """
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new("call_tool", "node", "browse_list", new(), ExecutionNode: "master"),
                null,
                CancellationToken.None
            )
        );
        Assert.False(manager.ToolVisible(owner, "node", "browse_list", node: "master"));
        // A current-Node selector sees remote, not the explicit master effect.
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
            - action: deny
              tool: {source: node, name: browse_list}
              node: {current: true}
            """
        );
        await manager.AuthorizeToolAsync(
            owner,
            new("call_tool", "node", "browse_list", new(), ExecutionNode: "master"),
            null,
            CancellationToken.None
        );
        Assert.Equal("remote", manager.CurrentNode(owner));
    }

    [Fact]
    public async Task Generic_allow_does_not_replace_isolated_exact_browser_grants_and_hidden_tools_stay_discoverable()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, new JsonObject { ["isolated"] = true, ["isolatedNode"] = "remote" });
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        await Policy(manager, "version: 1\ndefaultAction: allow\n");
        foreach (var definition in MainBrowserDefinitions.All().OfType<JsonObject>())
        {
            var name = definition["name"]!.GetValue<string>();
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(
                    owner,
                    new("call_tool", "node", name, new(), ExecutionNode: "master"),
                    null,
                    CancellationToken.None
                )
            );
            Assert.False(manager.ToolVisible(owner, "node", name, node: "master"));
        }
        var normal = await manager.RequiredAsync("outside");
        Assert.DoesNotContain(
            manager.ModelDefinitions(normal).OfType<JsonObject>(),
            item => MainBrowserDefinitions.Contains(SessionWait.Text(item["name"])!)
        );
        var execution = Executor(manager, normal, temp.Path);
        await using var mcp = execution.Mcp;
        var search = await Call(
            execution.Tools,
            "search_tools",
            Obj("""{"query":"browse_list","sources":["node"],"nodeId":"master","limit":1}""")
        );
        Assert.Contains("node:master/browse_list", search["output"]!.GetValue<string>());
        var result = await execution.Tools.ExecuteAsync(
            Obj("""{"id":"scalar","name":"browse_list","args":{}}"""),
            CancellationToken.None
        );
        Assert.Equal("No tabs open", SessionWait.Text(result));
    }
}
