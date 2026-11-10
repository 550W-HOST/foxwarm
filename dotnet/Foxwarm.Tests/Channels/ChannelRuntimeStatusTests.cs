using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

// Channel status: lifecycle failures persist until the next successful start; runtime failures
// show only while the failing path is failing and clear when the same path succeeds again.
public sealed class ChannelRuntimeStatusTests
{
    private static string? LastError(ExternalChannelFixture f, string id) =>
        f
            .Manager.ManagedChannels!.Statuses()
            .OfType<JsonObject>()
            .Single(row => row["channelId"]!.ToString() == id)["lastError"]
            ?.ToString();

    private static Task ErrorAsync(ExternalChannelFixture f, string id, string expected) =>
        TelegramChannelTests.Until(() => LastError(f, id) == expected);

    private static Task ClearAsync(ExternalChannelFixture f, string id) =>
        TelegramChannelTests.Until(() => LastError(f, id) is null);

    private static IResult Ok(object result) => Results.Json(new { ok = true, result });

    // ---- Sentences ----

    [Fact]
    public void Chained_network_errors_read_as_a_cause_without_type_names_or_vendor_text()
    {
        var timedOut = new HttpRequestException(
            "Telegram API request timed out.",
            new TaskCanceledException("secret-path /home/user/token", new TimeoutException())
        );
        Assert.Equal(
            "Telegram polling failed: the request timed out.",
            ChannelFailure.Sentence("Telegram polling", timedOut)
        );
        var dropped = new HttpRequestException(
            "secret-url https://example.invalid/bot123:token/",
            new IOException("secret", new SocketException((int)SocketError.TimedOut))
        );
        var text = ChannelFailure.Sentence("Telegram polling", dropped);
        Assert.Equal("Telegram polling failed: connection timed out.", text);
        Assert.DoesNotContain("Exception", text);
        Assert.DoesNotContain("secret", text);
    }

    [Fact]
    public void Stage_failures_name_the_stage_and_a_typed_cause_only()
    {
        var failure = new ChannelFailure(
            "Telegram identity lookup",
            new TelegramApiException(401, "secret-vendor-description")
        );
        Assert.Equal(
            "Telegram identity lookup failed: Telegram rejected the bot token (401).",
            ChannelFailure.Describe(failure)
        );
        Assert.Equal(
            "QQ Bot gateway failed: the server closed the gateway connection (code 4914).",
            ChannelFailure.Sentence(
                "QQ Bot gateway",
                new QQBotGatewayException("terminal close", 4914)
            )
        );
        Assert.Equal(
            "Channel start failed: unexpected error; see the Main server log.",
            ChannelFailure.Describe(new InvalidOperationException("secret /tmp/path token=abc"))
        );
    }

    [Fact]
    public void Only_failures_of_the_channel_itself_are_channel_level()
    {
        Assert.True(ChannelFailure.ChannelLevel(new HttpRequestException("x")));
        Assert.True(ChannelFailure.ChannelLevel(new TelegramApiException(502, "x")));
        Assert.True(ChannelFailure.ChannelLevel(new TelegramApiException(401, "x")));
        Assert.False(ChannelFailure.ChannelLevel(new TelegramApiException(403, "x")));
        Assert.False(ChannelFailure.ChannelLevel(new QQBotApiException("x", 40034005, 400)));
        Assert.False(ChannelFailure.ChannelLevel(new InvalidDataException("x")));
        Assert.False(
            ChannelFailure.ChannelLevel(new HttpRequestException("x"), new CancellationToken(true))
        );
    }

    // ---- Telegram ----

