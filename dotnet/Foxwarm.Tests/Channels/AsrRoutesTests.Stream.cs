using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    [Fact]
    public async Task Real_PCM_stream_preserves_browser_start_ready_audio_stop_final_and_extensions()
    {
        await using var f = await Fixture.Create(prefix: true);
        using var socket = await f.Connect("/prefix/api/asr/stream", "https://public.example");
        var context = new string('c', 2500) + "LATEST-DRAFT-TAIL-SENTINEL";
        await Send(
            socket,
            new
            {
                type = "start",
                context,
                language = " English ",
                extension = "retained",
            }
        );
        Assert.Equal("ready", (await Json(socket))["type"]!.ToString());
        await socket.SendAsync(
            new byte[] { 1, 0, 255 },
            WebSocketMessageType.Binary,
            false,
            default
        );
        await socket.SendAsync(new byte[] { 127 }, WebSocketMessageType.Binary, true, default);
        Assert.Equal("long hypothesis", (await Json(socket))["text"]!.ToString());
        Assert.Equal("short", (await Json(socket))["text"]!.ToString());
        await Send(socket, new { type = "stop" });
        var final = await Json(socket);
        Assert.Equal("scripted final", final["text"]!.ToString());
        Assert.Equal("final", final["type"]!.ToString());
        Assert.Equal("service extension", final["extension"]!.ToString());
        Assert.Equal(4, f.AudioLength);
        Assert.Equal(context, f.Controls[0]["context"]!.ToString());
        Assert.Equal(" English ", f.Controls[0]["language"]!.ToString());
        Assert.Equal("retained", f.Controls[0]["extension"]!.ToString());
        Assert.All(f.ReceivedCookies, value => Assert.Empty(value));
        Assert.All(f.ReceivedOrigins, value => Assert.Empty(value));
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "browser final", default);
    }

    [Fact]
    public async Task Opaque_text_binary_and_output_cross_old_protocol_caps_without_rewriting_or_final_ownership()
    {
        await using var f = await Fixture.Create();
        f.Stream = async (socket, context) =>
        {
            while (await Receive(socket, context.RequestAborted) is { } frame)
                await socket.SendAsync(frame.Bytes, frame.Type, true, context.RequestAborted);
        };
        using var client = await f.Connect();
        var messages = new[]
        {
            new Received(WebSocketMessageType.Binary, new byte[] { 1, 2, 3 }),
            new Received(
                WebSocketMessageType.Text,
                Encoding.UTF8.GetBytes("{not parsed " + new string('x', 17000))
            ),
            new Received(
                WebSocketMessageType.Text,
                Encoding.UTF8.GetBytes("{\"type\":\"final\",\"text\":\"\",\"extension\":true}")
            ),
            new Received(
                WebSocketMessageType.Binary,
                Enumerable.Repeat((byte)91, 26 * 1024 * 1024).ToArray()
            ),
            new Received(
                WebSocketMessageType.Text,
                Encoding.UTF8.GetBytes("still open after final")
            ),
        };
        foreach (var message in messages)
        {
            await client.SendAsync(message.Bytes, message.Type, true, default);
            var echo = (await Receive(client))!;
            Assert.Equal(message.Type, echo.Type);
            Assert.Equal(message.Bytes, echo.Bytes);
        }
        await client.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", default);
    }

    [Fact]
    public async Task WS_uses_normal_auth_before_any_upstream_admission()
    {
        await using var f = await Fixture.Create(prefix: true);
        await Assert.ThrowsAsync<WebSocketException>(() => f.Connect(credential: null));
        Assert.Equal(0, f.Requests);
        using var socket = await f.Connect(origin: "https://foreign.example");
        await Send(socket, new { type = "start" });
        Assert.Equal("ready", (await Json(socket))["type"]!.ToString());
    }

    [Theory]
    [InlineData(401)]
    [InlineData(307)]
    public async Task Upstream_rejected_or_redirected_WS_closes_browser_without_replaying_credentials(
        int status
    )
    {
        await using var f = await Fixture.Create();
        f.StreamStatus = status;
        using var socket = await f.Connect();
        Assert.Null(await Receive(socket));
        Assert.Equal(WebSocketCloseStatus.InternalServerError, socket.CloseStatus);
        using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await socket.CloseOutputAsync(
            WebSocketCloseStatus.NormalClosure,
            "acknowledged",
            closing.Token
        );
        Assert.Equal(WebSocketState.Closed, socket.State);
        await f.StreamCompleted.Task.WaitAsync(closing.Token);
        Assert.Equal(1, f.Requests);
    }

    [Fact]
    public async Task Upstream_rejection_without_browser_close_response_releases_the_request()
    {
        await using var f = await Fixture.Create();
        f.StreamStatus = 307;
        using var socket = await f.Connect();
        Assert.Null(await Receive(socket));
        Assert.Equal(WebSocketCloseStatus.InternalServerError, socket.CloseStatus);
        // Keep the browser open without acknowledging. The close bound must release its receive owner.
        await f.StreamCompleted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, f.Requests);
    }

    [Fact]
    public async Task Cancel_before_ready_closes_pending_upstream_without_audio()
    {
        await using var f = await Fixture.Create();
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Stream = async (socket, context) =>
        {
            await Receive(socket, context.RequestAborted);
            admitted.TrySetResult();
            try
            {
                await Receive(socket, context.RequestAborted);
            }
            finally
            {
                closed.TrySetResult();
            }
        };
        using var client = await f.Connect();
        await Send(client, new { type = "start" });
        await admitted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await client.CloseAsync(WebSocketCloseStatus.NormalClosure, "cancel", default);
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, f.AudioLength);
    }

    [Fact]
    public async Task Browser_cancel_during_upstream_handshake_cancels_that_request()
    {
        await using var f = await Fixture.Create();
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        f.BeforeStream = async context =>
        {
            admitted.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            catch (OperationCanceledException)
            {
                cancelled.TrySetResult();
                throw;
            }
        };
        using var client = await f.Connect();
        await Send(client, new { type = "start", extension = "pending" });
        await admitted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await client.CloseAsync(WebSocketCloseStatus.NormalClosure, "cancel handshake", default);
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task Service_close_code_and_reason_are_forwarded_without_fabricated_transcript()
    {
        await using var f = await Fixture.Create();
        f.Stream = async (socket, context) =>
        {
            await Receive(socket, context.RequestAborted);
            await socket.CloseAsync(
                WebSocketCloseStatus.PolicyViolation,
                "service reason",
                context.RequestAborted
            );
        };
        using var client = await f.Connect();
        await Send(client, new { type = "start" });
        Assert.Null(await Receive(client));
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, client.CloseStatus);
        Assert.Equal("service reason", client.CloseStatusDescription);
        using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await client.CloseOutputAsync(
            WebSocketCloseStatus.NormalClosure,
            "acknowledged",
            closing.Token
        );
        Assert.Equal(WebSocketState.Closed, client.State);
        await f.StreamCompleted.Task.WaitAsync(closing.Token);
    }

    [Fact]
    public async Task Delayed_final_after_previous_finalization_deadline_is_forwarded()
    {
        await using var f = await Fixture.Create();
        f.Stream = async (socket, context) =>
        {
            await Receive(socket, context.RequestAborted);
            await Send(socket, new { type = "ready" }, context.RequestAborted);
            await Receive(socket, context.RequestAborted);
            // Exercise the removed thirty-second product cutoff once, not a ten-minute recording sleep.
            await Task.Delay(TimeSpan.FromSeconds(31), context.RequestAborted);
            await Send(
                socket,
                new
                {
                    type = "final",
                    text = "late final",
                    extension = 713,
                },
                context.RequestAborted
            );
            await Receive(socket, context.RequestAborted);
        };
        using var client = await f.Connect();
        await Send(client, new { type = "start" });
        Assert.Equal("ready", (await Json(client))["type"]!.ToString());
        await Send(client, new { type = "stop" });
        var final = await Json(client);
        Assert.Equal("late final", final["text"]!.ToString());
        Assert.Equal(713, final["extension"]!.GetValue<int>());
        await client.CloseAsync(WebSocketCloseStatus.NormalClosure, "browser final", default);
    }
}
