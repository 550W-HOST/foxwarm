using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WeWorkSocketTests
{
    private static string Cmd(JsonObject frame) => frame["cmd"]!.GetValue<string>();

    private static string Req(JsonObject frame) => frame["headers"]!["req_id"]!.GetValue<string>();

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    [Fact]
    public async Task Real_fragmented_unicode_callbacks_subscribe_heartbeat_same_req_id_serialization_ACK_errors_timeout_close_and_reconnect()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var config = peer.Config(socket: true);
        config["aibot"]!["websocket"]!["heartbeatMs"] = 100;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = config },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );
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
        await TelegramChannelTests.Until(() =>
            f.Manager.ChannelBinding("work:wrk-chat") is not null
        );
        var bound = await f.Manager.GetExistingAsync(
            SessionWait.Text(f.Manager.ChannelBinding("work:wrk-chat")!["sessionId"])!,
            default
        );
        await TelegramChannelTests.Until(() =>
            bound!.Entry.WithState(state => state.Queue.Count) == 1
        );
        Assert.Contains(
            "你好 🦊 fragment",
            string.Join(
                "",
                bound!
                    .Entry.WithState(state => state.Queue[0].Parts!)
                    .Select(part => SessionWait.Text(part["text"] ?? part["system"]))
            )
        );
        var transport = f.Manager.ChannelRegistry.Get("work")!;
        var update = transport.Send("wrk-chat", "native update", new(), default);
        await transport
            .Send("other-chat", "independent command", new(), default)
            .WaitAsync(TimeSpan.FromSeconds(3));
        Assert.False(update.IsCompleted);
        Assert.Single(peer.Frames, frame => Cmd(frame) == "aibot_respond_msg");
        held.TrySetResult();
        await update.WaitAsync(TimeSpan.FromSeconds(3));
        var streamFrames = peer.Frames.Where(frame => Cmd(frame) == "aibot_respond_msg").ToArray();
        Assert.Equal(2, streamFrames.Length);
        Assert.All(streamFrames, frame => Assert.Equal("same-req", Req(frame)));
        peer.Ack = frame =>
            Task.FromResult<JsonObject?>(
                Cmd(frame) == "aibot_send_msg"
                    ? new() { ["errcode"] = 41002, ["errmsg"] = "controlled refusal" }
                    : new()
            );
        var error = await Assert.ThrowsAsync<IOException>(() =>
            transport.Send("other-chat", "bad", new(), default)
        );
        Assert.Contains("controlled refusal", error.Message);
        Assert.Contains("41002", error.Message);
        Assert.Empty(peer.Calls);
        peer.Ack = frame =>
            Task.FromResult<JsonObject?>(Cmd(frame) == "aibot_send_msg" ? null : new());
        var timed = await Assert.ThrowsAsync<IOException>(() =>
            transport.Send("other-chat", "timeout", new(), default)
        );
        Assert.Contains("timed out waiting for ack", timed.Message);
        Assert.Empty(peer.Calls);
        peer.Ack = frame =>
            Task.FromResult<JsonObject?>(
                Cmd(frame) == "aibot_send_msg" ? new() { ["close"] = true } : new()
            );
        var closed = await Assert.ThrowsAsync<IOException>(() =>
            transport.Send("other-chat", "closed", new(), default)
        );
        Assert.Contains("WebSocket closed", closed.Message);
        await TelegramChannelTests.Until(() =>
            peer.Frames.Count(frame => Cmd(frame) == "aibot_subscribe") >= 2
        );
        peer.Ack = _ => Task.FromResult<JsonObject?>(new());
        peer.Event("disconnected_event");
        await TelegramChannelTests.Until(() =>
            peer.Frames.Count(frame => Cmd(frame) == "aibot_subscribe") >= 3
        );
        peer.Ack = frame =>
            Task.FromResult<JsonObject?>(Cmd(frame) == "aibot_send_msg" ? null : new());
        var pending = transport.Send("other-chat", "stop-pending", new(), default);
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame =>
                frame["body"]?["markdown"]?["content"]?.GetValue<string>() == "stop-pending"
            )
        );
        await f
            .Manager.ManagedChannels.ChangeAsync("stop", "work")
            .WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Contains("stopped", (await Assert.ThrowsAsync<IOException>(() => pending)).Message);
        Assert.Null(f.Manager.ChannelRegistry.Get("work"));
        Assert.Empty(peer.Calls);
    }

    [Fact]
    public async Task Only_ordinary_input_supersedes_the_active_card_and_commands_keep_their_own_card()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(socket: true) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );
        peer.Push(WeWorkPeer.Text("old"), "req-old");
        var channel = f.Manager.ChannelRegistry.Get("work")!;
        await TelegramChannelTests.Until(() => channel.IsLifecycleActive!("wrk-chat"));
        await channel.Send("wrk-chat", "substantive", new(), default);
        await channel.Progress!("wrk-chat", new("tool-calls-start", [new("r", "read")]), default);
        peer.Push(WeWorkPeer.Text("new"), "req-new");
        await TelegramChannelTests.Until(() => peer.Frames.Any(frame => Req(frame) == "req-new"));
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame =>
                Req(frame) == "req-old"
                && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
            )
        );
        var oldFinal = peer.Frames.Last(frame => Req(frame) == "req-old");
        Assert.Equal("substantive", WeWorkCallbackTests.Content(oldFinal["body"]!.AsObject()));
        peer.Push(WeWorkPeer.Text("command", "@企业机器人 /whoami"), "req-command");
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame =>
                Req(frame) == "req-command"
                && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
                && (frame["body"]?["stream"]?["content"]?.GetValue<string>() ?? "").Contains(
                    "alice",
                    StringComparison.Ordinal
                )
            )
        );
        Assert.DoesNotContain(
            peer.Frames,
            frame =>
                Req(frame) == "req-new"
                && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
        );
        await channel.Progress!("wrk-chat", new("tool-calls-start", [new("r2", "exec")]), default);
        await channel.Send("wrk-chat", "ordinary final", new(TurnFinal: true), default);
        var ordinaryFinal = peer.Frames.Last(frame => Req(frame) == "req-new")["body"]!.AsObject();
        Assert.True(ordinaryFinal["stream"]!["finish"]!.GetValue<bool>());
        Assert.Contains("exec", WeWorkCallbackTests.Content(ordinaryFinal));
        Assert.EndsWith("</think>\nordinary final", WeWorkCallbackTests.Content(ordinaryFinal));
        // Reuse only the adapter already registered by managed ownership for direct option qualification.
        await f.Manager.ManagedChannels.ChangeAsync("stop", "work");
        await using var direct = new WeWorkChannel(
            "direct",
            peer.Config(socket: true),
            f.Manager,
            f.Router,
            peer.Dependencies,
            ChannelHealth.From(_ => { })
        );
        await direct.StartAsync();
        await TelegramChannelTests.Until(() =>
            peer.Frames.Count(frame => Cmd(frame) == "aibot_subscribe") >= 2
        );
        await direct.SendTextAsync(
            "wrk-explicit",
            "override",
            new(WebhookUrl: peer.Webhook, MessageType: "text"),
            default
        );
        Assert.Single(peer.Calls);
        Assert.Equal("text", peer.Calls.Single().Body["msgtype"]!.GetValue<string>());
    }

    [Fact]
    public async Task Idle_continue_closes_its_card_and_sends_the_second_reply_proactively()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(socket: true) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );

        peer.Push(WeWorkPeer.Text("continue", "/continue"), "req-continue");
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_send_msg")
        );

        var streamFrames = peer.Frames.Where(frame => Req(frame) == "req-continue").ToArray();
        Assert.Equal(2, streamFrames.Length);
        Assert.False(streamFrames[0]["body"]!["stream"]!["finish"]!.GetValue<bool>());
        Assert.True(streamFrames[1]["body"]!["stream"]!["finish"]!.GetValue<bool>());
        Assert.Contains(
            "Continuing interrupted turn",
            WeWorkCallbackTests.Content(streamFrames[1]["body"]!.AsObject())
        );
        var followup = peer.Frames.Single(frame => Cmd(frame) == "aibot_send_msg")["body"]!;
        Assert.Equal("wrk-chat", followup["chatid"]!.GetValue<string>());
        Assert.Contains(
            "Session has no interrupted turn to continue.",
            followup["markdown"]!["content"]!.GetValue<string>()
        );
        Assert.Empty(peer.Calls);
    }

    [Theory]
    [InlineData(false, "Unauthorized")]
    [InlineData(true, "is unavailable")]
    public async Task Rejected_inbound_finishes_the_request_card_without_admitting_a_turn(
        bool authorized,
        string expected
    )
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(socket: true) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        if (authorized)
            f.Manager.AttachConfiguredChannel("work:wrk-chat", "main/fixture-missing");
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );

        peer.Push(
            WeWorkPeer.Text("rejected", user: authorized ? "alice" : "fixture-stranger"),
            "req-rejected"
        );
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame =>
                Req(frame) == "req-rejected"
                && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
            )
        );

        var final = peer.Frames.Last(frame => Req(frame) == "req-rejected")["body"]!.AsObject();
        Assert.Contains(
            expected,
            WeWorkCallbackTests.Content(final),
            StringComparison.OrdinalIgnoreCase
        );
        Assert.False(f.Manager.ChannelRegistry.Get("work")!.IsLifecycleActive!("wrk-chat"));
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Send_only_accepts_input_and_replies_to_mode_command_without_allocating_cards()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(socket: true) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel(
            "work:wrk-chat",
            f.Owner,
            updates: new() { ["mode"] = "send-only" }
        );
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );

        peer.Push(WeWorkPeer.Text("ordinary", "send-only input"), "req-ordinary");
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 1
        );
        var channel = f.Manager.ChannelRegistry.Get("work")!;
        await channel.Send("wrk-chat", "explicit reply", new(), default);
        peer.Push(WeWorkPeer.Text("normal", "/channel mode normal"), "req-normal");
        await TelegramChannelTests.Until(() =>
            peer.Frames.Count(frame => Cmd(frame) == "aibot_send_msg") == 2
        );
        Assert.DoesNotContain(peer.Frames, frame => Cmd(frame) == "aibot_respond_msg");
        Assert.Equal(
            new[] { "explicit reply", "✅ Channel mode set to normal" },
            peer.Frames.Where(frame => Cmd(frame) == "aibot_send_msg")
                .Select(frame => frame["body"]!["markdown"]!["content"]!.GetValue<string>())
        );

        peer.Push(WeWorkPeer.Text("normal-input"), "req-normal-input");
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Req(frame) == "req-normal-input")
        );
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 2
        );
        Assert.True(channel.IsLifecycleActive!("wrk-chat"));
        Assert.Empty(peer.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Dispatch_without_admission_or_reply_closes_only_the_request_card(
        bool shutdown
    )
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(socket: true) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );
        peer.Push(WeWorkPeer.Text("active"), "req-active");
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);

        var mutationAdmission = f.Owner.Entry.MutationAdmission;
        try
        {
            if (shutdown)
                f.Manager.BeginShutdown();
            else
                f.Owner.Entry.MutationAdmission = () =>
                    throw new InvalidOperationException("queue fixture failure");

            peer.Push(WeWorkPeer.Text("not-admitted"), "req-unadmitted");
            await TelegramChannelTests.Until(() =>
                peer.Frames.Any(frame =>
                    Req(frame) == "req-unadmitted"
                    && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
                )
            );
        }
        finally
        {
            f.Owner.Entry.MutationAdmission = mutationAdmission;
        }
        var final = peer.Frames.Last(frame => Req(frame) == "req-unadmitted")["body"]!.AsObject();
        Assert.Equal(
            "The message could not be accepted for processing.",
            WeWorkCallbackTests.Content(final)
        );
        Assert.True(f.Manager.ChannelRegistry.Get("work")!.IsLifecycleActive!("wrk-chat"));
        Assert.DoesNotContain(
            peer.Frames,
            frame =>
                Req(frame) == "req-active"
                && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
        );
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }

    [Theory]
    [InlineData("send-only", "Channel mode set to send-only")]
    [InlineData("attach", "Attached to session")]
    [InlineData("/session new", "Created and attached to new session")]
    [InlineData("/session create main fixture", "Created session")]
    [InlineData("/session fork --attach", "This conversation is now attached to the fork.")]
    public async Task Changing_the_binding_closes_the_old_card_while_the_session_keeps_running(
        string change,
        string confirmation
    )
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var releaseAnswer = Signal();
        await using var provider = new ScriptedResponsesSequenceServer(
            change == "/session fork --attach" ? 2 : 1,
            async (_, stream, _) =>
            {
                await releaseAnswer.Task.WaitAsync(TimeSpan.FromSeconds(15));
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    WeWorkTurnTests.Complete(new JsonArray(TelegramHostTests.Output("late answer")))
                );
            }
        );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(socket: true) },
            provider.BaseUri,
            peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        var input = change switch
        {
            "send-only" => "/channel mode send-only",
            "attach" =>
                $"/channel attach {(await f.Manager.CreateNamedAsync("main", "rebound", null, null)).Id}",
            _ => change,
        };
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => Cmd(frame) == "aibot_subscribe")
        );

        peer.Push(WeWorkPeer.Text("in-progress"), "req-turn");
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var running = f.Owner.StartProcessing();
        try
        {
            await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(5));
            var channel = f.Manager.ChannelRegistry.Get("work")!;
            await channel.Send("wrk-chat", "already sent", new(), default);
            peer.Push(WeWorkPeer.Text("change-binding", input), "req-binding");
            await TelegramChannelTests.Until(() =>
                peer.Frames.Any(frame =>
                    Req(frame) == "req-turn"
                    && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
                )
                && peer.Frames.Any(frame =>
                    Req(frame) == "req-binding"
                    && frame["body"]?["stream"]?["finish"]?.GetValue<bool>() == true
                )
            );
            var old = peer.Frames.Last(frame => Req(frame) == "req-turn")["body"]!.AsObject();
            Assert.Contains("already sent", WeWorkCallbackTests.Content(old));
            Assert.EndsWith(
                "</think>\nAutomatic replies from this session will no longer be sent to this conversation.",
                WeWorkCallbackTests.Content(old)
            );
            var command = peer.Frames.Last(frame => Req(frame) == "req-binding")[
                "body"
            ]!.AsObject();
            Assert.Contains(confirmation, WeWorkCallbackTests.Content(command));
            var destination = SessionWait.Text(
                f.Manager.ChannelBinding("work:wrk-chat")?["sessionId"]
            );
            Assert.NotNull(destination);
            Assert.Equal(change == "send-only", destination == f.Owner.Id);
            Assert.Equal(change == "send-only", f.Manager.IsChannelSendOnly("work:wrk-chat"));
            Assert.True(f.Owner.Metadata().Busy);
            releaseAnswer.TrySetResult();
            await running.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Contains(
                f.Owner.History(),
                row => row.ToJsonString().Contains("late answer", StringComparison.Ordinal)
            );
            Assert.DoesNotContain(
                peer.Frames,
                frame => frame.ToJsonString().Contains("late answer", StringComparison.Ordinal)
            );
            Assert.DoesNotContain(peer.Frames, frame => Cmd(frame) == "aibot_send_msg");
            Assert.Empty(peer.Calls);
        }
        finally
        {
            releaseAnswer.TrySetResult();
            await running.WaitAsync(TimeSpan.FromSeconds(15));
        }
    }
}
