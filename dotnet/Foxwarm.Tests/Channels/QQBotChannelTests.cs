using System.Net;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class QQBotChannelTests
{
    private static Task Until(Func<bool> condition) => TelegramChannelTests.Until(condition);

    private static string Queued(SessionOwner owner) =>
        string.Join(
            "\n",
            owner
                .Entry.Snapshot()
                .Queue.SelectMany(item => item.Parts ?? [])
                .Select(part =>
                    SessionWait.Text(part["system"])
                    ?? SessionWait.Text(part["text"])
                    ?? part.ToJsonString()
                )
        );

    internal static async Task Start(ExternalChannelFixture f, QQBotPeer peer)
    {
        await f.Manager.ManagedChannels!.ReloadAsync();
        await Until(() => peer.Frames.Any(frame => frame["op"]?.ToString() == "2"));
        Assert.NotNull(f.Manager.ChannelRegistry.Get("qq"));
    }

    [Fact]
    public async Task Deferred_media_uses_original_authorization_actual_guest_owner_and_never_fetches_ambient_or_denied_media()
    {
        await using var peer = await QQBotPeer.StartAsync();
        peer.Assets["/asset"] = "fixture-file"u8.ToArray();
        var config = peer.Config();
        config["guestAgent"] = new JsonObject { ["agentId"] = "guest", ["isolated"] = false };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = config },
            dependencies: peer.Dependencies
        );
        await f.Manager.CreateAgentAsync("guest", createMainSession: false);
        await Start(f, peer);
        peer.Push(
            "GROUP_MESSAGE_CREATE",
            QQBotPeer.Message("ambient", "ambient", "denied", attachments: QQBotPeer.Attachment())
        );
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message("first", "first-guest", "denied", attachments: QQBotPeer.Attachment())
        );
        await Until(() => f.Manager.ChannelBinding("qq:group:room") is not null);
        var guest = await f.Manager.RequiredAsync(
            SessionWait.Text(f.Manager.ChannelBinding("qq:group:room")!["sessionId"])!
        );
        await Until(() => guest.Entry.Snapshot().Queue.Count == 1);
        Assert.Equal("guest", guest.Agent);
        Assert.DoesNotContain(peer.Calls, call => call.Path == "/asset");
        Assert.Contains("fixture.bin", Queued(guest));
        Assert.DoesNotContain("qpic", Queued(guest));
        Assert.DoesNotContain("foxwarm-file", Queued(guest));
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message(
                "second",
                "authorized-now",
                "denied",
                attachments: QQBotPeer.Attachment()
            )
        );
        await Until(() => guest.Entry.Snapshot().Queue.Count == 2);
        Assert.Single(peer.Calls, call => call.Path == "/asset");
        Assert.Contains("foxwarm-file", Queued(guest));
        Assert.Contains("guest", Queued(guest));
        Assert.False(
            Directory.Exists(
                Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files")
            )
        );
        Assert.Single(
            Directory.GetFiles(
                Path.Combine(f.Manager.AgentDirectory("guest"), ".temp", "channel-files"),
                "*",
                SearchOption.AllDirectories
            )
        );
        // A separate denied conversation without guest provisioning creates/saves nothing.
        var next = peer.Config();
        await f.Configuration.SaveAppAsync(
            new JsonObject { ["channels"] = new JsonObject { ["qq"] = next } }.ToJsonString()
        );
        peer.Push(
            "C2C_MESSAGE_CREATE",
            QQBotPeer.Message(
                "denied",
                "not-admitted",
                "stranger",
                attachments: QQBotPeer.Attachment()
            )
        );
        await Until(() =>
            peer.Sent.Any(call =>
                (SessionWait.Text(call.Body["content"]) ?? "").Contains("Unauthorized")
            )
        );
        Assert.Single(peer.Calls, call => call.Path == "/asset");
    }

    [Fact]
    public async Task Group_trigger_metadata_business_dedup_upgrade_platform_context_and_original_commands_use_normal_Router()
    {
        await using var peer = await QQBotPeer.StartAsync();
        var config = peer.Config();
        config["groupContextLimit"] = 2;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = config },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await Start(f, peer);
        var ordinary = QQBotPeer.Message(
            "one",
            "</foxwarm-qqbot-context-item>& ambient",
            "stranger",
            attachments: QQBotPeer.Attachment()
        );
        peer.Push("GROUP_MESSAGE_CREATE", ordinary, 101);
        peer.Push(
            "GROUP_MESSAGE_CREATE",
            QQBotPeer.Message("same", "ordinary representation"),
            102
        );
        var trigger = QQBotPeer.Message("same", "current 用户");
        trigger["mentions"] = new JsonArray(new JsonObject { ["is_you"] = true });
        peer.Push("GROUP_MESSAGE_CREATE", trigger, 101);
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var parts = f.Owner.Entry.Snapshot().Queue.Single().Parts!;
        Assert.Equal(QueueItemType.User, f.Owner.Entry.Snapshot().Queue.Single().Type);
        Assert.Equal("alice", f.Owner.Entry.Snapshot().Queue.Single().Source!.SenderId);
        var joined = Queued(f.Owner);
        Assert.Contains("group-message", joined);
        Assert.Contains("mentioned=\"true", joined);
        Assert.Contains("&lt;/foxwarm-qqbot-context-item&gt;&amp; ambient", joined);
        Assert.DoesNotContain("ordinary representation", joined);
        Assert.DoesNotContain("qpic", joined);
        Assert.DoesNotContain(peer.Calls, call => call.Path == "/asset");
        var wrapper = parts.First()["system"]!.GetValue<string>();
        Assert.StartsWith("<foxwarm-message", wrapper);
        Assert.Contains(
            "<foxwarm-metadata",
            string.Join("\n", parts.Select(part => SessionWait.Text(part["system"])))
        );
        peer.Push("GROUP_AT_MESSAGE_CREATE", trigger, 103);
        // A wire barrier on this same gateway follows the duplicate.
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("cmd", "/whoami"));
        await Until(() =>
            peer.Sent.Any(call =>
                (SessionWait.Text(call.Body["content"]) ?? "").Contains("User ID: alice")
            )
        );
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        var command = peer.Sent.Last();
        Assert.Equal("cmd", SessionWait.Text(command.Body["msg_id"]));
        Assert.DoesNotContain("foxwarm-metadata", SessionWait.Text(command.Body["content"])!);
        var history = QQBotPeer.Message("history", "current two");
        history["msg_elements"] = new JsonArray(
            new JsonObject
            {
                ["content"] =
                    "=== 消息 1 ===\n[消息内容] old\n\n=== 消息 2 ===\n[消息内容] <prior>&\nmultiline\n\n=== 消息 3 ===\n[消息内容] current two",
            }
        );
        peer.Push("GROUP_AT_MESSAGE_CREATE", history);
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 2);
        var last = string.Join(
            "\n",
            f.Owner.Entry.Snapshot()
                .Queue.Last()
                .Parts!.Select(part =>
                    SessionWait.Text(part["system"])
                    ?? SessionWait.Text(part["text"])
                    ?? part.ToJsonString()
                )
        );
        Assert.Contains("platform-history", last);
        Assert.Contains("&lt;prior&gt;&amp;", last);
        Assert.DoesNotContain("senderId=", last);
        Assert.DoesNotContain("qqbotMessageId", Queued(f.Owner));
    }

    [Fact]
    public async Task Always_mode_fixed_window_latest_trigger_and_unreliable_mentions_are_not_guessed()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config(false, 250) },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await Start(f, peer);
        var contentMention = QQBotPeer.Message("one", "<@fixture-app> ordinary");
        contentMention["mentions"] = new JsonArray(new JsonObject { ["bot"] = true });
        peer.Push("GROUP_MESSAGE_CREATE", contentMention);
        await Task.Delay(150);
        peer.Push("GROUP_MESSAGE_CREATE", QQBotPeer.Message("two", "later"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        Assert.Contains("mentioned=\"false", Queued(f.Owner));
        Assert.Contains("ordinary", Queued(f.Owner));
        var first = peer.Now;
        peer.Now = first.AddMinutes(5).AddMilliseconds(1);
        peer.Push("GROUP_MESSAGE_CREATE", QQBotPeer.Message("three", "discard on slash"));
        peer.Push("GROUP_MESSAGE_CREATE", QQBotPeer.Message("slash", "/whoami"));
        await Until(() => peer.Sent.Any(call => SessionWait.Text(call.Body["msg_id"]) == "slash"));
        await Task.Delay(300);
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Latest_passive_scope_direct_text_file_typing_quota_TTL_and_structured_expiration_share_one_sequence_allocator()
    {
        await using var peer = await QQBotPeer.StartAsync();
        var config = peer.Config();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = config },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("qq:c2c:alice", f.Owner);
        await Start(f, peer);
        var adapter = f.Manager.ChannelRegistry.Get("qq")!;
        peer.Push("C2C_MESSAGE_CREATE", QQBotPeer.Message("inbound", "first"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        await adapter.Typing!("c2c:alice", default);
        await adapter.Send("c2c:alice", "direct", new(), default);
        Assert.Null(peer.Sent.Last().Body["msg_id"]);
        await Task.WhenAll(
            Enumerable
                .Range(0, 4)
                .Select(i =>
                    adapter.Send(
                        "c2c:alice",
                        "automatic-" + i,
                        new(PresentationTurnId: "turn"),
                        default
                    )
                )
        );
        await adapter.Send("c2c:alice", "fifth", new(TurnFinal: true), default);
        Assert.Equal(
            4,
            peer.Sent.Count(call =>
                SessionWait.Text(call.Body["msg_id"]) == "inbound"
                && call.Body["msg_type"]?.ToString() == "0"
            )
        );
        Assert.Null(peer.Sent.Last().Body["msg_id"]);
        peer.Push("C2C_MESSAGE_CREATE", QQBotPeer.Message("expired", "second"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 2);
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.EndsWith("/messages")
                && SessionWait.Text(call.Body["msg_id"]) == "expired"
                    ? Results.Json(new { err_code = "40034005" }, statusCode: 400)
                    : null
            );
        var before = peer.Sent.Count();
        await adapter.Send("c2c:alice", "expiration", new(TurnFinal: true), default);
        var attempts = peer.Sent.Skip(before).ToArray();
        Assert.Equal(2, attempts.Length);
        Assert.Equal(
            attempts[0].Body["msg_seq"]!.ToString(),
            attempts[1].Body["msg_seq"]!.ToString()
        );
        Assert.Null(attempts[1].Body["msg_id"]);
        peer.Now = peer.Now.AddMinutes(3);
        await adapter.Send("c2c:alice", "aged", new(TurnFinal: true), default);
        Assert.Null(peer.Sent.Last().Body["msg_id"]);
        var file = Path.Combine(f.Work, "file.bin");
        await File.WriteAllTextAsync(file, "test payload");
        var count = peer.Sent.Count();
        await adapter.SendFile!(
            "c2c:alice",
            new(file, "file.bin", null, false),
            "caption",
            default
        );
        Assert.Single(peer.Sent.Skip(count));
        Assert.Equal("7", peer.Sent.Last().Body["msg_type"]!.ToString());
        await f.Configuration.SaveAppAsync(
            new JsonObject
            {
                ["channels"] = new JsonObject
                {
                    ["qq"] = config.DeepClone(),
                    ["second"] = config.DeepClone(),
                },
            }.ToJsonString()
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await f
            .Manager.ChannelRegistry.Get("second")!
            .Send("group:room", "other-instance", new(), default);
        var sequences = peer.Sent.Select(call => call.Body["msg_seq"]!.GetValue<uint>()).ToArray();
        Assert.All(sequences, sequence => Assert.InRange(sequence, 1u, uint.MaxValue));
        Assert.Equal(sequences.Length - 1, sequences.Distinct().Count()); // exactly one expiration retry
    }

    [Fact]
    public async Task Gateway_resume_invalid_session_heartbeat_ACK_close_classes_and_stop_are_generation_fenced()
    {
        await using var peer = await QQBotPeer.StartAsync();
        peer.HeartbeatMs = 40;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        await Start(f, peer);
        Assert.Equal("1174409216", peer.Frames.First()["d"]!["intents"]!.ToString());
        peer.Push(
            new()
            {
                ["op"] = 0,
                ["s"] = 41,
                ["t"] = "READY",
                ["d"] = new JsonObject { ["session_id"] = "session-one" },
            }
        );
        await Until(() =>
            peer.Frames.Any(frame =>
                frame["op"]?.ToString() == "1" && frame["d"]?.ToString() == "41"
            )
        );
        peer.Push(new() { ["op"] = 7 });
        await Until(() =>
            peer.Frames.Any(frame =>
                frame["fixtureConnection"]?.ToString() == "2" && frame["op"]?.ToString() == "6"
            )
        );
        Assert.Equal(
            "session-one",
            peer.Frames.Last(frame => frame["op"]?.ToString() == "6")["d"]![
                "session_id"
            ]!.ToString()
        );
        peer.Push(new() { ["op"] = 9, ["d"] = true });
        await Until(() =>
            peer.Frames.Any(frame =>
                frame["fixtureConnection"]?.ToString() == "3" && frame["op"]?.ToString() == "6"
            )
        );
        peer.Push(new() { ["op"] = 9, ["d"] = false });
        await Until(() =>
            peer.Frames.Any(frame =>
                frame["fixtureConnection"]?.ToString() == "4" && frame["op"]?.ToString() == "2"
            )
        );
        peer.AutoAck = false;
        await Until(() => peer.Connections >= 5);
        peer.AutoAck = true;
        await Until(() => peer.Frames.Any(frame => frame["fixtureConnection"]?.ToString() == "5"));
        await peer.Sockets[5].CloseOutputAsync((WebSocketCloseStatus)4914, "intents", default);
        await Task.Delay(150);
        Assert.Equal(5, peer.Connections);
        await f.Manager.ManagedChannels!.ChangeAsync("stop", "qq");
        var before = peer.Calls.Count;
        await Task.Delay(100);
        Assert.Equal(before, peer.Calls.Count);
    }

    [Fact]
    public async Task Business_sequence_index_normalization_context_TTL_and_bounded_accumulator_eviction_do_not_claim_exactly_once()
    {
        await using var peer = await QQBotPeer.StartAsync();
        var config = peer.Config();
        config["groupContextLimit"] = 2;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = config },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("qq:c2c:alice", f.Owner);
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await Start(f, peer);
        foreach (var sequence in new[] { "10", "10", "11" })
        {
            var body = QQBotPeer.Message("same-business-id", "business-" + sequence);
            body["msg_seq"] = sequence;
            body["message_scene"] = new JsonObject
            {
                ["ext"] = new JsonArray("msg_idx=one", "msg_idx=ambiguous"),
            };
            peer.Push("C2C_MESSAGE_CREATE", body, sequence == "11" ? 1 : 200);
        }
        peer.Push("GROUP_MESSAGE_CREATE", QQBotPeer.Message("stale", "expired ambient"));
        // A command is a wire/Router barrier, not a manufactured internal state mutation.
        peer.Push("C2C_MESSAGE_CREATE", QQBotPeer.Message("barrier", "/whoami"));
        await Until(() => peer.Sent.Any(call => call.Body["msg_id"]?.ToString() == "barrier"));
        Assert.Equal(2, f.Owner.Entry.Snapshot().Queue.Count);
        peer.Now = peer.Now.AddMinutes(5).AddMilliseconds(1);
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("fresh", "fresh trigger"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 3);
        Assert.DoesNotContain("expired ambient", Queued(f.Owner));
        for (var i = 0; i <= 1000; i++)
            peer.Push(
                "GROUP_MESSAGE_CREATE",
                QQBotPeer.Message("ambient-" + i, "context-" + i, group: "room-" + i)
            );
        f.Manager.AttachChannel("qq:group:room-0", f.Owner);
        f.Manager.AttachChannel("qq:group:room-1000", f.Owner);
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message("evicted", "evicted trigger", group: "room-0")
        );
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message("retained", "retained trigger", group: "room-1000")
        );
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 5);
        Assert.DoesNotContain("context-0", Queued(f.Owner));
        Assert.Contains("context-1000", Queued(f.Owner));
    }

    [Fact]
    public async Task Rejected_current_group_ingress_advances_passive_context_but_not_content_or_media_authority()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("qq:group:room", f.Owner);
        await Start(f, peer);
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("authorized", "authorized-input"));
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message(
                "rejected-latest",
                "denied-content",
                "stranger",
                attachments: QQBotPeer.Attachment()
            )
        );
        await Until(() =>
            peer.Sent.Any(call => call.Body["msg_id"]?.ToString() == "rejected-latest")
        );
        await f
            .Manager.ChannelRegistry.Get("qq")!
            .Send("group:room", "ongoing automatic result", new(TurnFinal: true), default);
        Assert.Equal("rejected-latest", peer.Sent.Last().Body["msg_id"]!.ToString());
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.DoesNotContain("denied-content", Queued(f.Owner));
        Assert.DoesNotContain(peer.Calls, call => call.Path == "/asset");
    }

    [Theory]
    [InlineData("AT_MESSAGE_CREATE", "guild:guild-channel", "/channels/guild-channel/messages")]
    [InlineData("DIRECT_MESSAGE_CREATE", "dm:guild-id", "/dms/guild-id/messages")]
    public async Task Guild_and_DM_text_keep_actual_sender_identity_and_scoped_routes_without_materializing_their_media(
        string type,
        string conversation,
        string path
    )
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("qq:" + conversation, f.Owner);
        await Start(f, peer);
        peer.Push(type, QQBotPeer.Message("media-only", "", attachments: QQBotPeer.Attachment()));
        peer.Push(
            type,
            QQBotPeer.Message("text", "guild text", attachments: QQBotPeer.Attachment())
        );
        await Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        Assert.Equal(conversation, f.Owner.Entry.Snapshot().Queue.Single().Source!.ConversationId);
        Assert.Equal("alice", f.Owner.Entry.Snapshot().Queue.Single().Source!.SenderId);
        Assert.DoesNotContain("group-message", Queued(f.Owner));
        Assert.DoesNotContain(peer.Calls, call => call.Path == "/asset");
        await f
            .Manager.ChannelRegistry.Get("qq")!
            .Send(conversation, "automatic", new(TurnFinal: true), default);
        Assert.Equal(path, peer.Sent.Last().Path);
        Assert.Equal("text", peer.Sent.Last().Body["msg_id"]!.ToString());
        Assert.Null(peer.Sent.Last().Body["msg_seq"]);
    }
}
