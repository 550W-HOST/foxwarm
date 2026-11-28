using System.Diagnostics.CodeAnalysis;
using System.Threading.Channels;

namespace Foxwarm.Sessions;

// One SSE listener. Only its sender dequeues; an overflow discards that listener's
// queued events and wakes its blocked HTTP write without running user I/O on the publisher.
internal sealed class SseSubscription(int limit, Action? onDrop) : ChannelReader<SessionRuntimeEvent>
{
    private readonly Channel<(SessionRuntimeEvent Event, int Bytes)> queue = Channel.CreateUnbounded<(SessionRuntimeEvent, int)>();
    private readonly object gate = new();
    private int backlog;
    private bool closed;

    internal bool Offer(SessionRuntimeEvent item, int bytes)
    {
        lock (gate)
        {
            if (closed) return false;
            if (bytes <= limit - backlog)
            {
                backlog += bytes;
                return queue.Writer.TryWrite((item, bytes));
            }
            closed = true;
            while (queue.Reader.TryRead(out _)) { }
            queue.Writer.TryComplete();
        }
        onDrop?.Invoke();
        return false;
    }

    internal void Close()
    {
        lock (gate) { closed = true; queue.Writer.TryComplete(); }
    }

    public override Task Completion => queue.Reader.Completion;
    public override ValueTask<bool> WaitToReadAsync(CancellationToken token = default) => queue.Reader.WaitToReadAsync(token);
    public override bool TryRead([NotNullWhen(true)] out SessionRuntimeEvent? item)
    {
        lock (gate)
        {
            if (queue.Reader.TryRead(out var entry))
            {
                backlog -= entry.Bytes;
                item = entry.Event;
                return true;
            }
            item = null;
            return false;
        }
    }
}
