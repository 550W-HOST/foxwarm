using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class QQBotMediaTests
{
    private static Task Until(Func<bool> condition) => TelegramChannelTests.Until(condition);
    private static IEnumerable<string> Files(ExternalChannelFixture f) => Directory.Exists(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files"))
        ? Directory.GetFiles(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files"), "*", SearchOption.AllDirectories) : [];
    private static string QueueText(ExternalChannelFixture f) => string.Join("\n", f.Owner.Entry.Snapshot().Queue.SelectMany(item => item.Parts ?? []).Select(part => SessionWait.Text(part["system"]) ?? SessionWait.Text(part["text"])));
    internal static byte[] Bmp(bool valid)
    {
        var data = new byte[58]; data[0] = (byte)'B'; data[1] = (byte)'M';
        void U32(int at, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(at, 4), value);
        void U16(int at, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(at, 2), value);
        U32(2, 58); U32(10, 54); U32(14, 40); U32(18, valid ? 1u : 1000u); U32(22, 1); U16(26, 1); U16(28, 24); U32(34, 4);
        return data;
    }
    [Fact]
    public async Task Byte_probes_direct_small_original_bytes_strict_BMP_and_generic_fallback_reach_actual_file_tools()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("qq:c2c:alice", f.Owner);
        await QQBotChannelTests.Start(f, peer);
        peer.Push("C2C_MESSAGE_CREATE", QQBotPeer.Message("passive", "file request"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var fixtures = new[]
        {
            ("generic.png", "not an image"u8.ToArray(), 4),
            ("renamed.bin", TelegramChannelTests.Jpeg(), 1),
            ("bmp.bin", Bmp(true), 1),
            ("truncated.bmp", Bmp(false), 4)
        };
        foreach (var (name, bytes, type) in fixtures)
        {
            await File.WriteAllBytesAsync(Path.Combine(f.Work, name), bytes);
            var result = await f.ToolAsync("send_file", new() { ["channelTargetId"] = "qq:c2c:alice", ["filePath"] = name, ["caption"] = "caption " + name });
            Assert.NotNull(result);
            var upload = peer.Calls.Last(call => call.Path.EndsWith("/files"));
            Assert.Equal(type.ToString(), upload.Body["file_type"]!.ToString());
            Assert.Equal(Convert.ToBase64String(bytes), SessionWait.Text(upload.Body["file_data"]));
            Assert.False(upload.Body["srv_send_msg"]!.GetValue<bool>());
            Assert.Equal(type == 4 ? name : null, SessionWait.Text(upload.Body["file_name"]));
            Assert.Equal("passive", SessionWait.Text(peer.Sent.Last().Body["msg_id"]));
        }
        Assert.DoesNotContain(peer.Calls, call => call.Method == "PUT");
        Assert.Empty(Files(f)); // delivery does not create inbound storage
    }
    [Theory]
    [InlineData(5242880)]
    [InlineData(10002433)]
    public async Task Exact_large_boundary_streams_ordered_parts_and_real_wire_hashes_without_upload_replay(int size)
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await QQBotChannelTests.Start(f, peer);
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("expired-media", "request"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        peer.Respond = call => Task.FromResult<IResult?>(call.Path.EndsWith("/messages") && SessionWait.Text(call.Body["msg_id"]) == "expired-media"
            ? Results.Json(new { code = 40034005 }, statusCode: 400) : null);
        var path = Path.Combine(f.Work, "large.bin");
        var bytes = new byte[size];
        for (var i = 0; i < bytes.Length; i++) bytes[i] = (byte)(i * 31 + i / 97);
        await File.WriteAllBytesAsync(path, bytes);
        await f.Manager.ChannelRegistry.Get("qq")!.SendFile!("group:room", new(path, "large.bin", null, false), "kept caption", default);
        var prepare = Assert.Single(peer.Calls, call => call.Path.EndsWith("/upload_prepare"));
        Assert.Equal(Convert.ToHexStringLower(MD5.HashData(bytes)), SessionWait.Text(prepare.Body["md5"]));
        Assert.Equal(Convert.ToHexStringLower(SHA1.HashData(bytes)), SessionWait.Text(prepare.Body["sha1"]));
        Assert.Equal(Convert.ToHexStringLower(MD5.HashData(bytes.AsSpan(0, Math.Min(size, 10_002_432)))), SessionWait.Text(prepare.Body["md5_10m"]));
        var puts = peer.Calls.Where(call => call.Method == "PUT").ToArray();
        Assert.Equal(bytes, puts.SelectMany(call => call.Bytes).ToArray());
        var finishes = peer.Calls.Where(call => call.Path.EndsWith("/upload_part_finish")).ToArray();
        Assert.Equal(puts.Length, finishes.Length);
        for (var i = 0; i < puts.Length; i++)
        {
            Assert.Equal((i + 1).ToString(), finishes[i].Body["part_index"]!.ToString());
            Assert.Equal(Convert.ToHexStringLower(MD5.HashData(puts[i].Bytes)), SessionWait.Text(finishes[i].Body["md5"]));
            Assert.DoesNotContain(puts[i].Headers.Keys, key => key.Equals("Authorization", StringComparison.OrdinalIgnoreCase) || key.Equals("Cookie", StringComparison.OrdinalIgnoreCase));
            var order = peer.Calls.ToArray(); Assert.True(Array.IndexOf(order, puts[i]) < Array.IndexOf(order, finishes[i]));
        }
        Assert.Single(peer.Calls, call => call.Path.EndsWith("/files"));
        var finals = peer.Sent.ToArray();
        Assert.Equal(2, finals.Length); Assert.Equal(finals[0].Body["msg_seq"]!.ToString(), finals[1].Body["msg_seq"]!.ToString());
        Assert.Equal(finals[0].Body["media"]!.ToJsonString(), finals[1].Body["media"]!.ToJsonString());
        Assert.Null(finals[1].Body["msg_id"]);
    }
    [Fact]
    public async Task Inbound_raster_is_canonical_before_queue_voice_WAV_uses_safe_fallback_and_generic_large_path_is_atomic()
    {
        await using var peer = await QQBotPeer.StartAsync();
        peer.Assets["/image"] = TelegramChannelTests.Jpeg();
        peer.Assets["/voice"] = "voice bytes"u8.ToArray();
        peer.Assets["/large"] = new byte[21 * 1024 * 1024];
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await QQBotChannelTests.Start(f, peer);
        var media = new JsonArray
        {
            QQBotPeer.Attachment("/image", "image/jpeg")[0]!.DeepClone(),
            new JsonObject { ["filename"] = "voice.wav", ["content_type"] = "voice", ["url"] = "https://qq.com/voice", ["voice_wav_url"] = "https://evil.invalid/wav", ["asr_refer_text"] = "bounded voice reference" },
            QQBotPeer.Attachment("/large", "image/png")[0]!.DeepClone()
        };
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("media", "media-input", attachments: media));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var parts = f.Owner.Entry.Snapshot().Queue.Single().Parts!;
        Assert.Contains(parts, part => part["inlineDataRef"] is not null);
        Assert.DoesNotContain(parts, part => part["inlineData"] is not null);
        Assert.Equal(3, Files(f).Count());
        Assert.Contains("voice reference", QueueText(f)); Assert.Contains("generic file", QueueText(f));
        Assert.DoesNotContain("qpic.cn", QueueText(f));
        Assert.Equal(peer.Assets["/image"], await File.ReadAllBytesAsync(Files(f).Single(file => new FileInfo(file).Length == peer.Assets["/image"].Length)));
        Assert.All(peer.Calls.Where(call => call.Path is "/image" or "/voice" or "/large"), call =>
            Assert.DoesNotContain(call.Headers.Keys, key => key.Equals("Authorization", StringComparison.OrdinalIgnoreCase) || key.Equals("Cookie", StringComparison.OrdinalIgnoreCase)));
        Assert.DoesNotContain(Files(f), file => Path.GetFileName(file).StartsWith(".foxwarm-write-"));
    }
    [Fact]
    public async Task Media_redirect_bounds_count_timeout_and_storage_errors_are_controlled_and_spools_cleaned()
    {
        await using var peer = await QQBotPeer.StartAsync();
        peer.MediaTimeout = TimeSpan.FromMilliseconds(80);
        peer.Assets["/ok"] = "1234"u8.ToArray();
        peer.Assets["/oversized"] = "12345"u8.ToArray();
        peer.Respond = async call =>
        {
            if (call.Path == "/redirect") return Results.Redirect("https://127.0.0.1/private");
            if (call.Path == "/slow") { await Task.Delay(250); return Results.Bytes([1]); }
            return null;
        };
        var config = peer.Config();
        config["media"] = new JsonObject { ["fileMaxBytes"] = 4, ["maxTotalBytes"] = 8, ["maxAttachments"] = 5 };
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = config }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await QQBotChannelTests.Start(f, peer);
        var before = Directory.GetDirectories(Path.GetTempPath(), "foxwarm-qqbot-media-*").Order().ToArray();
        var attachments = new JsonArray("malformed", QQBotPeer.Attachment("/redirect")[0]!.DeepClone(),
            QQBotPeer.Attachment("/oversized")[0]!.DeepClone(), QQBotPeer.Attachment("/slow")[0]!.DeepClone(),
            QQBotPeer.Attachment("/ok")[0]!.DeepClone(), QQBotPeer.Attachment("/omitted")[0]!.DeepClone());
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("bounds", "test-bounds", attachments: attachments));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var text = QueueText(f);
        Assert.Contains("malformed attachment", text); Assert.Contains("invalid", text);
        Assert.Contains("configured size limit", text); Assert.Contains("timed out", text);
        Assert.Contains("additional attachments omitted", text);
        Assert.Single(Files(f));
        Assert.DoesNotContain(peer.Calls, call => call.Path is "/private" or "/omitted");
        Assert.Equal(before, Directory.GetDirectories(Path.GetTempPath(), "foxwarm-qqbot-media-*").Order().ToArray());
        Assert.DoesNotContain("foxwarm-qqbot-media-", text);
        // A final destination directory where the file owner needs a file is an ordinary storage failure.
        var directory = Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "qqbot");
        Directory.Delete(directory, true); await File.WriteAllTextAsync(directory, "blocks destination directory");
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("storage", "storage-test", attachments: QQBotPeer.Attachment("/ok")));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 2);
        Assert.Contains("media storage failed", QueueText(f));
        Assert.DoesNotContain("blocks destination", QueueText(f));
    }
    [Theory]
    [InlineData("http://qpic.cn/a")]
    [InlineData("https://qpic.cn:444/a")]
    [InlineData("https://u:p@qpic.cn/a")]
    [InlineData("https://qpic.cn.evil.invalid/a")]
    public async Task Unsafe_asset_urls_fail_before_fetch(string url)
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("qq:group:room", f.Owner); await QQBotChannelTests.Start(f, peer);
        var attachments = QQBotPeer.Attachment(); attachments[0]!["url"] = url;
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("unsafe", "unsafe", attachments: attachments));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        Assert.Contains("invalid", QueueText(f)); Assert.Empty(Files(f));
        Assert.DoesNotContain(peer.Calls, call => call.Path == "/a" || call.Path == "/asset");
    }
}
