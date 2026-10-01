using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class SessionControl
{
    private readonly SessionRegistry registry;
    public SessionControl(SessionRegistry registry) => this.registry = registry;

    public async Task<StopResult> StopAsync(string sessionId)
    {
        var entry = registry.GetRequired(sessionId);
        var handle = entry.BeginStop();
        var aborted = handle is not null;
        if (handle is not null)
        {
            handle.Cancel();
            handle.Dispose();
        }
        await entry.SaveLane.ClearWaitAsync();
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        return new StopResult(aborted, true);
    }

    public async Task<DequeueResult> DequeueAsync(string sessionId)
    {
        var entry = registry.GetRequired(sessionId);
        var snapshot = entry.Snapshot();
        var count = snapshot.Queue.Count(SessionCompactor.Ordinary);
        if (count == 0) return new(0, false, false);
        if (!snapshot.Busy) { registry.Trigger(sessionId); return new(count, false, false); }
        var handle = entry.BeginStop(runQueued: true);
        if (handle is not null) { handle.Cancel(); handle.Dispose(); }
        await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        return new(count, true, handle is not null);
    }
}

public sealed record StopResult(bool AbortedInFlight, bool StoppedCurrent);
public sealed record DequeueResult(int QueuedItems, bool StoppedCurrent, bool AbortedInFlight);
