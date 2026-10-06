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

    public Task EnqueueAsync(string sessionId, QueueItem item) =>
        EnqueueCoreAsync(sessionId, item, false);

    internal Task EnqueueTimerAsync(string sessionId, QueueItem item) =>
        EnqueueCoreAsync(sessionId, item, true);

    private async Task EnqueueCoreAsync(string sessionId, QueueItem item, bool timer)
    {
        EnsureSupported(item);
        var entry = registry.GetRequired(sessionId);
        var admitted = timer
            ? await entry.SaveLane.AdmitTimerAsync(item).ConfigureAwait(false)
            : await entry.SaveLane.AdmitAsync(item, SaveKind.BestEffort).ConfigureAwait(false);
        if (
            admitted
            && entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)
        )
            registry.Trigger(sessionId);
    }

    internal static void EnsureSupportedForRunner(QueueItem item) => EnsureSupported(item);

    private static void EnsureSupported(QueueItem item)
    {
        if (item.Type is QueueItemType.CompactCommit)
            throw new UnsupportedSessionTurnException("compact");
        if (item.Type is QueueItemType.Tools)
            throw new UnsupportedSessionTurnException("tools");
        if (item.Type is QueueItemType.Retry)
            throw new UnsupportedSessionTurnException("retry");
        if (item.Type is QueueItemType.Wait)
            throw new UnsupportedSessionTurnException("waits");
        if (item.Type is QueueItemType.Managed)
            throw new UnsupportedSessionTurnException("managed state");
        if (item.Type is QueueItemType.Channel)
            throw new UnsupportedSessionTurnException("channel delivery");
    }
}
