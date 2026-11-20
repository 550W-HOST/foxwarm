using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class TelegramChannelTests
{
    [Fact]
    public async Task Polling_unknown_slash_text_preserves_raw_text_and_ordinary_guest_admission()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var channel = ExternalChannelFixture.Channel();
        channel["guestAgent"] = new JsonObject { ["agentId"] = "guest", ["isolated"] = false };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = channel },
            dependencies: peer.Dependencies
        );
        await f.Manager.CreateAgentAsync("guest", createMainSession: false);
        f.Manager.AttachChannel("alpha:42", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        // A known command still reaches the existing direct command authorization gate.
        peer.Push("a", TelegramPeer.Text("99", "999", "/stop"));
        await Until(() =>
            peer.Sent("a")
                .Any(call => (SessionWait.Text(call.Body["text"]) ?? "").Contains("Unauthorized"))
        );
        Assert.Null(f.Manager.ChannelBinding("alpha:99"));
        var replies = peer.Sent("a").Count();
        var texts = new[]
        {
            "/stpo",
            "/Stop",
            "/unknown@owned_bot preserve suffix\ntext  ",
            "/home/example/file",
        };
        foreach (var text in texts)
            peer.Push("a", TelegramPeer.Text("42", "11", text));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == texts.Length);
        foreach (var (item, text) in f.Owner.Entry.Snapshot().Queue.Zip(texts))
            Assert.Contains("\n" + text + "\n", SessionWait.Text(item.Parts![0]["system"]));
        peer.Push("a", TelegramPeer.Text("99", "999", "/stpo"));
        await Until(() => f.Manager.ChannelBinding("alpha:99")?["sessionId"] is not null);
        var guest = await f.Manager.RequiredAsync(
            f.Manager.ChannelBinding("alpha:99")!["sessionId"]!.GetValue<string>()
        );
        await Until(() => guest.Entry.Snapshot().Queue.Count == 1);
        Assert.Equal("guest", guest.Agent);
        Assert.Contains(
            "/stpo",
            SessionWait.Text(guest.Entry.Snapshot().Queue.Single().Parts![0]["system"])
        );
        Assert.Equal(replies, peer.Sent("a").Count());
    }
}
