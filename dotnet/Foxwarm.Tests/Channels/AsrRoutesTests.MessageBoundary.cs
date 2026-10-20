using System.Net.WebSockets;
using System.Text;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    private const int StreamMessageLimit = 100 * 1024 * 1024;

    [Fact]
    public async Task Oversized_browser_message_cancels_a_pending_upstream_handshake()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var token = timeout.Token;
        await using var f = await Fixture.Create();
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
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
        await admitted.Task.WaitAsync(token);
        await TransmitMessages(client, [StreamMessageLimit + 1], true, false, token);
        await cancelled.Task.WaitAsync(token);
    }

    [Theory]
    [InlineData(true, -1, true, false)]
    [InlineData(false, -1, true, false)]
    [InlineData(true, 0, true, false)]
    [InlineData(false, 0, true, false)]
    [InlineData(true, 0, true, true)]
    [InlineData(false, 0, true, true)]
    [InlineData(true, 0, false, false)]
    [InlineData(false, 0, false, false)]
    [InlineData(true, 1, true, false)]
    [InlineData(false, 1, true, false)]
    [InlineData(true, 1, false, false)]
    [InlineData(false, 1, false, false)]
    public async Task Stream_admits_at_most_100_MiB_per_complete_message_in_both_directions(
        bool fromBrowser,
        int extraBytes,
        bool fragmented,
        bool emptyEnd
    )
    {
        var size = StreamMessageLimit + extraBytes;
        var observed = await BoundaryTraffic(fromBrowser, [size], fragmented, emptyEnd);
        Assert.Equal(size <= StreamMessageLimit ? new long[] { size } : [], observed.Complete);
        // Streaming peers may see an incomplete prefix. It is not a delivered message or rollback.
        Assert.InRange(observed.IncompleteBytes, 0, StreamMessageLimit);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Stream_message_budget_resets_and_does_not_limit_a_recording(bool fromBrowser)
    {
        long[] sizes = [60 * 1024 * 1024, 60 * 1024 * 1024, 0, 7];
        var observed = await BoundaryTraffic(fromBrowser, sizes, true, false);
        Assert.Equal(sizes, observed.Complete);
        Assert.Equal(0, observed.IncompleteBytes);
    }

    private sealed record MessageSizes(long[] Complete, long IncompleteBytes);

    private static async Task<MessageSizes> BoundaryTraffic(
        bool fromBrowser,
        long[] sizes,
        bool fragmented,
        bool emptyEnd
    )
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        var token = timeout.Token;
        await using var f = await Fixture.Create();
        var observed = new TaskCompletionSource<MessageSizes>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var serviceFinished = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        f.Stream = async (socket, context) =>
        {
            try
            {
                if (fromBrowser)
                    observed.TrySetResult(await ObserveMessages(socket, token));
                else
                    await TransmitMessages(socket, sizes, fragmented, emptyEnd, token);
                serviceFinished.TrySetResult();
            }
            catch (Exception error)
            {
                observed.TrySetException(error);
                serviceFinished.TrySetException(error);
                throw;
            }
        };
        using var client = await f.Connect();
        if (fromBrowser)
            await TransmitMessages(client, sizes, fragmented, emptyEnd, token);
        else
            observed.TrySetResult(await ObserveMessages(client, token));
        await serviceFinished.Task.WaitAsync(token);
        return await observed.Task.WaitAsync(token);
    }

    private static async Task<MessageSizes> ObserveMessages(WebSocket socket, CancellationToken token)
    {
        var buffer = new byte[64 * 1024];
        var complete = new List<long>();
        long size = 0;
        try
        {
            while (true)
            {
                var frame = await socket.ReceiveAsync(buffer, token);
                if (frame.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, token);
                    break;
                }
                Assert.Equal(WebSocketMessageType.Binary, frame.MessageType);
                size += frame.Count;
                if (frame.EndOfMessage)
                {
                    complete.Add(size);
                    size = 0;
                    await socket.SendAsync(new byte[] { 5 }, WebSocketMessageType.Binary, true, token);
                }
            }
        }
        catch (WebSocketException)
        {
            // Rejection need not complete a particular close handshake.
        }
        return new(complete.ToArray(), size);
    }

    private static async Task TransmitMessages(
        WebSocket socket,
        long[] sizes,
        bool fragmented,
        bool emptyEnd,
        CancellationToken token
    )
    {
        var chunk = new byte[fragmented ? 1024 * 1024 : (int)sizes.Max()];
        var acknowledgement = new byte[1];
        try
        {
            foreach (var size in sizes)
            {
                long sent = 0;
                do
                {
                    var count = (int)Math.Min(chunk.Length, size - sent);
                    sent += count;
                    await socket.SendAsync(
                        chunk.AsMemory(0, count),
                        WebSocketMessageType.Binary,
                        sent == size && !emptyEnd,
                        token
                    );
                } while (sent < size);
                if (emptyEnd)
                    await socket.SendAsync(ReadOnlyMemory<byte>.Empty, WebSocketMessageType.Binary, true, token);
                var reply = await socket.ReceiveAsync(acknowledgement, token);
                if (reply.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, token);
                    return;
                }
                Assert.True(reply.EndOfMessage);
                Assert.Equal(1, reply.Count);
                Assert.Equal(5, acknowledgement[0]);
            }
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, token);
        }
        catch (WebSocketException)
        {
            // The receiver's complete-message observations, not a chosen close code, are the contract.
        }
    }

    [Fact]
    public async Task Opaque_messages_queued_before_connect_keep_types_and_order()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var token = timeout.Token;
        await using var f = await Fixture.Create();
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.BeforeStream = async context =>
        {
            admitted.TrySetResult();
            await release.Task.WaitAsync(context.RequestAborted);
        };
        f.Stream = async (socket, context) =>
        {
            while (await Receive(socket, context.RequestAborted) is { } message)
                await socket.SendAsync(message.Bytes, message.Type, true, context.RequestAborted);
        };
        using var client = await f.Connect();
        await admitted.Task.WaitAsync(token);
        await client.SendAsync(Encoding.UTF8.GetBytes("opa"), WebSocketMessageType.Text, false, token);
        await client.SendAsync(Encoding.UTF8.GetBytes("que"), WebSocketMessageType.Text, true, token);
        await client.SendAsync(new byte[] { 1, 2, 3 }, WebSocketMessageType.Binary, true, token);
        await client.SendAsync(Encoding.UTF8.GetBytes("after"), WebSocketMessageType.Text, true, token);
        release.TrySetResult();
        var first = (await Receive(client, token))!;
        Assert.Equal(WebSocketMessageType.Text, first.Type);
        Assert.Equal("opaque", Encoding.UTF8.GetString(first.Bytes));
        var second = (await Receive(client, token))!;
        Assert.Equal(WebSocketMessageType.Binary, second.Type);
        Assert.Equal(new byte[] { 1, 2, 3 }, second.Bytes);
        var third = (await Receive(client, token))!;
        Assert.Equal(WebSocketMessageType.Text, third.Type);
        Assert.Equal("after", Encoding.UTF8.GetString(third.Bytes));
        await client.CloseAsync(WebSocketCloseStatus.NormalClosure, null, token);
    }
}
