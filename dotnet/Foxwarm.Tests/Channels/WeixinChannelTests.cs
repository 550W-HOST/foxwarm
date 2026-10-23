using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WeixinChannelTests
{
    [Theory]
    [InlineData(
        "{\"item_list\":[{\"type\":1,\"text_item\":{\"text\":\"first\"}},{\"type\":1,\"text_item\":{\"text\":\"second\"}}]}",
        "first"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":3,\"voice_item\":{\"text\":\"voice words\"}},{\"type\":1,\"text_item\":{\"text\":\"later\"}}]}",
        "voice words"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":1,\"text_item\":{\"text\":\"reply\"},\"ref_msg\":{\"title\":\"title\",\"message_item\":{\"type\":1,\"text_item\":{\"text\":\"quoted\"}}}}]}",
        "[引用: title | quoted]\nreply"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":1,\"text_item\":{\"text\":\"reply\"},\"ref_msg\":{\"title\":\"ignored\",\"message_item\":{\"type\":2}}}]}",
        "reply"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":1,\"text_item\":{\"text\":\"\"}},{\"type\":1,\"text_item\":{\"text\":\"not selected\"}}]}",
        "[Weixin unsupported message received.]"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":2}]}",
        "[Weixin image message received. Media handling is not supported in this MVP yet.]"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":5}]}",
        "[Weixin video message received. Media handling is not supported in this MVP yet.]"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":4}]}",
        "[Weixin file message received. File handling is not supported in this MVP yet.]"
    )]
    [InlineData(
        "{\"item_list\":[{\"type\":3}]}",
        "[Weixin voice message received. Voice handling is not supported in this MVP yet.]"
    )]
    [InlineData("{}", "[Weixin unsupported message received.]")]
    public void Actual_inbound_text_voice_quote_and_placeholder_rules(string json, string text) =>
        Assert.Equal(
            text,
            SessionWait.Text(WeixinInbound.Parts(JsonNode.Parse(json)!.AsObject()).Single()["text"])
        );

    [Fact]
    public async Task Real_polling_preserves_envelopes_context_before_auth_shared_per_user_reload_unicode_and_honest_missing_context()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var channels = new JsonObject
        {
            ["alpha"] = peer.Weixin(),
            ["beta"] = peer.Weixin("weixin-b"),
        };
        await using var f = await ExternalChannelFixture.CreateAsync(
            channels,
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:alice", f.Owner);
        var beta = await f.Manager.CreateNamedAsync("main", "beta", null, null);
        f.Manager.AttachChannel("beta:bob", beta);
        await f.Manager.ManagedChannels!.ReloadAsync();
        peer.WeixinMessages(
            "weixin-a",
            ExternalProtocolPeer.WeixinText("alice", "  中文 🦊\n kept  ", "shared-token"),
            ExternalProtocolPeer.WeixinText("stranger", "/whoami another", "cached-before-auth")
        );
        peer.WeixinMessages(
            "weixin-b",
            ExternalProtocolPeer.WeixinText("bob", "other instance", "bob-context")
        );
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.Snapshot().Queue.Count == 1
            && beta.Entry.Snapshot().Queue.Count == 1
            && peer.Sent("weixin-a").Length > 0
        );
        var item = f.Owner.Entry.Snapshot().Queue.Single();
        Assert.Equal("alice", item.Source!.SenderId);
        Assert.Equal("alpha", item.Source.ChannelId);
        Assert.Contains("  中文 🦊\n kept  ", item.Parts!.Single()["system"]!.GetValue<string>());
        Assert.Null(f.Manager.ChannelBinding("alpha:stranger"));
        Assert.Equal("cached-before-auth", f.Manager.ManagedChannels.Weixin.Context("stranger"));
        Assert.Null(
            (
                await f.ToolAsync(
                    "send_to_channel",
                    new JsonObject { ["channelTargetId"] = "beta:alice", ["message"] = "跨实例 🦊" }
                )
            )!["error"]
        );
        var sent = peer.Sent("weixin-b").Last();
        Assert.Equal("shared-token", SessionWait.Text(sent.Body["msg"]!["context_token"]));
        Assert.Equal("alice", SessionWait.Text(sent.Body["msg"]!["to_user_id"]));
        Assert.Equal(2, SessionWait.Number(sent.Body["msg"]!["message_type"]));
        Assert.Equal(2, SessionWait.Number(sent.Body["msg"]!["message_state"]));
        Assert.Equal("", SessionWait.Text(sent.Body["msg"]!["from_user_id"]));
        Assert.Matches(
            "^foxwarm-weixin-[a-f0-9]{16}$",
            SessionWait.Text(sent.Body["msg"]!["client_id"])!
        );
        Assert.Equal(
            "跨实例 🦊",
            SessionWait.Text(sent.Body["msg"]!["item_list"]![0]!["text_item"]!["text"])
        );
        Assert.Contains("跨实例", Encoding.UTF8.GetString(sent.Bytes));
        foreach (
            var call in peer.Calls.Where(call =>
                call.Path.Contains("/ilink/bot/", StringComparison.Ordinal) && call.Method == "POST"
            )
        )
        {
            Assert.Equal("ilink_bot_token", call.Headers["AuthorizationType"]);
            Assert.Equal("synthetic-route", call.Headers["SKRouteTag"]);
            Assert.Equal(call.Bytes.Length.ToString(), call.Headers["Content-Length"]);
            Assert.Equal("application/json", call.Headers["Content-Type"]);
            Assert.True(
                uint.TryParse(
                    Encoding.UTF8.GetString(Convert.FromBase64String(call.Headers["X-WECHAT-UIN"])),
                    out _
                )
            );
            Assert.Equal(
                ProductVersion.Value,
                SessionWait.Text(call.Body["base_info"]!["channel_version"])
            );
        }
        Assert.Contains(
            peer.Calls,
            call =>
                call.Key == "weixin-a"
                && call.Path.EndsWith("/getupdates", StringComparison.Ordinal)
                && SessionWait
                    .Text(call.Body["get_updates_buf"])
                    ?.StartsWith("cursor-", StringComparison.Ordinal) == true
        );
        await f.Configuration.SaveAppAsync(
            new JsonObject { ["channels"] = channels.DeepClone() }.ToJsonString()
        );
        Assert.Equal("shared-token", f.Manager.ManagedChannels.Weixin.Context("alice"));
        await f.Manager.ChannelRegistry.SendAsync("alpha:alice", "after reload", default);
        Assert.Equal(
            "shared-token",
            SessionWait.Text(peer.Sent("weixin-a").Last().Body["msg"]!["context_token"])
        );
        Assert.NotNull(
            (
                await f.ToolAsync(
                    "send_to_channel",
                    new JsonObject
                    {
                        ["channelTargetId"] = "alpha:missing",
                        ["message"] = "cannot reply",
                    }
                )
            )!["error"]
        );
        Assert.Null(new WeixinApi(null).Context("alice"));
        await f.Manager.ChannelRegistry.Get("alpha")!.Typing!("alice", default);
        Assert.DoesNotContain(
            peer.Calls,
            call => call.Path.EndsWith("/sendtyping", StringComparison.Ordinal)
        );
        Assert.Null(f.Manager.ChannelRegistry.Get("alpha")!.SendFile);
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.EndsWith("/sendmessage", StringComparison.Ordinal)
                    ? Results.Text("not JSON, but accepted HTTP")
                    : null
            );
        await f.Manager.ChannelRegistry.SendAsync("alpha:alice", "HTTP-only success", default);
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.EndsWith("/sendmessage", StringComparison.Ordinal)
                    ? Results.Text("controlled failure", statusCode: 403)
                    : null
            );
        Assert.NotNull(
            (
                await f.ToolAsync(
                    "send_to_channel",
                    new JsonObject { ["channelTargetId"] = "alpha:alice", ["message"] = "failed" }
                )
            )!["error"]
        );
        Assert.DoesNotContain("shared-token", await File.ReadAllTextAsync(f.Configuration.AppPath));
    }

    [Fact]
    public async Task Expiry_is_caught_backoff_resets_and_stop_waits_for_existing_fetch_without_cancelling_it()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var channel = peer.Weixin();
        channel["longPollTimeoutMs"] = 3000;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = channel },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:alice", f.Owner);
        peer.Push("weixin-a", new JsonObject { ["ret"] = -14 });
        peer.Push("weixin-a", new JsonObject { ["errcode"] = 5 });
        peer.Push("weixin-a", new JsonObject { ["ret"] = 1 });
        peer.WeixinMessages("weixin-a", ExternalProtocolPeer.WeixinText("alice", "recovered"));
        var fetching = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (
                !call.Path.EndsWith("/getupdates", StringComparison.Ordinal)
                || SessionWait
                    .Text(call.Body["get_updates_buf"])
                    ?.StartsWith("cursor-", StringComparison.Ordinal) != true
            )
                return null;
            fetching.TrySetResult();
            await release.Task;
            return Results.Json(new { ret = 0, msgs = Array.Empty<object>() });
        };
        try
        {
            await f.Manager.ManagedChannels!.ReloadAsync();
            await fetching.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Single(f.Owner.Entry.Snapshot().Queue);
            Assert.Equal(
                new[] { 2000d, 2000d, 30000d },
                peer.Delays.Select(value => value.TotalMilliseconds)
            );
            var count = peer.Calls.Count(call =>
                call.Path.EndsWith("/getupdates", StringComparison.Ordinal)
            );
            var stopping = f.Manager.ManagedChannels.ChangeAsync("stop", "alpha");
            await Task.Delay(100);
            Assert.False(stopping.IsCompleted);
            Assert.Equal(
                count,
                peer.Calls.Count(call =>
                    call.Path.EndsWith("/getupdates", StringComparison.Ordinal)
                )
            );
            release.TrySetResult();
            await stopping.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Null(f.Manager.ChannelRegistry.Get("alpha"));
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Actual_timeout_preserves_cursor_and_optional_auth_and_empty_sends_match_the_API()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var api = new WeixinApi(null);
        var response = await api.UpdatesAsync(
            peer.Address.ToString(),
            null,
            " route ",
            "prior",
            1000
        );
        Assert.Equal("prior", SessionWait.Text(response["get_updates_buf"]));
        Assert.Empty(response["msgs"]!.AsArray());
        var poll = peer.Calls.Single();
        Assert.Equal("", poll.Key);
        Assert.Equal("route", poll.Headers["SKRouteTag"]);
        api.CacheContext("alice", "context");
        await api.SendAsync(peer.Address.ToString(), null, null, "alice", "");
        Assert.Null(peer.Sent("").Single().Body["msg"]!["item_list"]);
    }
}
