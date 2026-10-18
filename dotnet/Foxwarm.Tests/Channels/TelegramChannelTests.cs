using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class TelegramChannelTests
{
    internal static async Task Until(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (!condition()) await Task.Delay(10, deadline.Token);
    }

    internal static byte[] Jpeg()
    {
        using var bitmap = new SKBitmap(2, 2);
        bitmap.Erase(SKColors.Blue);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, 90);
        return data.ToArray();
    }

    [Fact]
    public async Task Real_polling_keeps_two_instances_sender_identity_raw_text_commands_offsets_and_eager_media_order()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject
        {
            ["alpha"] = ExternalChannelFixture.Channel("a"), ["beta"] = ExternalChannelFixture.Channel("b"),
        }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("alpha:-100", f.Owner);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        f.Manager.AttachChannel("beta:-100", second);
        var reload = await f.Manager.ManagedChannels!.ReloadAsync();
        Assert.Equal(2, reload["started"]!.AsArray().Count);
        foreach (var bot in new[] { "a", "b" })
        {
            Assert.Equal(new[] { "setMyCommands", "getMe", "deleteWebhook" }, peer.Calls.Where(call => call.Bot == bot).Take(3).Select(call => call.Method));
            Assert.DoesNotContain(peer.Calls.Where(call => call.Bot == bot && call.Method == "setMyCommands").Single().Body["commands"]!.AsArray(), value => value!["command"]!.GetValue<string>() == "agent");
        }
        peer.Push("a", TelegramPeer.Text("-100", "999", "/whoami somebody-else"));
        await Until(() => peer.Sent("a").Any(call => (SessionWait.Text(call.Body["text"]) ?? "").Contains("User ID: 999")));
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        var raw = "  text\n\twith whitespace  ";
        peer.Push("a", TelegramPeer.Text("-100", "11", raw));
        peer.Push("b", TelegramPeer.Text("-100", "11", "second instance"));
        peer.Push("a", TelegramPeer.Text("-100", "11", "bot text ignored", true));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1 && second.Entry.Snapshot().Queue.Count == 1);
        Assert.Equal("alpha", f.Owner.Entry.Snapshot().Queue.Single().Source!.ChannelId);
        Assert.Equal("beta", second.Entry.Snapshot().Queue.Single().Source!.ChannelId);
        Assert.Contains("\n" + raw + "\n", SessionWait.Text(f.Owner.Entry.Snapshot().Queue.Single().Parts!.Single()["system"])!);
        peer.Push("a", TelegramPeer.Text("-100", "11", "/channel@owned_bot mode send-only"));
        await Until(() => SessionWait.Text(f.Manager.ChannelBinding("alpha:-100")?["mode"]) == "send-only");

        peer.Files["large-photo"] = Jpeg();
        var photo = TelegramPeer.Text("-100", "11", "");
        photo.Remove("text");
        photo["caption"] = "photo caption";
        photo["photo"] = new JsonArray(new JsonObject { ["file_id"] = "small-photo" }, new JsonObject { ["file_id"] = "large-photo", ["file_unique_id"] = "largest" });
        var botPhoto = (JsonObject)photo.DeepClone();
        botPhoto["from"]!["is_bot"] = true;
        botPhoto["photo"] = new JsonArray(new JsonObject { ["file_id"] = "bot-photo" });
        peer.Push("a", botPhoto);
        peer.Push("a", photo);
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 2);
        var media = f.Owner.Entry.Snapshot().Queue.Last();
        var imagePart = media.Parts!.Single(part => part["inlineDataRef"] is not null);
        Assert.Equal(peer.Files["large-photo"], await f.Manager.Images.ReadAsync(imagePart["inlineDataRef"]!.AsObject()));
        Assert.DoesNotContain(peer.Calls, call => call.Method == "getFile" && SessionWait.Text(call.Body["file_id"]) is "small-photo" or "bot-photo");
        Assert.Contains("photo caption", string.Join("", media.Parts!.Select(part => SessionWait.Text(part["text"]))));
        // Named instance media still uses Source's type-keyed eager helper, not the named attachment target.
        Assert.True(Directory.EnumerateFiles(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "telegram")).Any());
        var before = Directory.EnumerateFiles(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "telegram")).Count();
        peer.Files["unauthorized-doc"] = [1, 2, 3];
        var document = TelegramPeer.Text("-200", "999", "", true);
        document.Remove("text");
        document["document"] = new JsonObject { ["file_id"] = "unauthorized-doc", ["file_name"] = "data.bin", ["mime_type"] = "application/octet-stream" };
        peer.Push("a", document);
        await Until(() => peer.Sent("a").Any(call => (SessionWait.Text(call.Body["text"]) ?? "").Contains("Unauthorized")));
        Assert.Equal(before + 1, Directory.EnumerateFiles(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "telegram")).Count());
        Assert.Null(f.Manager.ChannelBinding("alpha:-200"));
        Assert.Equal(2, f.Owner.Entry.Snapshot().Queue.Count);
        await f.Manager.ManagedChannels.ChangeAsync("stop", "alpha");
        Assert.Contains(peer.Calls, call => call.Bot == "a" && call.Method == "getUpdates" && call.Body["limit"] is not null && SessionWait.Number(call.Body["offset"]) > 0);
    }

    [Fact]
    public async Task Own_bot_suffix_command_retains_the_existing_multiline_fork_initial_message()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("alpha:42", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        var initial = "first line\n  second line\nthird";
        peer.Push("a", TelegramPeer.Text("42", "11", "/fork@owned_bot child " + initial));
        await Until(() => peer.Sent("a").Any(call => (SessionWait.Text(call.Body["text"]) ?? "").Contains("newSessionId", StringComparison.Ordinal)));
        var reply = peer.Sent("a").Select(call => SessionWait.Text(call.Body["text"]) ?? "").Single(text => text.Contains("newSessionId", StringComparison.Ordinal));
        var id = SessionWait.Text(JsonNode.Parse(reply)!["newSessionId"])!;
        var child = await f.Manager.RequiredAsync(id);
        Assert.Equal(f.Owner.Id, child.Metadata().ParentSessionId);
        Assert.Contains(child.Entry.Snapshot().Queue.SelectMany(item => item.Parts ?? []), part => (SessionWait.Text(part["system"]) ?? SessionWait.Text(part["text"]) ?? "").Contains(initial, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Direct_unified_native_text_and_file_delivery_await_real_outcomes_with_Source_parse_fallback_and_retry_delays()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        var failures = 0;
        peer.Fail = call => call.Method == "sendMessage" && SessionWait.Text(call.Body["text"]) == "markdown" && call.Body["parse_mode"] is not null
            ? (400, "can't parse entities")
            : call.Method == "sendMessage" && SessionWait.Text(call.Body["text"]) == "retry" && Interlocked.Increment(ref failures) <= 3
                ? (503, "temporary") : null;
        JsonObject Args(string text) => new() { ["channelTargetId"] = "alpha:-100", ["message"] = text };
        Assert.Null((await f.ToolAsync("send_to_channel", Args("markdown")))!["error"]);
        var markdown = peer.Sent("a").Where(call => SessionWait.Text(call.Body["text"]) == "markdown").ToArray();
        Assert.Equal(2, markdown.Length);
        Assert.NotNull(markdown[0].Body["parse_mode"]);
        Assert.Null(markdown[1].Body["parse_mode"]);
        Assert.Null((await f.ToolAsync("call_tool", new JsonObject { ["toolId"] = "builtin:send_to_channel", ["args"] = Args("retry") }))!["error"]);
        Assert.Equal(4, peer.Sent("a").Count(call => SessionWait.Text(call.Body["text"]) == "retry"));
        Assert.Equal(new[] { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10) }, peer.Delays.ToArray());
        var native = await f.ToolAsync("run_script", new JsonObject { ["code"] = "return call_tool('builtin:send_to_channel', {'channelTargetId':'alpha:42','message':'native'})" });
        Assert.Equal("completed", SessionWait.Text(native!["status"]));
        Assert.Contains(peer.Sent("a"), call => SessionWait.Text(call.Body["text"]) == "native");
        Assert.Empty(f.Owner.History());
        Assert.Null(f.Manager.ChannelBinding("alpha:-100"));

        var image = Path.Combine(f.Work, "out.jpg");
        await File.WriteAllBytesAsync(image, Jpeg());
        peer.Fail = call => call.Method == "sendPhoto" && call.Body["parse_mode"] is not null ? (400, "can't parse entities") : null;
        Assert.Null((await f.ToolAsync("send_file", new JsonObject { ["channelTargetId"] = "alpha:42", ["filePath"] = image, ["caption"] = "caption" }))!["error"]);
        var photos = peer.Sent("a", "sendPhoto").ToArray();
        Assert.Equal(2, photos.Length);
        Assert.All(photos, call => { Assert.Equal("photo", SessionWait.Text(call.Body["uploadField"])); Assert.Equal("out.jpg", SessionWait.Text(call.Body["filename"])); Assert.Equal(awaitBytes(), call.Bytes); });
        byte[] awaitBytes() => File.ReadAllBytes(image);
        Assert.Null(photos[1].Body["parse_mode"]);
        var file = Path.Combine(f.Work, "data.txt");
        await File.WriteAllTextAsync(file, "attachment");
        Assert.Null((await f.ToolAsync("send_file", new JsonObject { ["channelTargetId"] = "alpha:42", ["filePath"] = file }))!["error"]);
        Assert.Equal("document", SessionWait.Text(peer.Sent("a", "sendDocument").Single().Body["uploadField"]));
        peer.Fail = call => call.Method == "sendMessage" ? (400, "payload rejected") : null;
        Assert.NotNull((await f.ToolAsync("send_to_channel", Args("failure")))!["error"]);
        Assert.Equal(2, peer.Sent("a").Count(call => SessionWait.Text(call.Body["text"]) == "failure"));
    }
}
