using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class SessionIngress
{
    private readonly SessionRegistry registry;
    public SessionIngress(SessionRegistry registry) => this.registry = registry;

    public async Task EnqueueAsync(string sessionId, QueueItem item)
    {
        EnsureSupported(item);
        var entry = registry.GetRequired(sessionId);
        entry.WithState(state => state.Queue.Add(item.CloneItem()));
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        if (!entry.WithState(state => state.Busy || state.Stopping)) registry.Trigger(sessionId);
    }

    internal static void EnsureSupportedForRunner(QueueItem item) => EnsureSupported(item);

    private static void EnsureSupported(QueueItem item)
    {
        if (item.Type is QueueItemType.CompactCommit) throw new UnsupportedSessionTurnException("compact");
        if (item.Type is QueueItemType.Tools) throw new UnsupportedSessionTurnException("tools");
        if (item.Type is QueueItemType.Retry) throw new UnsupportedSessionTurnException("retry");
        if (item.Type is QueueItemType.Wait) throw new UnsupportedSessionTurnException("waits");
        if (item.Type is QueueItemType.Managed) throw new UnsupportedSessionTurnException("managed state");
        if (item.Type is QueueItemType.Channel) throw new UnsupportedSessionTurnException("channel delivery");
    }
}
