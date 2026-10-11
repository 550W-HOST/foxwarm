using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace Foxwarm.Terminal;

internal sealed partial class TerminalRegistry
{
    internal sealed partial class TerminalRecord
    {
        internal sealed class TerminalClient : IAsyncDisposable
        {
            private readonly WebSocket socket;
            private readonly ITerminalStreamTarget owner;
            private readonly CancellationTokenSource lifetime;
            private readonly Channel<byte[]> queue = Channel.CreateUnbounded<byte[]>(
                new UnboundedChannelOptions { SingleReader = true, SingleWriter = false }
            );
            private readonly object sendGate = new();
            private int pending;
            private Task? sender;
            private Task? receiver;
            private string? failure;
            private bool completed;
            private int disposed;
            internal bool IsControlOwner { get; }

            internal TerminalClient(
                WebSocket socket,
                ITerminalStreamTarget owner,
                CancellationToken token,
                bool controlOwner
            )
            {
                this.socket = socket;
                this.owner = owner;
                IsControlOwner = controlOwner;
                lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
            }

            internal void Enqueue(object value)
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
                lock (sendGate)
                {
                    if (completed)
                        return;
                    // Keep the in-flight frame charged until SendAsync settles.
                    if (bytes.Length > ClientBudget - pending)
                    {
                        FailLocked("Terminal client is too slow; reconnect to resume.");
                        return;
                    }
                    pending += bytes.Length;
                    queue.Writer.TryWrite(bytes);
                }
            }

            private void FailLocked(string message)
            {
                if (completed)
                    return;
                failure = message;
                completed = true;
                queue.Writer.TryComplete();
                lifetime.Cancel();
            }

            internal async Task StartAsync()
            {
                sender = SendLoopAsync();
                receiver = ReceiveLoopAsync();
                try
                {
                    await receiver;
                }
                finally
                {
                    lock (sendGate)
                    {
                        completed = true;
                        queue.Writer.TryComplete();
                    }
                    lifetime.Cancel();
                    owner.Detach(this);
                    await sender;
                }
            }

            private async Task SendLoopAsync()
            {
                try
                {
                    await foreach (var bytes in queue.Reader.ReadAllAsync(lifetime.Token))
                    {
                        await socket.SendAsync(
                            bytes,
                            WebSocketMessageType.Text,
                            true,
                            lifetime.Token
                        );
                        lock (sendGate)
                            pending -= bytes.Length;
                    }
                }
                catch (Exception error)
                    when (error
                            is OperationCanceledException
                                or WebSocketException
                                or ObjectDisposedException
                    ) { }
                finally
                {
                    // A blocked sender must not hold the PTY or another client. Best effort
                    // error/close has its own short deadline; abort only this socket if needed.
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                    try
                    {
                        if (socket.State == WebSocketState.Open)
                        {
                            if (failure is not null)
                                await socket.SendAsync(
                                    JsonSerializer.SerializeToUtf8Bytes(
                                        new { type = "error", message = failure }
                                    ),
                                    WebSocketMessageType.Text,
                                    true,
                                    deadline.Token
                                );
                            await socket.CloseOutputAsync(
                                failure is null
                                    ? WebSocketCloseStatus.NormalClosure
                                    : WebSocketCloseStatus.PolicyViolation,
                                failure is null ? "Terminal detached" : "Terminal client detached",
                                deadline.Token
                            );
                        }
                    }
                    catch (Exception error)
                        when (error
                                is OperationCanceledException
                                    or WebSocketException
                                    or ObjectDisposedException
                        )
                    {
                        socket.Abort();
                    }
                    lifetime.Cancel();
                }
            }

            private async Task ReceiveLoopAsync()
            {
                var buffer = new byte[128 * 1024];
                try
                {
                    while (!lifetime.IsCancellationRequested && socket.State == WebSocketState.Open)
                    {
                        var length = 0;
                        WebSocketReceiveResult frame;
                        do
                        {
                            if (length == buffer.Length)
                                throw new InvalidDataException("Terminal message is too large.");
                            frame = await socket.ReceiveAsync(
                                new ArraySegment<byte>(buffer, length, buffer.Length - length),
                                lifetime.Token
                            );
                            if (frame.MessageType == WebSocketMessageType.Close)
                                return;
                            if (frame.MessageType != WebSocketMessageType.Text)
                                throw new InvalidDataException(
                                    "Terminal messages must be JSON text."
                                );
                            length += frame.Count;
                        } while (!frame.EndOfMessage);
                        var node =
                            JsonNode.Parse(buffer.AsSpan(0, length)) as JsonObject
                            ?? throw new InvalidDataException("Invalid terminal message.");
                        switch (node["type"]?.GetValue<string>())
                        {
                            case "input":
                                await owner.InputAsync(node["data"]?.GetValue<string>() ?? "");
                                break;
                            case "resize":
                                await owner.ResizeAsync(
                                    node["cols"]?.GetValue<int>() ?? 0,
                                    node["rows"]?.GetValue<int>() ?? 0
                                );
                                break;
                            case "close":
                                _ = owner.CloseAsync("client");
                                return;
                            case "control-result":
                                owner.ResolveControl(
                                    this,
                                    node["requestId"]?.GetValue<string>() ?? "",
                                    node["ok"]?.GetValue<bool>() ?? false,
                                    node["message"]?.GetValue<string>(),
                                    node["error"]?.GetValue<string>()
                                );
                                break;
                            default:
                                throw new InvalidDataException("Unknown terminal message.");
                        }
                    }
                }
                catch (Exception error)
                    when (error
                            is OperationCanceledException
                                or WebSocketException
                                or ObjectDisposedException
                    ) { }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                                or IOException
                                or ArgumentException
                                or OverflowException
                    )
                {
                    lock (sendGate)
                        FailLocked(error.Message);
                }
            }

            internal async Task FinishAsync()
            {
                lock (sendGate)
                {
                    completed = true;
                    queue.Writer.TryComplete();
                }
                if (sender is not null)
                {
                    try
                    {
                        await sender.WaitAsync(TimeSpan.FromSeconds(1));
                    }
                    catch (TimeoutException)
                    {
                        lifetime.Cancel();
                        socket.Abort();
                        await sender;
                    }
                }
                lifetime.Cancel();
            }

            public async ValueTask DisposeAsync()
            {
                if (Interlocked.Exchange(ref disposed, 1) != 0)
                    return;
                lifetime.Cancel();
                queue.Writer.TryComplete();
                if (sender is not null)
                    await sender;
                socket.Dispose();
                lifetime.Dispose();
            }
        }
    }
}
