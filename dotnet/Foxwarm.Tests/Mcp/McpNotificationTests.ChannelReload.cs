using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Fact]
    public async Task Actual_live_temporary_reply_context_survives_mixed_managed_reload_and_partial_start_without_becoming_an_attachment()
    {
        await using var protocol = await ExternalProtocolPeer.StartAsync();
        await using var bot = await TelegramPeer.StartAsync();
        await using var qq = await QQBotPeer.StartAsync();
        await using var work = await WeWorkPeer.StartAsync();
        await using var peer = await InboundMcpFixture.CreateAsync();
        var router = new MessageRouter(new SessionRuntime(peer.Manager));
        peer.Manager.InitializeChannels(router, peer.Configuration, bot.Dependencies with { CreateQQBotHttp = qq.Dependencies.CreateQQBotHttp });
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
        app["channels"] = new JsonObject
        {
            ["alpha"] = ExternalChannelFixture.Channel(),
            ["matrix"] = protocol.Matrix(),
            ["weixin"] = protocol.Weixin(),
            ["work"] = work.Config(stream: false),
            ["qq"] = qq.Config(),
        };
        var first = await peer.Configuration.SaveAppAsync(app.ToJsonString());
        Assert.Equal(5, first["reload"]!["started"]!.AsArray().Count);
        var second = await peer.Configuration.SaveAppAsync(app.ToJsonString());
        Assert.Equal(5, second["reload"]!["stopped"]!.AsArray().Count);
        Assert.Equal(5, second["reload"]!["started"]!.AsArray().Count);
        bot.Fail = call => call.Method == "getMe" ? (401, "controlled bootstrap failure") : null;
        var partial = await peer.Configuration.SaveAppAsync(app.ToJsonString());
        Assert.Equal(4, partial["reload"]!["started"]!.AsArray().Count);
        Assert.Contains("channels.alpha", partial["notApplied"]!.ToString());
        Assert.NotNull(peer.Manager.ChannelRegistry.Get("matrix"));
        Assert.NotNull(peer.Manager.ChannelRegistry.Get("weixin"));
        Assert.NotNull(peer.Manager.ChannelRegistry.Get("work"));
        Assert.NotNull(peer.Manager.ChannelRegistry.Get("qq"));
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
