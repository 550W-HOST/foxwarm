using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Limits;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedAgentStoreTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Received_Telegram_file_belongs_to_the_named_instances_recipient(bool guest)
    {
        await using var peer = await TelegramPeer.StartAsync();
        var config = ExternalChannelFixture.Channel();
        config["guestAgent"] = new JsonObject { ["agentId"] = "guest", ["mode"] = "inherited", ["isolated"] = false };
        await using var f = await StoreFixture.Create(store: true, extraApp: new() { ["channels"] = new JsonObject { ["named"] = config } },
            capabilities: RuntimeCapabilities.Hosted with { Egress = Foxwarm.Net.EgressPolicy.Unguarded });
        f.Manager.InitializeChannels(new MessageRouter(new SessionRuntime(f.Manager)), new ModelConfiguration(f.Inner.Data), peer.Dependencies);
        f.Manager.TopologyChanged += () => { foreach (var owner in f.Manager.Owners()) owner.Registry.TriggerOverride = _ => Task.CompletedTask; };
        await f.Manager.CreateAgentAsync(guest ? "guest" : "recipient", false);
        if (!guest)
            f.Manager.AttachChannel("named:100", await f.Manager.CreateNamedAsync("recipient", "files", null, null));
        try
        {
            var reload = await f.Manager.ManagedChannels!.ReloadAsync();
            Assert.Single(reload["started"]!.AsArray());
            peer.Files["note"] = "hello"u8.ToArray();
            var document = TelegramPeer.Text("100", guest ? "999" : "11", "");
            document.Remove("text");
            document["document"] = new JsonObject { ["file_id"] = "note", ["file_name"] = "a.txt", ["mime_type"] = "text/plain" };
            peer.Push("a", document);
            await TelegramChannelTests.Until(() => f.Manager.Owners().Any(owner => owner.Entry.Snapshot().Queue.Any(item => item.Source?.ChannelId == "named")));
            var receiver = Assert.Single(f.Manager.Owners().Where(owner => owner.Entry.Snapshot().Queue.Any(item => item.Source?.ChannelId == "named")));
            Assert.NotEqual("main", receiver.Agent);
            var file = Assert.Single(f.Store.List(receiver.Agent, ".temp/channel-files/telegram"));
            var path = ".temp/channel-files/telegram/" + file.Name;
            Assert.Equal("hello", await f.Store.ReadTextAsync(receiver.Agent, path, default));
            Assert.Contains("$fw_agentdir/" + path, string.Join("", receiver.Entry.Snapshot().Queue.Last().Parts!.Select(part => part.ToJsonString())));
            Assert.Empty(f.Store.List("main", ".temp/channel-files/telegram"));
        }
        finally { await f.Manager.ManagedChannels!.DisposeAsync(); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Saved_image_stays_in_message_when_inline_storage_is_full(bool qq)
    {
        await using var f = await StoreFixture.Create(store: true, capabilities: RuntimeCapabilities.Hosted with { Limits = TenantLimits.Defaults with { BlobBytes = 1 } });
        var bytes = TelegramChannelTests.Jpeg();
        var source = Path.Combine(f.Inner.Temp.Path, "photo.jpg");
        await File.WriteAllBytesAsync(source, bytes);
        var parts = qq
            ? await f.Manager.SaveInboundChannelFileFromPathAsync(f.Inner.Owner, "qqbot", source, bytes.Length, "photo.jpg", "image/jpeg", true, default)
            : await f.Manager.SaveInboundChannelFileAsync("telegram", "room", bytes, "photo.jpg", "image/jpeg", "caption", default);
        Assert.Contains("<foxwarm-image", SessionWait.Text(parts[0]["text"]));
        if (!qq) Assert.StartsWith("caption\n\n", SessionWait.Text(parts[0]["text"]));
        Assert.Equal("[Image not attached inline: the storage limit for images is reached.]", SessionWait.Text(parts[1]["text"]));
        Assert.Single(f.Store.List("main", ".temp/channel-files/" + (qq ? "qqbot" : "telegram")));
    }

    private sealed class AssetHandler(bool chunked) : HttpMessageHandler
    {
        internal int Requests;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Requests++;
            HttpContent content = chunked ? new StreamContent(new Chunked(new byte[32])) : new ByteArrayContent(new byte[32]);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(false, true)]
    public async Task QQ_reports_the_binding_hosted_cap(bool announced, bool chunked)
    {
        await using var f = await StoreFixture.Create(store: true, capabilities: RuntimeCapabilities.Hosted with { Limits = TenantLimits.Defaults with { UploadBytes = 8 } });
        var handler = new AssetHandler(chunked);
        using var http = new HttpClient(handler);
        var file = new JsonObject { ["filename"] = "note.txt", ["content_type"] = "text/plain", ["url"] = "https://asset.qq.com/sample" };
        if (announced) file["size"] = 32;
        var media = new QQBotMedia(f.Manager, http, new JsonObject(), null);
        var parts = await media.MaterializeAsync("caption", new JsonArray(file), f.Inner.Owner);
        Assert.Equal("caption", SessionWait.Text(parts[0]["text"]));
        var message = SessionWait.Text(parts[1]["text"]);
        Assert.StartsWith("[Received file not kept: \"note.txt\" (text/plain, " + (chunked ? "more than 8" : "32") + " bytes).", message);
        Assert.Equal(announced ? 0 : 1, handler.Requests);
        Assert.Empty(f.Store.List("main", ".temp/channel-files/qqbot"));
    }
}
