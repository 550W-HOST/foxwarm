using System.Net.WebSockets;
using System.Threading.Channels;

namespace Foxwarm.Asr;

internal sealed partial class AsrProxy
{
    private sealed record StreamFragment(WebSocketMessageType Type, byte[] Bytes, bool End);

    private async Task StreamAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = 400;
            return;
        }
        using var downstream = await context.WebSockets.AcceptWebSocketAsync();
        if (!Configured)
        {
            await downstream.CloseOutputAsync(
                WebSocketCloseStatus.InternalServerError,
                "ASR service is not configured",
                context.RequestAborted
            );
            return;
        }
        using var upstream = new ClientWebSocket();
        if (!string.IsNullOrEmpty(key))
            upstream.Options.SetRequestHeader("Authorization", "Bearer " + key);
        var endpoint = new UriBuilder(Endpoint("/ws/stream"))
        {
            Scheme = service!.Scheme == "https" ? "wss" : "ws",
        };
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(
            context.RequestAborted,
            stopped
        );
        // As in Source, accept browser messages while the upstream handshake is pending.
        // The receive owner remains active so browser closure also cancels that handshake.
        var pending = Channel.CreateUnbounded<StreamFragment>(
            new UnboundedChannelOptions { SingleReader = true, SingleWriter = true }
        );
        using var downstreamWrites = new SemaphoreSlim(1);
        using var upstreamWrites = new SemaphoreSlim(1);
        async Task ReceiveClient()
        {
            var buffer = new byte[8192];
            while (true)
            {
                var frame = await downstream.ReceiveAsync(buffer, lifetime.Token);
                if (frame.MessageType == WebSocketMessageType.Close)
                    return;
                pending.Writer.TryWrite(new(frame.MessageType, buffer[..frame.Count], frame.EndOfMessage));
            }
        }
        var fromClient = ReceiveClient();
        var connected = upstream.ConnectAsync(endpoint.Uri, http, lifetime.Token);
        async Task SendToService()
        {
            await connected;
            await foreach (var frame in pending.Reader.ReadAllAsync(lifetime.Token))
            {
                await upstreamWrites.WaitAsync(lifetime.Token);
                try
                {
                    await upstream.SendAsync(frame.Bytes, frame.Type, frame.End, lifetime.Token);
                }
                finally { upstreamWrites.Release(); }
            }
        }
        async Task ReceiveService()
        {
            await connected;
            var buffer = new byte[8192];
            while (true)
            {
                var frame = await upstream.ReceiveAsync(buffer, lifetime.Token);
                if (frame.MessageType == WebSocketMessageType.Close)
                    return;
                await downstreamWrites.WaitAsync(lifetime.Token);
                try
                {
                    await downstream.SendAsync(buffer.AsMemory(0, frame.Count), frame.MessageType, frame.EndOfMessage, lifetime.Token);
                }
                finally { downstreamWrites.Release(); }
            }
        }
        var toService = SendToService();
        var fromService = ReceiveService();
        var closeStatus = WebSocketCloseStatus.NormalClosure;
        string? closeReason = null;
        try
        {
            var completed = await Task.WhenAny(fromClient, toService, fromService);
            await completed;
            if (completed == fromService)
            {
                closeStatus = upstream.CloseStatus ?? WebSocketCloseStatus.NormalClosure;
                closeReason = upstream.CloseStatusDescription;
            }
        }
        catch (Exception error) when (error is HttpRequestException or WebSocketException or OperationCanceledException)
        {
            if (!context.RequestAborted.IsCancellationRequested && !stopped.IsCancellationRequested)
            {
                closeStatus = WebSocketCloseStatus.InternalServerError;
                closeReason = "ASR upstream error";
            }
        }
        finally
        {
            // This is only a bounded close handshake, never a recording/finalization deadline.
            using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            async Task CloseOutput(WebSocket socket, SemaphoreSlim writes, WebSocketCloseStatus status, string? reason)
            {
                try
                {
                    await writes.WaitAsync(closing.Token);
                    try
                    {
                        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                            await socket.CloseOutputAsync(status, reason, closing.Token);
                    }
                    finally { writes.Release(); }
                }
                catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
            }
            await Task.WhenAll(
                CloseOutput(downstream, downstreamWrites, closeStatus, closeReason),
                CloseOutput(upstream, upstreamWrites, WebSocketCloseStatus.NormalClosure, null)
            );
            lifetime.Cancel();
            pending.Writer.TryComplete();
            upstream.Abort();
            downstream.Abort();
            try { await Task.WhenAll(fromClient, toService, fromService); }
            catch (Exception error) when (error is HttpRequestException or WebSocketException or OperationCanceledException) { }
        }
    }
}
