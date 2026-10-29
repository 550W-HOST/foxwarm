using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Fact]
    public async Task Ancestor_rule_changes_gate_existing_receiver_without_memory_refresh_or_global_replacement()
    {
        await using var peer = await InboundMcpFixture.CreateAsync();
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.Manager.CreateAgentAsync("receiver", creator: f.First);
        var child = await f.Manager.RequiredAsync("receiver/main");
        child.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Connect(f, peer);
        Assert.Equal("receiving", State(await Notifications(f, "start", child)));
        var destination = Target(
            await f.CallAsync(child, "foxwarm_session", Send(peer.Target.Id, "register"))
        );
        await f.Manager.SetAgentRulesAsync(
            "main",
            JsonNode.Parse("""[{"tool":"mcp_notifications","action":"deny"}]""")!.AsArray()
        );
        using (var completion = new NotificationHandling(Foxwarm.McpClient.SessionMessageMethod))
        {
            Assert.Null((await Reply(peer, destination, "blocked by ancestor"))!["error"]);
            await completion.WaitAsync();
        }
        Assert.Empty(Queue(child));
        await f.Manager.SetAgentRulesAsync("main", new JsonArray());
        Assert.Null((await Reply(peer, destination, "permitted again"))!["error"]);
        await Until(() => Queue(child).Length == 1);
        Assert.Equal("permitted again", Queue(child)[0].Parts![1]["text"]!.GetValue<string>());
    }
}
