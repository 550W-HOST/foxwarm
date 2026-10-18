using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WeWorkDeliveryTests
{
    private static string Cmd(JsonObject frame) => frame["cmd"]!.GetValue<string>();
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    [Fact]
    public async Task Latest_response_url_is_taken_before_await_explicit_override_and_proactive_do_not_consume_it_and_failure_never_cross_routes()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = peer.Config(port, stream: false, socket: true) }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe"));
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var first = WeWorkPeer.Text("response-1"); first["response_url"] = new Uri(peer.Address, "response-1").ToString();
        await WeWorkCallbackTests.Post(client, first);
        var transport = f.Manager.ChannelRegistry.Get("work")!;
        await transport.Send("wrk-chat", "proactive", new(), default);
        Assert.Equal("aibot_send_msg", Cmd(peer.Frames.Last()));
        var entered = Signal(); var release = Signal();
        peer.Respond = async call =>
        {
            if (call.Path == "/response-1") { entered.TrySetResult(); await release.Task; }
            return null;
        };
        var sending = transport.Send("wrk-chat", "first terminal", new(true), default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = WeWorkPeer.Text("response-2"); second["response_url"] = new Uri(peer.Address, "response-2").ToString();
        await WeWorkCallbackTests.Post(client, second);
        await transport.Send("wrk-chat", "explicit override", new(true, WebhookUrl: peer.Webhook), default);
        release.TrySetResult(); await sending;
        await transport.Send("wrk-chat", "second terminal", new(true), default);
        Assert.Equal(new[] { "/response-1", "/webhook", "/response-2" }, peer.Calls.Select(call => call.Path));
        var third = WeWorkPeer.Text("response-3"); third["response_url"] = new Uri(peer.Address, "response-3").ToString();
        await WeWorkCallbackTests.Post(client, third);
        peer.Respond = call => Task.FromResult<IResult?>(call.Path == "/response-3" ? Results.Json(new { errcode = 42, errmsg = "failed terminal" }) : null);
        Assert.Contains("failed terminal", (await Assert.ThrowsAsync<IOException>(() => transport.Send("wrk-chat", "failed", new(true), default))).Message);
        Assert.Equal(4, peer.Calls.Count);
        await transport.Send("wrk-chat", "after failure", new(true), default);
        Assert.Equal(4, peer.Calls.Count);
        Assert.Equal("after failure", peer.Frames.Last()["body"]!["markdown"]!["content"]!.GetValue<string>());
    }

    [Fact]
    public async Task WS_media_chunks_hash_fields_order_same_route_caption_and_direct_unified_file_tools_use_the_existing_owner()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = peer.Config(socket: true) }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe"));
        var bytes = Enumerable.Range(0, 512 * 1024 + 17).Select(index => (byte)(index % 251)).ToArray();
        var path = Path.Combine(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory, "report.bin");
        await File.WriteAllBytesAsync(path, bytes);
        var result = await f.ToolAsync("send_file", new() { ["channelTargetId"] = "work:target", ["filePath"] = path, ["caption"] = "caption" });
        Assert.Null(result?["error"]);
        var commands = peer.Frames.Where(frame => Cmd(frame) != "aibot_subscribe").ToArray();
        Assert.Equal(new[] { "aibot_upload_media_init", "aibot_upload_media_chunk", "aibot_upload_media_chunk", "aibot_upload_media_finish", "aibot_send_msg", "aibot_send_msg" }, commands.Select(Cmd));
        Assert.Equal(bytes.Length, commands[0]["body"]!["total_size"]!.GetValue<int>());
        Assert.Equal(2, commands[0]["body"]!["total_chunks"]!.GetValue<int>());
        Assert.Equal(Convert.ToHexStringLower(MD5.HashData(bytes)), commands[0]["body"]!["md5"]!.GetValue<string>());
        var chunks = commands.Where(frame => Cmd(frame) == "aibot_upload_media_chunk").ToArray();
        Assert.Equal(new[] { 0, 1 }, chunks.Select(frame => frame["body"]!["chunk_index"]!.GetValue<int>()));
        Assert.Equal(bytes, chunks.SelectMany(frame => Convert.FromBase64String(frame["body"]!["base64_data"]!.GetValue<string>())).ToArray());
        Assert.Equal("caption", commands[4]["body"]!["markdown"]!["content"]!.GetValue<string>());
        Assert.Equal("file", commands[5]["body"]!["msgtype"]!.GetValue<string>());
        Assert.All(commands.Skip(4), frame => Assert.Equal("target", frame["body"]!["chatid"]!.GetValue<string>()));
        var imagePath = Path.Combine(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory, "photo.jpg");
        await File.WriteAllBytesAsync(imagePath, TelegramChannelTests.Jpeg());
        var unified = await f.ToolAsync("call_tool", new() { ["toolId"] = "builtin:send_file", ["args"] = new JsonObject { ["channelTargetId"] = "work:image-target", ["filePath"] = imagePath } });
        Assert.Null(unified?["error"]);
        Assert.Equal("image", peer.Frames.Last()["body"]!["msgtype"]!.GetValue<string>());
        var text = await f.ToolAsync("send_to_channel", new() { ["channelTargetId"] = "work:text-target", ["message"] = "explicit text" });
        Assert.Null(text?["error"]);
        Assert.Equal("markdown", peer.Frames.Last()["body"]!["msgtype"]!.GetValue<string>());
        Assert.Empty(peer.Calls);
        Assert.Empty(f.Owner.History());
    }

    [Theory]
    [InlineData("init")]
    [InlineData("chunk")]
    [InlineData("finish")]
    [InlineData("caption")]
    [InlineData("send")]
    [InlineData("missing-upload")]
    [InlineData("missing-media")]
    [InlineData("close")]
    public async Task Selected_WS_partial_effect_failure_does_not_continue_retry_or_use_webhook(string stage)
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = peer.Config(socket: true) }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe"));
        var path = Path.Combine(f.Work, "file.bin"); await File.WriteAllTextAsync(path, "contents");
        peer.Ack = frame =>
        {
            var cmd = Cmd(frame);
            var target = stage switch
            {
                "init" or "missing-upload" => "aibot_upload_media_init",
                "chunk" or "close" => "aibot_upload_media_chunk",
                "finish" or "missing-media" => "aibot_upload_media_finish",
                _ => "aibot_send_msg",
            };
            if (cmd != target) return Task.FromResult<JsonObject?>(new());
            if (stage == "send" && frame["body"]!["msgtype"]!.GetValue<string>() == "markdown") return Task.FromResult<JsonObject?>(new());
            return Task.FromResult<JsonObject?>(stage == "close" ? new() { ["close"] = true }
                : stage.StartsWith("missing-", StringComparison.Ordinal) ? new() { ["body"] = new JsonObject() }
                : new() { ["errcode"] = 41001, ["errmsg"] = "controlled " + stage });
        };
        var error = await Assert.ThrowsAsync<IOException>(() => f.Manager.ChannelRegistry.Get("work")!.SendFile!("target", new(path, "file.bin", "application/octet-stream", false), "caption", default));
        Assert.NotEmpty(error.Message);
        var commands = peer.Frames.Where(frame => Cmd(frame) != "aibot_subscribe").ToArray();
        var expected = stage switch { "init" or "missing-upload" => 1, "chunk" or "close" => 2, "finish" or "missing-media" => 3, "caption" => 4, _ => 5 };
        Assert.Equal(expected, commands.Length);
        Assert.Empty(peer.Calls);
    }

    [Fact]
    public async Task Protocol_cap_zero_length_legacy_image_MD5_multipart_caption_override_and_conditional_retries_match_Source()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(dependencies: peer.Dependencies);
        await using var direct = new WeWorkChannel("work", peer.Config(socket: true), f.Manager, f.Router, peer.Dependencies, _ => { });
        await direct.StartAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe"));
        var path = Path.Combine(f.Work, "file.bin");
        await using (var stream = File.Create(path)) stream.SetLength(52428801);
        Assert.Contains("52428800-byte protocol limit", (await Assert.ThrowsAsync<IOException>(() => direct.SendFileAsync("chat", new(path, "large.bin", null, false), null, new(), default))).Message);
        Assert.Single(peer.Frames);
        Assert.Contains("requires a regular file", (await Assert.ThrowsAsync<IOException>(() => direct.SendFileAsync("chat", new(f.Work, "directory", null, false), null, new(), default))).Message);
        Assert.Single(peer.Frames);
        await File.WriteAllBytesAsync(path, []);
        await direct.SendFileAsync("chat", new(path, "empty.bin", "application/octet-stream", false), null, new(), default);
        var chunk = peer.Frames.Single(frame => Cmd(frame) == "aibot_upload_media_chunk");
        Assert.Equal("", chunk["body"]!["base64_data"]!.GetValue<string>());
        await File.WriteAllTextAsync(path, "image-bytes");
        await direct.SendFileAsync("wrk-legacy", new(path, "photo.jpg", "image/jpeg", true), "legacy caption", new(WebhookUrl: peer.Webhook), default);
        var sent = peer.Calls.ToArray();
        Assert.Equal(2, sent.Length);
        Assert.Equal("text", sent[0].Body["msgtype"]!.GetValue<string>());
        Assert.Equal("wrk-legacy", sent[1].Body["chatid"]!.GetValue<string>());
        Assert.Equal(Convert.ToHexStringLower(MD5.HashData(Encoding.UTF8.GetBytes("image-bytes"))), sent[1].Body["image"]!["md5"]!.GetValue<string>());
        await direct.SendFileAsync("chat", new(path, "report.bin", "application/octet-stream", false), null, new(WebhookUrl: peer.Webhook), default);
        Assert.Contains("filename=\"report.bin\"", Encoding.UTF8.GetString(peer.Calls.ToArray()[2].Bytes));
        Assert.Equal("legacy-media", peer.Calls.Last().Body["file"]!["media_id"]!.GetValue<string>());
        var attempts = 0;
        peer.Respond = call => Task.FromResult<IResult?>(call.Path == "/retry" && Interlocked.Increment(ref attempts) < 3 ? Results.StatusCode(503) : null);
        await direct.SendTextAsync("chat", "retry", new(WebhookUrl: new Uri(peer.Address, "retry").ToString()), default);
        Assert.Equal(3, attempts);
        attempts = 0;
        peer.Respond = call => Task.FromResult<IResult?>(call.Path == "/client-error" ? Results.StatusCode(400) : null);
        await Assert.ThrowsAsync<IOException>(() => direct.SendTextAsync("chat", "client", new(WebhookUrl: new Uri(peer.Address, "client-error").ToString()), default));
        Assert.Single(peer.Calls, call => call.Path == "/client-error");
        // A legacy API errcode has no HTTP status in Source and is retried, unlike response_url.
        peer.Respond = call => Task.FromResult<IResult?>(call.Path == "/api-error" && Interlocked.Increment(ref attempts) < 3 ? Results.Json(new { errcode = 1, errmsg = "retry API" }) : null);
        await direct.SendTextAsync("chat", "api", new(WebhookUrl: new Uri(peer.Address, "api-error").ToString()), default);
        Assert.Equal(3, attempts);
    }
}
