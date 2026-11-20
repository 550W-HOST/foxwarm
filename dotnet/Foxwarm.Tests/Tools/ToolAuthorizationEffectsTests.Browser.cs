using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Browser_tools_follow_generic_node_authorization_and_old_persisted_names_still_load()
    {
        using var temp = new TempDirectory();
        // A persisted exact grant naming the retired browse_* tools is inert data: the Agent loads,
        // and the new tools gain nothing from it.
        var rules = new JsonArray(
            new[] { "browse_open", "browse_list", "browser_tabs", "browser_open" }
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
        foreach (var name in new[] { "browser_tabs", "browser_open" })
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

        var outside = await manager.RequiredAsync("outside");
        await Policy(manager, "version: 1\ndefaultAction: allow\n");
        await manager.AuthorizeToolAsync(
            outside,
            new("call_tool", "node", "browser_tabs", new(), ExecutionNode: "master"),
            null,
            CancellationToken.None
        );
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
            - action: deny
              tool: {source: node, name: browser_tabs}
              node: master
            """
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                outside,
                new("call_tool", "node", "browser_tabs", new(), ExecutionNode: "master"),
                null,
                CancellationToken.None
            )
        );
        Assert.False(manager.ToolVisible(outside, "node", "browser_tabs", node: "master"));
    }

    [Fact]
    public async Task Browser_tools_are_discoverable_only_when_this_machine_can_run_them()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var normal = await manager.RequiredAsync("outside");
        Assert.DoesNotContain(
            manager.ModelDefinitions(normal).OfType<JsonObject>(),
            item => SessionWait.Text(item["name"])!.StartsWith("browser_")
        );
        var execution = Executor(manager, normal, temp.Path);
        await using var mcp = execution.Mcp;
        var search = await Call(
            execution.Tools,
            "ctl",
            CtlTestArgs.Search(Obj("""{"query":"browser_tabs","sources":["node"],"nodeId":"master","limit":1}"""))
        );
        var runnable = new BrowserHost(BrowserHost.DefaultBundlePath()).Describe().Available;
        Assert.Equal(
            runnable,
            search["output"]!.GetValue<string>().Contains("node:master/browser_tabs")
        );
        if (!runnable)
            return;
        var result = await execution.Tools.ExecuteAsync(
            Obj("""{"id":"tabs","name":"browser_tabs","args":{}}"""),
            CancellationToken.None
        );
        Assert.Equal(0, result!["tabs"]!.AsArray().Count);
    }

    [Fact]
    public async Task Explanation_uses_the_same_generic_path_as_enforcement_for_browser_tools()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        // Browser tools are registered only where the host bundle and node exist. Probes resolve
        // through the manager's registry, so supply the two entries when this build has none.
        foreach (var name in new[] { "browser_open", "browser_tabs" })
            if (
                !manager.ToolRegistry.Entries.Any(entry =>
                    SessionWait.Text(entry.Definition["name"]) == name
                )
            )
                manager.ToolRegistry.RegisterBrowser(
                    new JsonObject
                    {
                        ["type"] = "function",
                        ["name"] = name,
                        ["description"] = "Browser tool.",
                        ["parameters"] = new JsonObject
                        {
                            ["type"] = "object",
                            ["properties"] = new JsonObject
                            {
                                ["url"] = new JsonObject { ["type"] = "string" },
                            },
                        },
                    },
                    () => true
                );
        await Policy(
            manager,
            """
            version: 1
            defaultAction: allow
            rules:
              - id: beta-no-browser-open
                agent: beta
                tool: {source: node, name: browser_open}
                action: deny
                reason: no browser for beta
            """
        );
        var result = await Explain(
            execution.Tools,
            Obj(
                """
                {"probes":[
                  {"sessionId":"outside","toolId":"node:master/browser_open","args":{"url":"http://127.0.0.1:1/"}},
                  {"sessionId":"outside","toolId":"node:master/browser_tabs","args":{}}
                ]}
                """
            )
        );
        var denied = result["probes"]![0]!["active"]!;
        Assert.False(denied["allowed"]!.GetValue<bool>());
        Assert.Equal("policy", denied["deniedBy"]!.GetValue<string>());
        Assert.True(result["probes"]![1]!["active"]!["allowed"]!.GetValue<bool>());
        // Enforcement agrees with the explanation.
        var outside = await manager.RequiredAsync("outside");
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                outside,
                new("call_tool", "node", "browser_open", new(), ExecutionNode: "master"),
                null,
                CancellationToken.None
            )
        );
        await manager.AuthorizeToolAsync(
            outside,
            new("call_tool", "node", "browser_tabs", new(), ExecutionNode: "master"),
            null,
            CancellationToken.None
        );
    }
}
