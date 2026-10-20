using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Models;

internal enum WsPhase
{
    Active,
    Pending,
    Idle,
    Closed,
}

internal sealed class ResponsesWsResource(
    ResponsesWsTransport owner,
    ClientWebSocket socket,
    string id,
    HttpMessageInvoker invoker
)
{
    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private CancellationTokenRegistration callerAbort;
    private WsLease? lease;
    private WsPhase phase = WsPhase.Active;
    private Task pump = Task.CompletedTask;
    private int disposed;
    private long frames,
        frameBytes;
    private DateTimeOffset? sent,
        firstFrame;
    internal string? SessionId;
    internal string Purpose = "low-level";
    internal int FullItems,
        SentItems;
    internal string ConnectionMode = "fresh";

    internal JsonObject Summary()
    {
        var now = owner.Clock.GetUtcNow();
        lock (gate)
        {
            var fields = new JsonObject
            {
                ["purpose"] = Purpose,
                ["connectionMode"] = ConnectionMode,
                ["requestInputItemCount"] = FullItems,
                ["sentInputItemCount"] = SentItems,
                ["frameCount"] = frames,
                ["frameBytes"] = frameBytes,
            };
            if (SessionId is not null)
                fields["sessionId"] = SessionId;
            if (sent is DateTimeOffset start)
            {
                fields["elapsedSinceCreateMs"] = Math.Max(0, (now - start).TotalMilliseconds);
                if (firstFrame is DateTimeOffset first)
                    fields["firstFrameElapsedMs"] = Math.Max(0, (first - start).TotalMilliseconds);
            }
            return fields;
        }
    }

    internal void MarkSent()
    {
        var now = owner.Clock.GetUtcNow();
        lock (gate)
        {
            sent = now;
            firstFrame = null;
            frames = 0;
            frameBytes = 0;
        }
    }

    internal ClientWebSocket Socket => socket;
    internal string Id => id;
    internal WsPhase Phase
    {
        get
        {
            lock (gate)
                return phase;
        }
    }
    internal Task Pump => pump;

    internal void StartPump() => pump = ReceiveAsync();

    internal WsLease Begin(
        ResponsesStreamCallbacks callbacks,
        CancellationToken caller,
        Action completed
    )
    {
        var value = new WsLease(new ResponsesEventAccumulator(callbacks), completed, callbacks);
        lock (gate)
        {
            if (phase == WsPhase.Closed || socket.State != WebSocketState.Open)
                throw new IOException("OpenAI Responses WebSocket is no longer open.");
            phase = WsPhase.Active;
            lease = value;
        }
        var registration = caller.Register(() => Abort("caller-abort"));
        var keep = false;
        lock (gate)
        {
            if (ReferenceEquals(lease, value) && phase != WsPhase.Closed)
            {
                callerAbort = registration;
                keep = true;
            }
        }
        if (!keep)
            registration.Dispose();
        return value;
    }

    internal bool Release(WsLease value)
    {
        CancellationTokenRegistration registration;
        lock (gate)
        {
            if (
                phase != WsPhase.Pending
                || !ReferenceEquals(lease, value)
                || socket.State != WebSocketState.Open
            )
                return false;
            phase = WsPhase.Idle;
            lease = null;
            registration = callerAbort;
            callerAbort = default;
        }
        registration.Dispose();
        return true;
    }

    internal void Abort(string cause)
    {
        WsLease? active;
        CancellationTokenRegistration registration;
        lock (gate)
        {
            if (phase == WsPhase.Closed)
                return;
            phase = WsPhase.Closed;
            active = lease;
            lease = null;
            registration = callerAbort;
            callerAbort = default;
        }
        owner.Remove(this);
        owner.Log(this, "discard", cause);
        active?.Completion.TrySetException(
            new IOException("OpenAI Responses WebSocket request was interrupted.")
        );
        try
        {
            socket.Abort();
        }
        catch { }
        lifetime.Cancel();
        registration.Dispose();
        if (pump.IsCompleted)
            DisposeSocket();
    }

    internal async Task CloseIdleAsync(string cause)
    {
        lock (gate)
        {
            if (phase != WsPhase.Idle)
                return;
            phase = WsPhase.Closed;
        }
        owner.Remove(this);
        owner.Log(this, "close", cause, "local", 1000);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30), owner.Clock);
        try
        {
            if (socket.State == WebSocketState.Open)
                await socket
                    .CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "OK", timeout.Token)
                    .ConfigureAwait(false);
            await pump.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch
        {
            try
            {
                socket.Abort();
            }
            catch { }
            lifetime.Cancel();
        }
        finally
        {
            DisposeSocket();
        }
    }

    private async Task ReceiveAsync()
    {
        try
        {
            var buffer = new byte[16384];
            using var message = new MemoryStream();
            while (!lifetime.IsCancellationRequested)
            {
                var result = await socket
                    .ReceiveAsync(buffer.AsMemory(), lifetime.Token)
                    .ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    var before = Phase;
                    owner.Log(
                        this,
                        "close",
                        "upstream-close",
                        "upstream",
                        (int?)socket.CloseStatus
                    );
                    if (before == WsPhase.Idle)
                    {
                        owner.Remove(this);
                        lock (gate)
                            phase = WsPhase.Closed;
                        using var timeout = new CancellationTokenSource(
                            TimeSpan.FromSeconds(30),
                            owner.Clock
                        );
                        if (socket.State == WebSocketState.CloseReceived)
                            await socket
                                .CloseOutputAsync(
                                    WebSocketCloseStatus.NormalClosure,
                                    "OK",
                                    timeout.Token
                                )
                                .ConfigureAwait(false);
                    }
                    else
                        Abort("upstream-close");
                    break;
                }
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage)
                    continue;
                var text = Encoding.UTF8.GetString(
                    message.GetBuffer(),
                    0,
                    checked((int)message.Length)
                );
                message.SetLength(0);
                WsLease? active;
                lock (gate)
                    active = phase == WsPhase.Active ? lease : null;
                if (active is null)
                    continue;
                var receivedAt = owner.Clock.GetUtcNow();
                lock (gate)
                {
                    firstFrame ??= receivedAt;
                    frames++;
                    frameBytes += Encoding.UTF8.GetByteCount(text);
                }
                active.RawFrame(text);
                JsonObject input;
                try
                {
                    input =
                        JsonNode.Parse(text) as JsonObject
                        ?? throw new IOException("Invalid event object.");
                }
                catch (Exception error)
                {
                    throw new ResponsesStreamException(
                        ResponsesStreamErrorCategory.MalformedSseEventJson,
                        "OpenAI Responses WebSocket received a malformed JSON frame.",
                        error
                    );
                }
                active.Accumulator.Consume(input);
                if (!active.Accumulator.HasCompletedResponse)
                    continue;
                var response = active.Accumulator.CompleteAtEof();
                var pending = false;
                lock (gate)
                {
                    if (phase == WsPhase.Active && ReferenceEquals(lease, active))
                    {
                        phase = WsPhase.Pending;
                        pending = true;
                    }
                }
                if (pending)
                {
                    active.Completed();
                    active.Completion.TrySetResult(response);
                }
            }
        }
        catch (Exception error)
        {
            WsLease? active;
            lock (gate)
                active = lease;
            active?.Completion.TrySetException(error);
            Abort("receive-failure");
        }
        finally
        {
            DisposeSocket();
        }
    }

    private void DisposeSocket()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
            return;
        try
        {
            socket.Dispose();
        }
        catch { }
        invoker.Dispose();
        owner.Unregister(this);
    }
}

internal sealed class WsLease(
    ResponsesEventAccumulator accumulator,
    Action completed,
    ResponsesStreamCallbacks callbacks
)
{
    internal ResponsesEventAccumulator Accumulator { get; } = accumulator;
    internal Action Completed { get; } = completed;

    internal void RawFrame(string text)
    {
        callbacks.OnDecodedChunk?.Invoke(text + "\n");
        callbacks.OnSseBlock?.Invoke(text);
    }

    internal TaskCompletionSource<JsonObject> Completion { get; } =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
