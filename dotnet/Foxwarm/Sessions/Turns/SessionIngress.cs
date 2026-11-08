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
        EnqueueCoreAsync(
            sessionId,
            item,
            (entry, admitted) => entry.SaveLane.AdmitAsync(admitted, SaveKind.BestEffort)
        );

    internal Task EnqueueCheckedAsync(string sessionId, QueueItem item, Action beforeAdmission) =>
        EnqueueCoreAsync(
            sessionId,
            item,
            (entry, admitted) =>
                entry.SaveLane.AdmitAsync(admitted, SaveKind.BestEffort, beforeAdmission)
        );

    internal Task EnqueueExternalAsync(string sessionId, QueueItem item, Action beforeAdmission) =>
        EnqueueCoreAsync(
            sessionId,
            item,
            (entry, admitted) =>
                entry.SaveLane.AdmitAsync(admitted, SaveKind.Strict, beforeAdmission)
        );

    internal Task EnqueueTimerAsync(string sessionId, QueueItem item) =>
        EnqueueCoreAsync(
            sessionId,
            item,
            (entry, admitted) => entry.SaveLane.AdmitTimerAsync(admitted)
        );

    /// <summary>
    /// Strict external admission. Returns false when the delivery receipt was already accepted.
    /// A non-waking delivery comes only from administrator configuration and waits for the
    /// Session's next turn.
    /// </summary>
    internal Task<bool> EnqueueWebhookAsync(
        string sessionId,
        QueueItem item,
        string? receipt,
        Action beforeAdmission,
        bool wake = true,
        Func<IReadOnlyList<QueueItem>, QueueItem, QueueItem?>? shape = null
    ) =>
        EnqueueCoreAsync(
            sessionId,
            item,
            (entry, admitted) =>
                entry.SaveLane.AdmitWebhookAsync(admitted, receipt, beforeAdmission, shape),
            wake
        );

    private async Task<bool> EnqueueCoreAsync(
        string sessionId,
        QueueItem item,
        Func<SessionEntry, QueueItem, Task<bool>> admit,
        bool trigger = true
    )
    {
        EnsureSupported(item);
        // Model/channel callers cannot smuggle the trusted passive marker through ingress.
        item = item with
        {
            Trigger = trigger,
        };
        var entry = registry.GetRequired(sessionId);
        var admitted = await admit(entry, item).ConfigureAwait(false);
        if (
            admitted
            && !entry.WithState(state => state.Busy || state.Stopping)
            && registry.HasRunnableWork(entry)
        )
            registry.Trigger(sessionId);
        return admitted;
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
