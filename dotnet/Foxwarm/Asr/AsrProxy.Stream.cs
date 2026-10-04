using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Asr;

internal sealed partial class AsrProxy
{
    private sealed class StreamFailure(string message) : Exception(message);
    private sealed record Frame(WebSocketMessageType Type, byte[] Bytes);
    private async Task StreamAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
        if (!Configured) { context.Response.StatusCode = 503; await context.Response.WriteAsJsonAsync(new { error = configurationError ?? "Speech service is not configured." }); return; }
        using var upstream = new ClientWebSocket();
        if (!string.IsNullOrEmpty(key)) upstream.Options.SetRequestHeader("Authorization", "Bearer " + key);
        var endpoint = new UriBuilder(Endpoint("/ws/stream")) { Scheme = service!.Scheme == "https" ? "wss" : "ws" };
        using var lifetime = Lifetime(context.RequestAborted, TimeSpan.FromSeconds(10));
        try { await upstream.ConnectAsync(endpoint.Uri, http, lifetime.Token); }
        catch (Exception error) when (error is HttpRequestException or WebSocketException or OperationCanceledException)
        {
            if (context.RequestAborted.IsCancellationRequested || stopped.IsCancellationRequested) return;
            context.Response.StatusCode = 502; await context.Response.WriteAsJsonAsync(new { error = ServiceError }); return;
        }
        // Browser start/context follows upgrade. Only control is admitted until
        // the actual upstream has acknowledged start with ready.
        using var downstream = await context.WebSockets.AcceptWebSocketAsync();
        lifetime.CancelAfter(TimeSpan.FromSeconds(10));
        var phase = 0; // Await start, await ready, recording, finalizing, terminal.
        long audioBytes = 0, outputBytes = 0;
        var completedFinal = false;
        async Task ClientToService()
        {
            while (true)
            {
                var frame = await ReceiveAsync(downstream, AudioLimit, ControlLimit, lifetime.Token);
                if (frame is null) return;
                if (frame.Type == WebSocketMessageType.Binary)
                {
                    if (Volatile.Read(ref phase) != 2) throw new StreamFailure("Audio arrived outside an active recording.");
                    if (frame.Bytes.Length % 2 != 0) throw new StreamFailure("Audio must contain complete PCM16 samples.");
                    if (Interlocked.Add(ref audioBytes, frame.Bytes.Length) > AudioLimit) throw new StreamFailure("Recording exceeds the 25 MiB audio limit.");
                    await upstream.SendAsync(frame.Bytes, WebSocketMessageType.Binary, true, lifetime.Token); continue;
                }
                var control = Parse(frame.Bytes); var type = String(control["type"]);
                JsonObject forwarded;
                if (type == "start")
                {
                    if (Interlocked.CompareExchange(ref phase, 1, 0) != 0) throw new StreamFailure("Speech stream controls are out of order.");
                    forwarded = new JsonObject { ["type"] = "start" };
                    foreach (var field in new[] { "context", "language" })
                    {
                        var text = String(control[field], optional: true)?.Trim();
                        if (text is null) continue;
                        forwarded[field] = text;
                    }
                    lifetime.CancelAfter(TimeSpan.FromSeconds(10));
                }
                else if (type == "stop")
                {
                    if (Interlocked.CompareExchange(ref phase, 3, 2) != 2) throw new StreamFailure("Speech stream controls are out of order.");
                    lifetime.CancelAfter(TimeSpan.FromSeconds(30)); forwarded = new JsonObject { ["type"] = "stop" };
                }
                else if (type == "ping") forwarded = new JsonObject { ["type"] = "ping" };
                else throw new StreamFailure("Speech stream control is invalid.");
                await SendAsync(upstream, forwarded, lifetime.Token);
            }
        }
        async Task ServiceToClient()
        {
            while (true)
            {
                var frame = await ReceiveAsync(upstream, 0, FrameLimit, lifetime.Token);
                if (frame is null) throw new StreamFailure("Speech connection closed before final transcription.");
                if (frame.Type != WebSocketMessageType.Text || Interlocked.Add(ref outputBytes, frame.Bytes.Length) > OutputLimit) throw new StreamFailure("Speech output exceeds the supported limit.");
                var body = Parse(frame.Bytes); var type = String(body["type"]);
                if (type == "ready")
                {
                    if (Interlocked.CompareExchange(ref phase, 2, 1) != 1) throw new StreamFailure("Speech service response is out of order.");
                    lifetime.CancelAfter(TimeSpan.FromMinutes(10));
                    await SendAsync(downstream, new JsonObject { ["type"] = "ready" }, lifetime.Token);
                }
                else if (type is "partial" or "final")
                {
                    if (Volatile.Read(ref phase) is not (2 or 3)) throw new StreamFailure("Speech service response is out of order.");
                    var transcript = Transcript(body, SafeText(String(body["text"])!)); transcript["type"] = type;
                    await SendAsync(downstream, transcript, lifetime.Token);
                    if (type == "final") { Volatile.Write(ref phase, 4); completedFinal = true; return; }
                }
                else if (type == "error") throw new StreamFailure(ServiceError);
                else if (type == "pong") await SendAsync(downstream, new JsonObject { ["type"] = "pong" }, lifetime.Token);
                else throw new StreamFailure("Speech service response is invalid.");
            }
        }
        var fromClient = ClientToService(); var fromService = ServiceToClient();
        try { await await Task.WhenAny(fromClient, fromService); }
        catch (Exception error) when (error is StreamFailure or JsonException or DecoderFallbackException or WebSocketException or OperationCanceledException)
        {
            if (!context.RequestAborted.IsCancellationRequested && !stopped.IsCancellationRequested && downstream.State == WebSocketState.Open)
            {
                var message = error is StreamFailure failure ? failure.Message : error is OperationCanceledException
                    ? Volatile.Read(ref phase) switch { 0 or 1 => "Speech service did not become ready in time.", 2 => "Recording reached the ten-minute limit.", _ => "Final transcription timed out." }
                    : "Speech connection failed. Try again.";
                using var close = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                try { await SendAsync(downstream, new JsonObject { ["type"] = "error", ["error"] = message }, close.Token); } catch (Exception sendError) when (sendError is WebSocketException or OperationCanceledException) { }
            }
        }
        finally
        {
            using var close = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            if (downstream.State is WebSocketState.Open or WebSocketState.CloseReceived)
                try { await downstream.CloseOutputAsync(completedFinal || downstream.State == WebSocketState.CloseReceived ? WebSocketCloseStatus.NormalClosure : WebSocketCloseStatus.InternalServerError, completedFinal ? "Transcription complete" : "Speech stream closed", close.Token); } catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
            // Let the single downstream receive pump finish the close exchange
            // before cancellation can abort it and discard an already sent result.
            if (!fromClient.IsCompleted && downstream.State == WebSocketState.CloseSent)
                try { await fromClient.WaitAsync(close.Token); } catch (Exception error) when (error is StreamFailure or JsonException or DecoderFallbackException or WebSocketException or OperationCanceledException) { }
            lifetime.Cancel(); upstream.Abort();
            try { await Task.WhenAll(fromClient, fromService); } catch (Exception error) when (error is StreamFailure or JsonException or DecoderFallbackException or WebSocketException or OperationCanceledException) { }
        }
    }
    private static string? String(JsonNode? node, bool optional = false)
    {
        if (node is null && optional) return null;
        return node is JsonValue value && value.TryGetValue<string>(out var text) ? text : throw new StreamFailure("Speech stream payload is invalid.");
    }
    private static JsonObject Parse(byte[] bytes)
    { return JsonNode.Parse(new UTF8Encoding(false, true).GetString(bytes)) as JsonObject ?? throw new StreamFailure("Speech stream payload is invalid."); }
    private static Task SendAsync(WebSocket socket, JsonObject body, CancellationToken token)
        => socket.SendAsync(Encoding.UTF8.GetBytes(body.ToJsonString()), WebSocketMessageType.Text, true, token);
    private static async Task<Frame?> ReceiveAsync(WebSocket socket, long binaryLimit, int textLimit, CancellationToken token)
    {
        using var output = new MemoryStream(); var buffer = new byte[8192]; WebSocketMessageType? type = null;
        while (true)
        {
            var frame = await socket.ReceiveAsync(buffer, token);
            if (frame.MessageType == WebSocketMessageType.Close) return null;
            type ??= frame.MessageType;
            if (frame.MessageType != type || output.Length + frame.Count > (type == WebSocketMessageType.Text ? textLimit : binaryLimit)) throw new StreamFailure("Speech frame is too large or invalid.");
            output.Write(buffer, 0, frame.Count);
            if (frame.EndOfMessage) return new(type.Value, output.ToArray());
        }
    }
}
