using System.Text.Json.Nodes;
using Foxwarm.Channels;
namespace Foxwarm.Tests;
public sealed partial class ChannelCursorTests
{
    [Fact]
    public async Task WeixinRestartRecoversAnUnreadableCursorAfterRepair()
    {
        await using var peer=await ExternalProtocolPeer.StartAsync();
        var f=await ExternalChannelFixture.CreateAsync(new(){["chat"]=peer.Weixin()},dependencies:peer.Dependencies);
        var path=Path.Combine(f.Data,"state","channel-cursors.json");
        Directory.CreateDirectory(path);
        await f.Manager.ManagedChannels!.ReloadAsync();
        var first=f.Manager.ChannelRegistry.Get("chat"); Assert.NotNull(first);
        await TelegramChannelTests.Until(()=>f.Manager.ManagedChannels.Statuses().ToJsonString().Contains("Weixin polling"));
        Assert.DoesNotContain(peer.Calls,c=>c.Path.EndsWith("/getupdates"));
        Directory.Delete(path);
        await f.Manager.ManagedChannels.ChangeAsync("restart","chat");
        Assert.NotSame(first,f.Manager.ChannelRegistry.Get("chat"));
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Path.EndsWith("/getupdates")));
        await f.DisposeAsync();
    }
}
