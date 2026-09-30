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
}

public sealed record StopResult(bool AbortedInFlight, bool StoppedCurrent);
