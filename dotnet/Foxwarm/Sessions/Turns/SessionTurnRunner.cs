using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class SessionTurnRunner
{
    private readonly SessionRegistry registry;
    private readonly LocalSessionTurnHostFactory hosts;

    internal SessionTurnRunner(SessionRegistry registry, LocalSessionTurnHostFactory hosts)
    {
        this.registry = registry;
        this.hosts = hosts;
    }

    public async Task ProcessQueueAsync(string sessionId, bool retry = false)
    {
        var entry = registry.GetRequired(sessionId);
        if (!entry.TryClaimProcessor())
        {
            if (retry) throw new InvalidOperationException("Session is already running.");
            return;
        }
        var claimed = false;
        var failed = false;
        try
        {
            if (retry) entry.WithState(state =>
            {
                if (state.Busy || state.Stopping) throw new InvalidOperationException("Session is already running.");
                if (SessionRuntimeState.WaitProjection(state.Meta) is not null) throw new SessionContinuationUnavailableException("Session is waiting and cannot be continued manually.");
                if (!SessionContinuation.IsIncomplete(state.History)) throw new SessionContinuationUnavailableException();
            });
            var host = hosts.For(entry);
            claimed = await host.TryClaimBusyAsync().ConfigureAwait(false);
            if (!claimed) return;
            var retryPending = retry;
            while (true)
            {
                if (entry.WithState(state => state.Stopping))
                {
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                if (retryPending)
                {
                    retryPending = false;
                    await entry.SaveLane.ClearWaitAsync().ConfigureAwait(false);
                    if (registry.OnTurnStarting is not null) await registry.OnTurnStarting(entry).ConfigureAwait(false);
                }
                else
                {
                    if (!entry.WithState(state => state.Queue.Count > 0)) break;
                    await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
                    var batch = DrainLeading(entry);
                    if (batch.Count == 0)
                    {
                        var remainingHead = entry.WithState(state => state.Queue.FirstOrDefault()?.CloneItem());
                        if (remainingHead is not null) SessionIngress.EnsureSupportedForRunner(remainingHead);
                        break;
                    }
                    if (registry.OnTurnStarting is not null) await registry.OnTurnStarting(entry).ConfigureAwait(false);
                    await host.AppendQueuedInputsAsync(batch).ConfigureAwait(false);
                }
                try
                {
                    var result = await host.ChatAsync(Guid.NewGuid().ToString()).ConfigureAwait(false);
                    if (result.AssistantMessage is not null && registry.OnTurnCompleted is not null)
                        await registry.OnTurnCompleted(entry, result).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (entry.WithState(state => state.Stopping))
                {
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                catch (AuthorityCommittedException)
                {
                    throw;
                }
                catch (Exception error)
                {
                    // The current turn does not auto-retry a chat failure, but an HTTP host
                    // must be able to report its terminal outcome rather than imply success.
                    entry.RecordBackgroundProcessorFailure(error);
                    break;
                }
            }
        }
        catch
        {
            failed = true;
            throw;
        }
        finally
        {
            try
            {
                if (claimed) await hosts.For(entry).ReleaseBusyAsync().ConfigureAwait(false);
            }
            finally
            {
                entry.ReleaseProcessor();
                if (!failed && entry.WithState(state => !state.Busy && state.Queue.Count > 0)) registry.Trigger(sessionId);
            }
        }
    }

    internal static IReadOnlyList<QueueItem> DrainLeading(SessionEntry entry)
    {
        return entry.WithState(state =>
        {
            var result = new List<QueueItem>();
            var index = 0;
            while (index < state.Queue.Count)
            {
                var item = state.Queue[index];
                if (item.Type == QueueItemType.CompactCommit) break;
                result.Add(item);
                index++;
            }
            return (IReadOnlyList<QueueItem>)result;
        });
    }
}
