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
        Assert.Single((await peer.EventsAsync()).Where(item => item["kind"]?.ToString() == "list"));
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
}
