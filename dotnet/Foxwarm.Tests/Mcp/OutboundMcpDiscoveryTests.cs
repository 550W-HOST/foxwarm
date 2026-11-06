using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class OutboundMcpDiscoveryTests
{
    [Fact]
    public async Task Discovery_retains_Source_SDK_deadline_independent_of_tool_call_override()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var fixture = await OutboundMcpFixture.CreateAsync();
        await fixture.ConfigureAsync(
            peer.Url + "/mcp?delayedList=true",
            extra: new JsonObject { ["timeoutSeconds"] = 1 }
        );
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(75));
        var watch = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            fixture.Mcp.ListToolsAsync(
                "peer",
                stop.Token,
                fixture.First,
                fixture.First.McpGeneration
            )
        );
        Assert.Contains("discovery timed out", error.Message);
        Assert.InRange(watch.Elapsed.TotalSeconds, 59, 70);
        Assert.Single(await peer.EventsAsync(), item => item["kind"]?.ToString() == "list");
        var tools = await fixture.Mcp.ListToolsAsync(
            "peer",
            stop.Token,
            fixture.First,
            fixture.First.McpGeneration
        );
        Assert.Contains(tools, tool => tool["name"]!.ToString() == "probe");
        var events = await peer.EventsAsync();
        Assert.Equal(2, events.Count(item => item["kind"]?.ToString() == "list"));
        Assert.DoesNotContain(events, item => item["kind"]?.ToString() is "call" or "effect");
    }

    [Fact]
    public async Task Broad_search_for_isolated_Agent_connects_only_to_servers_with_MCP_allow_rules()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var fixture = await OutboundMcpFixture.CreateAsync(
            mainMetadata: new JsonObject
            {
                ["isolated"] = true,
                ["toolRules"] = new JsonArray(
                    new JsonObject
                    {
                        ["source"] = "mcp",
                        ["effect"] = "allow",
                        ["server"] = "peer",
                        ["tool"] = "probe",
                    }
                ),
            }
        );
        await fixture.ConfigureAsync(peer.Url + "/mcp");
        await fixture.Mcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "unlisted",
                ["url"] = "http://127.0.0.1:1/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        var result = await fixture
            .Tools(fixture.First)
            .ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "search",
                    ["name"] = "search_tools",
                    ["args"] = new JsonObject
                    {
                        ["query"] = "probe",
                        ["sources"] = new JsonArray("mcp"),
                    },
                },
                default
            );
        var text = result!.ToJsonString();
        Assert.Contains("mcp:peer/probe", text);
        Assert.DoesNotContain("unlisted", text);
    }

    [Fact]
    public async Task Broad_search_lists_servers_concurrently_within_shared_budget()
    {
        using var slowRoot = new TempDirectory();
        using var fastRoot = new TempDirectory();
        await using var slow = await OutboundSdkPeer.StartAsync(slowRoot.Path);
        await using var fast = await OutboundSdkPeer.StartAsync(fastRoot.Path);
        await using var fixture = await OutboundMcpFixture.CreateAsync();
        await fixture.Mcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "a-slow",
                ["url"] = slow.Url + "/mcp?delayedList=true",
                ["transport"] = "streamable-http",
            },
            default
        );
        await fixture.ConfigureAsync(fast.Url + "/mcp");
        var watch = Stopwatch.StartNew();
        var result = await fixture
            .Tools(fixture.First)
            .ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "search",
                    ["name"] = "search_tools",
                    ["args"] = new JsonObject
                    {
                        ["query"] = "probe",
                        ["sources"] = new JsonArray("mcp"),
                    },
                },
                default
            );
        Assert.InRange(
            watch.Elapsed.TotalSeconds,
            Foxwarm.Tools.UnifiedTools.BroadMcpBudget.TotalSeconds - 1,
            Foxwarm.Tools.UnifiedTools.BroadMcpBudget.TotalSeconds + 10
        );
        var text = result!.ToJsonString();
        Assert.Contains("mcp:peer/probe", text);
        Assert.Contains(
            "MCP server a-slow: tool discovery did not finish within the 15-second",
            text
        );
        Assert.Single(await slow.EventsAsync(), item => item["kind"]?.ToString() == "list");
    }
}
