using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Fact]
    public async Task Actual_live_temporary_reply_context_survives_managed_Telegram_reload_without_becoming_an_attachment()
    {
        await using var bot = await TelegramPeer.StartAsync();
        await using var peer = await InboundMcpFixture.CreateAsync();
        var router = new MessageRouter(new SessionRuntime(peer.Manager));
        peer.Manager.InitializeChannels(router, peer.Configuration, bot.Dependencies);
        await using var managed = peer.Manager.ManagedChannels!;
        await using var sender = await OutboundMcpFixture.CreateAsync();
        await Connect(sender, peer);
        await Notifications(sender, "start");
        var target = Target(
            await sender.CallAsync(
                sender.First,
                "foxwarm_session",
                Send(peer.Target.Id, "reply-enabled")
            )
        );
        var app = JsonNode.Parse(peer.Configuration.ReadCurrentAppRaw())!.AsObject();
        app["channels"] = new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() };
        var first = await peer.Configuration.SaveAppAsync(app.ToJsonString());
        Assert.Single(first["reload"]!["started"]!.AsArray());
        var second = await peer.Configuration.SaveAppAsync(app.ToJsonString());
        Assert.Single(second["reload"]!["stopped"]!.AsArray());
        Assert.Single(second["reload"]!["started"]!.AsArray());
        Assert.Null((await Reply(peer, target, "after managed reload"))!["error"]);
        await Until(() => Queue(sender.First).Length == 1);
        Assert.Equal(
            "after managed reload",
            SessionWait.Text(Queue(sender.First).Single().Parts![1]["text"])
        );
        Assert.Null(peer.Manager.ChannelBinding(target));
        Assert.Equal("receiving", State(await Notifications(sender, "status")));
    }
}
