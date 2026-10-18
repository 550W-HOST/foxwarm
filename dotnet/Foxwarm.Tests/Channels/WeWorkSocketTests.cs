using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WeWorkSocketTests
{
    private static string Cmd(JsonObject frame) => frame["cmd"]!.GetValue<string>();
    private static string Req(JsonObject frame) => frame["headers"]!["req_id"]!.GetValue<string>();
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    [Fact]
    public async Task Real_fragmented_unicode_callbacks_subscribe_heartbeat_same_req_id_serialization_ACK_errors_timeout_close_and_reconnect()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var config = peer.Config(socket: true);
        config["aibot"]!["websocket"]!["heartbeatMs"] = 100;
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = config }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe"));
        var subscribe = peer.Frames.Single(frame => Cmd(frame) == "aibot_subscribe");
        Assert.Equal("fixture-bot", subscribe["body"]!["bot_id"]!.GetValue<string>());
        Assert.Equal("fixture-secret", subscribe["body"]!["secret"]!.GetValue<string>());
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "ping"));
        var held = Signal();
        var firstAck = Signal();
        peer.Ack = async frame =>
        {
            if (Cmd(frame) == "aibot_respond_msg" && !firstAck.Task.IsCompleted)
            {
                firstAck.TrySetResult();
                await held.Task;
            }
            return new();
        };
        peer.Push(WeWorkPeer.Text("unicode", "你好 🦊 fragment"), "same-req");
        await firstAck.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await TelegramChannelTests.Until(() => f.Manager.ChannelBinding("work:wrk-chat") is not null);
        var bound = await f.Manager.GetExistingAsync(SessionWait.Text(f.Manager.ChannelBinding("work:wrk-chat")!["sessionId"])!, default);
        await TelegramChannelTests.Until(() => bound!.Entry.WithState(state => state.Queue.Count) == 1);
        Assert.Contains("你好 🦊 fragment", string.Join("", bound!.Entry.WithState(state => state.Queue[0].Parts!).Select(part => SessionWait.Text(part["text"] ?? part["system"]))));
        var transport = f.Manager.ChannelRegistry.Get("work")!;
        var update = transport.Send("wrk-chat", "native update", new(), default);
        await transport.Send("other-chat", "independent command", new(), default).WaitAsync(TimeSpan.FromSeconds(3));
        Assert.False(update.IsCompleted);
        Assert.Single(peer.Frames, frame => Cmd(frame) == "aibot_respond_msg");
        held.TrySetResult();
        await update.WaitAsync(TimeSpan.FromSeconds(3));
        var streamFrames = peer.Frames.Where(frame => Cmd(frame) == "aibot_respond_msg").ToArray();
        Assert.Equal(2, streamFrames.Length);
        Assert.All(streamFrames, frame => Assert.Equal("same-req", Req(frame)));
        peer.Ack = frame => Task.FromResult<JsonObject?>(Cmd(frame) == "aibot_send_msg" ? new() { ["errcode"] = 41002, ["errmsg"] = "controlled refusal" } : new());
        var error = await Assert.ThrowsAsync<IOException>(() => transport.Send("other-chat", "bad", new(), default));
        Assert.Contains("controlled refusal", error.Message);
        Assert.Contains("41002", error.Message);
        Assert.Empty(peer.Calls);
        peer.Ack = frame => Task.FromResult<JsonObject?>(Cmd(frame) == "aibot_send_msg" ? null : new());
        var timed = await Assert.ThrowsAsync<IOException>(() => transport.Send("other-chat", "timeout", new(), default));
        Assert.Contains("timed out waiting for ack", timed.Message);
        Assert.Empty(peer.Calls);
        peer.Ack = frame => Task.FromResult<JsonObject?>(Cmd(frame) == "aibot_send_msg" ? new() { ["close"] = true } : new());
        var closed = await Assert.ThrowsAsync<IOException>(() => transport.Send("other-chat", "closed", new(), default));
        Assert.Contains("WebSocket closed", closed.Message);
        await TelegramChannelTests.Until(() => peer.Frames.Count(frame => Cmd(frame) == "aibot_subscribe") >= 2);
        peer.Ack = _ => Task.FromResult<JsonObject?>(new());
        peer.Event("disconnected_event");
        await TelegramChannelTests.Until(() => peer.Frames.Count(frame => Cmd(frame) == "aibot_subscribe") >= 3);
        peer.Ack = frame => Task.FromResult<JsonObject?>(Cmd(frame) == "aibot_send_msg" ? null : new());
        var pending = transport.Send("other-chat", "stop-pending", new(), default);
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => frame["body"]?["markdown"]?["content"]?.GetValue<string>() == "stop-pending"));
        await f.Manager.ManagedChannels.ChangeAsync("stop", "work").WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Contains("stopped", (await Assert.ThrowsAsync<IOException>(() => pending)).Message);
        Assert.Null(f.Manager.ChannelRegistry.Get("work"));
        Assert.Empty(peer.Calls);
    }

    [Fact]
    public async Task WebSocket_latest_cards_supersede_cleanly_and_request_reply_stream_beats_explicit_webhook_while_direct_override_bypasses_card()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["work"] = peer.Config(socket: true) }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe"));
        peer.Push(WeWorkPeer.Text("old"), "req-old");
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Cmd(frame) == "aibot_respond_msg"));
        var channel = f.Manager.ChannelRegistry.Get("work")!;
        await channel.Send("wrk-chat", "substantive", new(), default);
        await channel.Progress!("wrk-chat", new("tool-calls-start", [new("r", "read")]), default);
        peer.Push(WeWorkPeer.Text("new"), "req-new");
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Req(frame) == "req-new"));
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Req(frame) == "req-old" && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true));
        var oldFinal = peer.Frames.Last(frame => Req(frame) == "req-old");
        Assert.Equal("substantive", WeWorkCallbackTests.Content(oldFinal["body"]!.AsObject()));
        peer.Push(WeWorkPeer.Text("command", "@企业机器人 /whoami"), "req-command");
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Req(frame) == "req-command" && (frame["body"]?["stream"]?["content"]?.GetValue<string>() ?? "").Contains("alice", StringComparison.Ordinal)));
        // Reuse only the adapter already registered by managed ownership for direct option qualification.
        await f.Manager.ManagedChannels.ChangeAsync("stop", "work");
        await using var direct = new WeWorkChannel("direct", peer.Config(socket: true), f.Manager, f.Router, peer.Dependencies, _ => { });
        await direct.StartAsync();
        await TelegramChannelTests.Until(() => peer.Frames.Count(frame => Cmd(frame) == "aibot_subscribe") >= 2);
        await direct.SendTextAsync("wrk-explicit", "override", new(WebhookUrl: peer.Webhook, MessageType: "text"), default);
        Assert.Single(peer.Calls);
        Assert.Equal("text", peer.Calls.Single().Body["msgtype"]!.GetValue<string>());
    }
}
