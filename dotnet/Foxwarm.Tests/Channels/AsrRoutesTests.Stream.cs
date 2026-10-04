using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    [Fact]
    public async Task Real_PCM_stream_preserves_shorter_partials_final_context_fragments_and_secrets()
    {
        await using var f = await Fixture.Create(prefix: true); using var socket = await f.Connect("/prefix/api/asr/stream", "https://public.example");
        await Send(socket, new { type = "start", context = " " + new string('c', 2500) + " ", language = " English ", credential = "not-forwarded" });
        var ready = await Json(socket); Assert.Equal("ready", ready["type"]!.ToString()); Assert.DoesNotContain(Fixture.Key, ready.ToJsonString());
        await socket.SendAsync(new byte[] { 1, 0, 255 }, WebSocketMessageType.Binary, false, CancellationToken.None);
        await socket.SendAsync(new byte[] { 127 }, WebSocketMessageType.Binary, true, CancellationToken.None);
        Assert.Equal("long hypothesis", (await Json(socket))["text"]!.ToString()); Assert.Equal("short", (await Json(socket))["text"]!.ToString());
        await Send(socket, new { type = "stop" }); var final = await Json(socket); Assert.Equal("scripted final", final["text"]!.ToString()); Assert.Equal("final", final["type"]!.ToString());
        Assert.Null(final["credential"]); Assert.Null(final["privatePath"]); Assert.Equal(4, f.AudioLength);
        Assert.Equal(2400, f.Controls[0]["context"]!.ToString().Length); Assert.Equal("English", f.Controls[0]["language"]!.ToString()); Assert.Null(f.Controls[0]["credential"]);
        Assert.All(f.ReceivedCookies, value => Assert.Empty(value)); Assert.All(f.ReceivedOrigins, value => Assert.Empty(value));
    }
    [Fact]
    public async Task WS_uses_normal_auth_and_origin_before_any_upstream_admission()
    {
        await using var f = await Fixture.Create(prefix: true);
        await Assert.ThrowsAsync<WebSocketException>(() => f.Connect(credential: null));
        await Assert.ThrowsAsync<WebSocketException>(() => f.Connect(origin: "https://foreign.example")); Assert.Equal(0, f.Requests);
        using var socket = await f.Connect(origin: "https://public.example"); await Send(socket, new { type = "start" }); Assert.Equal("ready", (await Json(socket))["type"]!.ToString());
    }
    [Theory]
    [InlineData(401)]
    [InlineData(307)]
    public async Task Upstream_rejected_or_redirected_WS_never_admits_browser_or_replays_credentials(int status)
    {
        await using var f = await Fixture.Create(); f.StreamStatus = status;
        await Assert.ThrowsAsync<WebSocketException>(() => f.Connect()); Assert.Equal(1, f.Requests);
    }
    [Theory]
    [InlineData("binary-before-ready")]
    [InlineData("duplicate-start")]
    [InlineData("odd-pcm")]
    [InlineData("control-overflow")]
    [InlineData("invalid-control")]
    [InlineData("audio-overflow")]
    public async Task Browser_invalid_order_samples_controls_and_total_audio_fail_visibly(string fault)
    {
        await using var f = await Fixture.Create(); using var socket = await f.Connect();
        if (fault == "binary-before-ready") await socket.SendAsync(new byte[2], WebSocketMessageType.Binary, true, CancellationToken.None);
        else
        {
            await Send(socket, new { type = "start" }); await Json(socket);
            if (fault == "duplicate-start") await Send(socket, new { type = "start" });
            if (fault == "odd-pcm") await socket.SendAsync(new byte[3], WebSocketMessageType.Binary, true, CancellationToken.None);
            if (fault == "control-overflow") await Send(socket, new { type = "stop", junk = new string('x', 17000) });
            if (fault == "invalid-control") await Send(socket, new { type = "unsupported" });
            if (fault == "audio-overflow")
            {
                // A single fragmented PCM message crosses the aggregate budget;
                // none is forwarded before the complete message is validated.
                await socket.SendAsync(new byte[25 * 1024 * 1024], WebSocketMessageType.Binary, false, CancellationToken.None);
                await socket.SendAsync(new byte[2], WebSocketMessageType.Binary, true, CancellationToken.None);
            }
        }
        var result = await Json(socket); Assert.Equal("error", result["type"]!.ToString()); Assert.DoesNotContain(Fixture.Key, result.ToJsonString()); Assert.Equal(0, f.AudioLength);
    }
    [Theory]
    [InlineData("error")]
    [InlineData("final-before-ready")]
    [InlineData("invalid-json")]
    [InlineData("invalid-utf8")]
    [InlineData("binary")]
    [InlineData("oversized-transcript")]
    [InlineData("aggregate-text")]
    [InlineData("abrupt")]
    [InlineData("empty-final")]
    public async Task Provider_frame_errors_caps_close_and_empty_final_are_not_fabricated(string fault)
    {
        await using var f = await Fixture.Create(); f.Stream = async (socket, context) =>
        {
            await Receive(socket, context.RequestAborted);
            if (fault == "error") { await Send(socket, new { type = "error", error = Fixture.Key + "/private/path" }); return; }
            if (fault == "final-before-ready") { await Send(socket, new { type = "final", text = "too early" }); return; }
            if (fault == "invalid-json") { await socket.SendAsync(Encoding.UTF8.GetBytes("{invalid"), WebSocketMessageType.Text, true, context.RequestAborted); return; }
            if (fault == "invalid-utf8") { await socket.SendAsync(new byte[] { 255 }, WebSocketMessageType.Text, true, context.RequestAborted); return; }
            if (fault == "binary") { await socket.SendAsync(new byte[2], WebSocketMessageType.Binary, true, context.RequestAborted); return; }
            if (fault == "abrupt") { socket.Abort(); return; }
            await Send(socket, new { type = "ready" });
            if (fault == "empty-final") { await Send(socket, new { type = "final", text = "" }); return; }
            if (fault == "oversized-transcript") { await Send(socket, new { type = "partial", text = new string('x', 256 * 1024) }); return; }
            while (socket.State == WebSocketState.Open) await Send(socket, new { type = "partial", text = new string('x', 128 * 1024) }, context.RequestAborted);
        };
        using var client = await f.Connect(); await Send(client, new { type = "start" });
        JsonObject result; do { result = await Json(client); } while (result["type"]!.ToString() is "ready" or "partial");
        Assert.DoesNotContain(Fixture.Key, result.ToJsonString()); Assert.DoesNotContain("/private/path", result.ToJsonString());
        Assert.Equal(fault == "empty-final" ? "final" : "error", result["type"]!.ToString()); if (fault == "empty-final") Assert.Equal("", result["text"]!.ToString());
    }
    [Fact]
    public async Task Cancel_before_ready_closes_pending_upstream_without_audio()
    {
        await using var f = await Fixture.Create(); var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Stream = async (socket, context) => { await Receive(socket, context.RequestAborted); admitted.TrySetResult(); try { await Receive(socket, context.RequestAborted); } finally { closed.TrySetResult(); } };
        using var client = await f.Connect(); await Send(client, new { type = "start" }); await admitted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "cancel", CancellationToken.None); await closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); Assert.Equal(0, f.AudioLength);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_ready_and_final_deadlines_release_stalled_service(bool final)
    {
        await using var f = await Fixture.Create(); var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Stream = async (socket, context) =>
        {
            await Receive(socket, context.RequestAborted);
            if (final) { await Send(socket, new { type = "ready" }); await Receive(socket, context.RequestAborted); }
            try { await Receive(socket, context.RequestAborted); } finally { closed.TrySetResult(); }
        };
        using var client = await f.Connect(); await Send(client, new { type = "start" }); if (final) { await Json(client); await Send(client, new { type = "stop" }); }
        var clock = Stopwatch.StartNew();
        try { var response = await Receive(client); Assert.True(response is null || JsonNode.Parse(response.Bytes)?["type"]?.ToString() == "error"); }
        catch (WebSocketException) { }
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); Assert.InRange(clock.Elapsed.TotalSeconds, final ? 28 : 8, final ? 38 : 18);
    }
}
