using System.Net.ServerSentEvents;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Foxwarm.Tests;

public sealed class McpAttachmentTests
{
    private static Task<bool> Send(
        StreamableHttpServerTransport transport,
        McpAttachedResponseStream stream,
        string text
    ) =>
        stream.SendAsync(() =>
            transport.SendMessageAsync(
                new JsonRpcNotification
                {
                    Method = "notifications/message",
                    Params = new JsonObject { ["level"] = "info", ["data"] = text },
                }
            )
        );

    private static McpAttachedResponseStream.Attachment Attach(
        McpAttachedResponseStream stream,
        Stream body
    )
    {
        var attachment = stream.Attach(body)!;
        Assert.NotNull(attachment);
        Assert.True(stream.Activate(attachment));
        return attachment;
    }

    private static async Task<string[]> Messages(MemoryStream body)
    {
        using var copy = new MemoryStream(body.ToArray());
        var values = new List<string>();
        await foreach (var item in SseParser.Create(copy).EnumerateAsync())
        {
            var notification = JsonSerializer.Deserialize<JsonRpcNotification>(
                item.Data,
                McpJsonUtilities.DefaultOptions
            )!;
            values.Add(notification.Params!["data"]!.GetValue<string>());
        }
        return values.ToArray();
    }

    [Fact]
    public async Task Pinned_official_SDK_writes_complete_Unicode_frames_without_offline_replay_or_unscoped_delivery()
    {
        var stream = new McpAttachedResponseStream();
        await using var transport = new StreamableHttpServerTransport
        {
            SessionId = "attachment-test",
        };
        var get = transport.HandleGetRequestAsync(stream);
        await stream.Ready.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(await Send(transport, stream, "offline"));
        using var first = new CountingStream();
        var attachment = Attach(stream, first);
        var texts = Enumerable
            .Range(0, 8)
            .Select(i => i + ":" + string.Concat(Enumerable.Repeat("🦊漢字é\n\r", 10000)))
            .ToArray();
        await Task.WhenAll(texts.Select(text => Send(transport, stream, text)));
        Assert.Equal(texts.Length, first.Writes);
        Assert.Equal(texts.Order(), (await Messages(first)).Order());
        stream.Detach(attachment);
        await attachment.Drained.Task;
        Assert.Null(attachment.Body);
        Assert.False(await Send(transport, stream, "offline-between"));
        using var second = new CountingStream();
        var successor = Attach(stream, second);
        stream.Detach(attachment);
        await transport.SendMessageAsync(
            new JsonRpcNotification
            {
                Method = "notifications/message",
                Params = new JsonObject { ["data"] = "unscoped" },
            }
        );
        Assert.Equal(0, second.Length);
        await Send(transport, stream, "fresh");
        Assert.Equal(new[] { "fresh" }, await Messages(second));
        Assert.False(get.IsCompleted);
        stream.Detach(successor);
        await stream.StopAsync();
        await transport.DisposeAsync();
        await get.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Theory]
    [InlineData("write")]
    [InlineData("flush")]
    [InlineData("cancel")]
    public async Task Failed_old_write_and_waiting_send_cannot_reach_successor_or_poison_official_writer(
        string failure
    )
    {
        var stream = new McpAttachedResponseStream();
        await using var transport = new StreamableHttpServerTransport
        {
            SessionId = "attachment-failure",
        };
        var get = transport.HandleGetRequestAsync(stream);
        await stream.Ready.Task;
        using var failing = new HeldFailureStream(failure);
        var old = Attach(stream, failing);
        var sending = Send(transport, stream, "partial-old");
        await failing.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var queued = Send(transport, stream, "queued-old");
        stream.Detach(old);
        Assert.Null(old.Body);
        Assert.False(old.Drained.Task.IsCompleted);
        using var fresh = new CountingStream();
        var successor = Attach(stream, fresh);
        failing.Release.TrySetResult();
        await Task.WhenAll(sending, queued).WaitAsync(TimeSpan.FromSeconds(5));
        await old.Drained.Task;
        stream.Detach(old);
        await Send(transport, stream, "new-frame");
        Assert.Equal(new[] { "new-frame" }, await Messages(fresh));
        Assert.Equal(1, fresh.Writes);
        Assert.False(get.IsCompleted);
        stream.Detach(successor);
        using var retiring = new HeldFailureStream("write");
        var retiredAttachment = Attach(stream, retiring);
        var final = Send(transport, stream, "retiring");
        await retiring.Entered.Task;
        stream.Detach(retiredAttachment);
        var stop = stream.StopAsync();
        Assert.False(stop.IsCompleted);
        retiring.Release.TrySetResult();
        await final;
        await stop;
        Assert.Null(retiredAttachment.Body);
        Assert.Null(stream.Attach(new MemoryStream()));
        await transport.DisposeAsync();
        await get.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private sealed class CountingStream : MemoryStream
    {
        internal int Writes;

        public override ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default
        )
        {
            Writes++;
            return base.WriteAsync(buffer, cancellationToken);
        }
    }

    private sealed class HeldFailureStream(string failure) : MemoryStream
    {
        internal TaskCompletionSource Entered = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal TaskCompletionSource Release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default
        )
        {
            await base.WriteAsync(buffer[..Math.Min(buffer.Length, 17)], CancellationToken.None);
            if (failure == "flush")
                return;
            Entered.TrySetResult();
            await Release.Task;
            if (failure == "cancel")
                throw new OperationCanceledException(cancellationToken);
            throw new IOException("Synthetic partial response write.");
        }

        public override async Task FlushAsync(CancellationToken cancellationToken)
        {
            if (failure != "flush")
                return;
            Entered.TrySetResult();
            await Release.Task;
            throw new IOException("Synthetic failed response flush.");
        }
    }
}
