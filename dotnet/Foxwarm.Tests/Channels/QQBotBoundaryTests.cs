using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class QQBotBoundaryTests
{
    private static Task Until(Func<bool> condition) => TelegramChannelTests.Until(condition);
    [Fact]
    public async Task Coalesced_tokens_bounded_401_retry_sequence_and_structured_error_rules_follow_actual_requests()
    {
        await using var peer = await QQBotPeer.StartAsync();
        var tokens = 0;
        var tokenEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var tokenRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (call.Path == "/app/getAppAccessToken")
            {
                var count = Interlocked.Increment(ref tokens);
                if (count == 2) { tokenEntered.TrySetResult(); await tokenRelease.Task; }
                return Results.Json(new { access_token = "token-" + count, expires_in = 7200 });
            }
            if (call.Path.EndsWith("/messages"))
            {
                if (call.Headers["Authorization"] == "QQBot token-1") return Results.Json(new { code = 123 }, statusCode: 401);
                if (call.Body["content"]?.ToString() == "permission") return Results.Json(new { code = 40034105 }, statusCode: 400);
                if (call.Body["content"]?.ToString() == "unstructured") return Results.Json(new { code = 99999, message = "text mentions 40034005" }, statusCode: 400);
            }
            return null;
        };
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        await QQBotChannelTests.Start(f, peer);
        var transport = f.Manager.ChannelRegistry.Get("qq")!;
        var one = transport.Send("c2c:alice", "one", new(), default);
        await tokenEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var two = transport.Send("group:room", "two", new(), default);
        tokenRelease.TrySetResult();
        await Task.WhenAll(one, two);
        Assert.Equal(2, tokens);
        var first = peer.Sent.Where(call => call.Body["content"]?.ToString() == "one").ToArray();
        Assert.Equal(2, first.Length); Assert.Equal(first[0].Body["msg_seq"]!.ToString(), first[1].Body["msg_seq"]!.ToString());
        foreach (var text in new[] { "permission", "unstructured" })
        {
            await Assert.ThrowsAsync<QQBotApiException>(() => transport.Send("c2c:alice", text, new(), default));
            Assert.Single(peer.Sent, call => call.Body["content"]?.ToString() == text);
        }
    }
    [Theory]
    [InlineData("unsafe-url")]
    [InlineData("out-of-order")]
    [InlineData("oversized-response")]
    [InlineData("put-failure")]
    [InlineData("put-timeout")]
    [InlineData("generation")]
    public async Task Large_upload_stage_failure_has_no_cross_flow_retry_no_final_and_no_stale_success(string kind)
    {
        await using var peer = await QQBotPeer.StartAsync();
        peer.PartTimeout = TimeSpan.FromMilliseconds(75);
        var prepareEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releasePrepare = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (call.Path.EndsWith("/upload_prepare"))
            {
                if (kind == "oversized-response") return Results.Text(new string('x', 4 * 1024 * 1024 + 1));
                if (kind == "generation") { prepareEntered.TrySetResult(); await releasePrepare.Task; }
                return Results.Json(new JsonObject
                {
                    ["upload_id"] = "stage-upload", ["block_size"] = 5242880,
                    ["parts"] = new JsonArray(new JsonObject
                    {
                        ["index"] = kind == "out-of-order" ? 2 : 1,
                        ["presigned_url"] = kind == "unsafe-url" ? "http://cos.myqcloud.com/put" : "https://cos.myqcloud.com/put"
                    })
                });
            }
            if (call.Path == "/put")
            {
                if (kind == "put-timeout") await Task.Delay(250);
                if (kind == "put-failure") return Results.StatusCode(500);
            }
            return null;
        };
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        await QQBotChannelTests.Start(f, peer);
        var path = Path.Combine(f.Work, "large.bin");
        await using (var file = File.Create(path)) file.SetLength(QQBotUpload.DirectThreshold);
        var transport = f.Manager.ChannelRegistry.Get("qq")!;
        var sending = transport.SendFile!("c2c:alice", new(path, "large.bin", null, false), null, default);
        if (kind == "generation")
        {
            await prepareEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await f.Manager.ManagedChannels!.ChangeAsync("restart", "qq");
            releasePrepare.TrySetResult();
        }
        var error = await Record.ExceptionAsync(() => sending);
        Assert.True(error is IOException or OperationCanceledException, error?.ToString());
        Assert.Single(peer.Calls, call => call.Path.EndsWith("/upload_prepare"));
        Assert.DoesNotContain(peer.Calls, call => call.Path.EndsWith("/files") || call.Path.EndsWith("/upload_part_finish"));
        Assert.Empty(peer.Sent);
        if (kind is "unsafe-url" or "out-of-order" or "oversized-response" or "generation") Assert.DoesNotContain(peer.Calls, call => call.Method == "PUT");
        else Assert.Single(peer.Calls, call => call.Method == "PUT");
    }
    [Fact]
    public async Task Sparse_over_cap_empty_and_symlink_sources_fail_before_network_and_guild_DM_media_are_rejected()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        await QQBotChannelTests.Start(f, peer);
        var adapter = f.Manager.ChannelRegistry.Get("qq")!;
        var path = Path.Combine(f.Work, "huge.bin");
        await using (var file = File.Create(path)) file.SetLength(QQBotUpload.HardCap + 1);
        await Assert.ThrowsAsync<IOException>(() => adapter.SendFile!("group:room", new(path, "huge.bin", null, false), null, default));
        File.WriteAllBytes(path, []);
        await Assert.ThrowsAsync<IOException>(() => adapter.SendFile!("group:room", new(path, "empty.bin", null, false), null, default));
        var link = path + ".link";
        File.CreateSymbolicLink(link, path);
        await Assert.ThrowsAsync<IOException>(() => adapter.SendFile!("group:room", new(link, "link.bin", null, false), null, default));
        foreach (var target in new[] { "guild:channel", "dm:guild" })
            await Assert.ThrowsAsync<InvalidDataException>(() => adapter.SendFile!(target, new(path, "file.bin", null, false), null, default));
        Assert.DoesNotContain(peer.Calls, call => call.Method == "PUT" || call.Path.EndsWith("/files") || call.Path.EndsWith("/upload_prepare"));
    }
    [Fact]
    public async Task Native_unified_file_and_direct_text_keep_different_latest_context_selection_and_partial_effects()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await QQBotChannelTests.Start(f, peer);
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("latest", "input"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var path = Path.Combine(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory, "file.bin");
        await File.WriteAllTextAsync(path, "native fixture");
        var file = await f.ToolAsync("call_tool", new()
        {
            ["toolId"] = "builtin:send_file", ["args"] = new JsonObject { ["channelTargetId"] = "qq:group:room", ["filePath"] = path }
        });
        Assert.Null(file?["error"]); Assert.Equal("latest", peer.Sent.Last().Body["msg_id"]!.ToString());
        var text = await f.ToolAsync("send_to_channel", new() { ["channelTargetId"] = "qq:group:room", ["message"] = "proactive text" });
        Assert.Null(text?["error"]); Assert.Null(peer.Sent.Last().Body["msg_id"]);
        var native = await f.ToolAsync("run_script", new()
        {
            ["code"] = "return call_tool({'toolId': 'builtin:send_file'}, {'channelTargetId': 'qq:group:room', 'filePath': 'file.bin'})"
        });
        Assert.True(native?["error"] is null, native!.ToJsonString());
        Assert.Equal("latest", peer.Sent.Last().Body["msg_id"]!.ToString());
        peer.Respond = call => Task.FromResult<IResult?>(call.Path.EndsWith("/messages") ? Results.Json(new { code = 40034105 }, statusCode: 400) : null);
        var before = peer.Calls.Count(call => call.Path.EndsWith("/files"));
        var failure = await f.ToolAsync("send_file", new() { ["channelTargetId"] = "qq:group:room", ["filePath"] = path });
        Assert.NotNull(failure?["error"]);
        Assert.Equal(before + 1, peer.Calls.Count(call => call.Path.EndsWith("/files")));
        Assert.Equal(4, peer.Sent.Count());
    }
}