    [Fact]
    public async Task Telegram_polling_error_shows_only_while_polling_fails()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var failing = true;
        var healed = 0;
        peer.Respond = call =>
        {
            if (call.Method != "getUpdates" || call.Body["limit"] is not null)
                return Task.FromResult<IResult?>(null);
            if (Volatile.Read(ref failing))
                return Task.FromResult<IResult?>(
                    Results.Json(
                        new
                        {
                            ok = false,
                            error_code = 502,
                            description = "secret-body",
                        },
                        statusCode: 502
                    )
                );
            // One successful empty poll, then the peer's normal blocking long poll.
            return Task.FromResult<IResult?>(
                Interlocked.Increment(ref healed) == 1 ? Ok(Array.Empty<object>()) : null
            );
        };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await ErrorAsync(f, "alpha", "Telegram polling failed: Telegram server error (502).");
        Assert.DoesNotContain("secret", LastError(f, "alpha"));
        Volatile.Write(ref failing, false);
        await ClearAsync(f, "alpha");
    }

    [Fact]
    public async Task Telegram_start_failure_persists_until_the_next_successful_start()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var reject = true;
        peer.Fail = call =>
            call.Method == "setMyCommands" && Volatile.Read(ref reject)
                ? (401, "secret-vendor-description")
                : null;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        await Assert.ThrowsAnyAsync<Exception>(() =>
            f.Manager.ManagedChannels!.ChangeAsync("start", "alpha")
        );
        const string expected =
            "Telegram command registration failed: Telegram rejected the bot token (401).";
        Assert.Equal(expected, LastError(f, "alpha"));
        await Task.Delay(100);
        Assert.Equal(expected, LastError(f, "alpha"));
        Volatile.Write(ref reject, false);
        await f.Manager.ManagedChannels!.ChangeAsync("start", "alpha");
        Assert.Null(LastError(f, "alpha"));
    }

    [Fact]
    public async Task Telegram_send_failure_clears_on_the_next_delivered_message_and_payload_errors_are_not_channel_failures()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var mode = "ok";
        peer.Fail = call =>
            call.Method != "sendMessage" ? null
            : mode == "server" ? (502, "secret")
            : mode == "payload" ? (400, "Bad Request: can't parse entities")
            : null;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        mode = "payload";
        await Assert.ThrowsAnyAsync<Exception>(() =>
            f.Manager.ChannelRegistry.SendAsync("alpha:11", "text", default)
        );
        Assert.Null(LastError(f, "alpha"));
        mode = "server";
        await Assert.ThrowsAnyAsync<Exception>(() =>
            f.Manager.ChannelRegistry.SendAsync("alpha:11", "text", default)
        );
        Assert.Equal(
            "Telegram sending failed: Telegram server error (502).",
            LastError(f, "alpha")
        );
        mode = "ok";
        await f.Manager.ChannelRegistry.SendAsync("alpha:11", "text", default);
        Assert.Null(LastError(f, "alpha"));
    }

    [Fact]
    public async Task Stopping_a_channel_clears_its_runtime_error()
    {
        await using var peer = await TelegramPeer.StartAsync();
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method == "getUpdates" && call.Body["limit"] is null
                    ? Results.Json(
                        new
                        {
                            ok = false,
                            error_code = 502,
                            description = "x",
                        },
                        statusCode: 502
                    )
                    : null
            );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => LastError(f, "alpha") is not null);
        await f.Manager.ManagedChannels.ChangeAsync("stop", "alpha");
        Assert.Null(LastError(f, "alpha"));
        await Task.Delay(100);
        Assert.Null(LastError(f, "alpha"));
    }

    // ---- Matrix ----

    [Fact]
    public async Task Matrix_sync_error_clears_when_a_sync_succeeds()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var failing = true;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.EndsWith("/sync", StringComparison.Ordinal) && Volatile.Read(ref failing)
                    ? Results.Json(new { errcode = "M_UNKNOWN", error = "secret" }, statusCode: 502)
                    : null
            );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["mx"] = peer.Matrix() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await ErrorAsync(f, "mx", "Matrix sync failed: the homeserver returned HTTP 502.");
        Volatile.Write(ref failing, false);
        await ClearAsync(f, "mx");
    }

    // ---- Weixin ----

    [Fact]
    public async Task Weixin_polling_error_clears_and_a_normal_long_poll_timeout_is_not_an_error()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var failing = true;
        var polls = 0;
        peer.Respond = call =>
        {
            if (!call.Path.EndsWith("/getupdates", StringComparison.Ordinal))
                return Task.FromResult<IResult?>(null);
            Interlocked.Increment(ref polls);
            return Task.FromResult<IResult?>(
                Volatile.Read(ref failing)
                    ? Results.Json(new { ret = -14, errmsg = "secret-vendor" })
                    : null
            );
        };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["wx"] = peer.Weixin() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await ErrorAsync(
            f,
            "wx",
            "Weixin polling failed: the Weixin login has expired; run /channel weixin login again."
        );
        Volatile.Write(ref failing, false);
        await ClearAsync(f, "wx");
        // With nothing to deliver, the 80 ms client long-poll deadline keeps expiring.
        var seen = Volatile.Read(ref polls);
        await TelegramChannelTests.Until(() => Volatile.Read(ref polls) >= seen + 3);
        Assert.Null(LastError(f, "wx"));
    }

    // ---- QQ Bot ----

    [Fact]
    public async Task QQ_requested_reconnects_are_log_only_and_a_rejecting_close_shows_until_the_gateway_is_ready()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        int Identifies() => peer.Frames.Count(frame => frame["op"]!.ToString() is "2" or "6");
        await TelegramChannelTests.Until(() => Identifies() == 1);

        // The protocol asks for a reconnect: nothing to report, before or after it.
        peer.Push(new JsonObject { ["op"] = 7 });
        await TelegramChannelTests.Until(() => Identifies() == 2);
        Assert.Null(LastError(f, "qq"));

        // A session-timeout close is a resume-class close.
        await peer.Sockets.Values.Last().CloseOutputAsync((WebSocketCloseStatus)4009, "x", default);
        await TelegramChannelTests.Until(() => Identifies() == 3);
        Assert.Null(LastError(f, "qq"));

        // An authentication close is a failure until a connection becomes ready again.
        await peer
            .Sockets.Values.Last()
            .CloseOutputAsync((WebSocketCloseStatus)4004, "secret", default);
        await ErrorAsync(
            f,
            "qq",
            "QQ Bot gateway failed: the server closed the gateway connection (code 4004)."
        );
        await TelegramChannelTests.Until(() => Identifies() == 4);
        Assert.NotNull(LastError(f, "qq"));
        peer.Push("READY", new JsonObject { ["session_id"] = "fixture-session" });
        await ClearAsync(f, "qq");

        // A resumed connection clears too.
        await peer.Sockets.Values.Last().CloseOutputAsync((WebSocketCloseStatus)4003, "x", default);
        await ErrorAsync(
            f,
            "qq",
            "QQ Bot gateway failed: the server closed the gateway connection (code 4003)."
        );
        await TelegramChannelTests.Until(() => Identifies() == 5);
        peer.Push("RESUMED", new JsonObject());
        await ClearAsync(f, "qq");
    }

    [Fact]
    public async Task QQ_send_failure_clears_on_the_next_delivered_message()
    {
        await using var peer = await QQBotPeer.StartAsync();
        var failing = false;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                Volatile.Read(ref failing)
                && call.Path.EndsWith("/messages", StringComparison.Ordinal)
                    ? Results.Json(new { code = 1, message = "secret" }, statusCode: 502)
                    : null
            );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        Volatile.Write(ref failing, true);
        await Assert.ThrowsAnyAsync<Exception>(() =>
            f.Manager.ChannelRegistry.SendAsync("qq:c2c:alice", "text", default)
        );
        Assert.Equal(
            "QQ Bot sending failed: QQ Bot API returned HTTP 502 (code 1).",
            LastError(f, "qq")
        );
        Volatile.Write(ref failing, false);
        await f.Manager.ChannelRegistry.SendAsync("qq:c2c:alice", "text", default);
        Assert.Null(LastError(f, "qq"));
    }

    // ---- WeWork ----

    [Fact]
    public async Task WeWork_subscription_rejection_shows_until_a_subscription_succeeds_and_a_server_close_is_log_only()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var reject = true;
        var closeOnPing = 0;
        peer.Ack = command =>
        {
            var name = command["cmd"]!.GetValue<string>();
            if (name == "aibot_subscribe" && Volatile.Read(ref reject))
                return Task.FromResult<JsonObject?>(
                    new JsonObject { ["errcode"] = 40001, ["errmsg"] = "secret-vendor" }
                );
            if (name == "ping" && Interlocked.Exchange(ref closeOnPing, 0) == 1)
                return Task.FromResult<JsonObject?>(new JsonObject { ["close"] = true });
            return Task.FromResult<JsonObject?>(new JsonObject());
        };
        var config = peer.Config(socket: true);
        config["aibot"]!["websocket"]!["heartbeatMs"] = 50;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = config },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        const string expected =
            "WeWork WebSocket subscription failed: the server did not accept it; check the bot ID and secret.";
        await ErrorAsync(f, "work", expected);
        Volatile.Write(ref reject, false);
        await ClearAsync(f, "work");

        // The server closes an established connection; the adapter reconnects by itself.
        var connections = peer.Connections;
        Volatile.Write(ref closeOnPing, 1);
        await TelegramChannelTests.Until(() => peer.Connections > connections);
        await TelegramChannelTests.Until(() =>
            peer.Frames.Count(frame => frame["cmd"]!.GetValue<string>() == "aibot_subscribe")
            > connections
        );
        Assert.Null(LastError(f, "work"));
    }

    [Fact]
    public async Task WeWork_webhook_send_failure_clears_on_the_next_delivered_message()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var failing = true;
        peer.Respond = call =>
            Task.FromResult<IResult?>(Volatile.Read(ref failing) ? Results.StatusCode(502) : null);
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await Assert.ThrowsAnyAsync<Exception>(() =>
            f.Manager.ChannelRegistry.SendAsync("work:wrk-chat", "text", default)
        );
        Assert.Equal("WeWork sending failed: the server returned HTTP 502.", LastError(f, "work"));
        Volatile.Write(ref failing, false);
        await f.Manager.ChannelRegistry.SendAsync("work:wrk-chat", "text", default);
        Assert.Null(LastError(f, "work"));
    }
}
