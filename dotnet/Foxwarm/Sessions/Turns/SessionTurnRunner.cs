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
                    if (await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false)) continue;
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                await host.SafePointAsync().ConfigureAwait(false);
                if (retryPending)
                {
                    retryPending = false;
                    await entry.SaveLane.ClearWaitAsync().ConfigureAwait(false);
                    if (registry.OnTurnStarting is not null) await registry.OnTurnStarting(entry).ConfigureAwait(false);
                }
                else
                {
                    if (!entry.WithState(state => state.Queue.Any(SessionCompactor.Ordinary))) break;
                    if (registry.OnTurnStarting is not null) await registry.OnTurnStarting(entry).ConfigureAwait(false);
                    await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
                    await host.SafePointAsync().ConfigureAwait(false);
                    var batch = DrainLeading(entry);
                    if (batch.Count == 0) break;
                    await host.AppendQueuedInputsAsync(batch).ConfigureAwait(false);
                }
                try
                {
                    var result = await host.ChatAsync(Guid.NewGuid().ToString()).ConfigureAwait(false);
                    if ((result.AssistantMessage is not null || result.Usage is not null) && registry.OnTurnCompleted is not null)
                        await registry.OnTurnCompleted(entry, result).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (entry.WithState(state => state.Stopping))
                {
                    if (await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false)) continue;
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
                if (!failed && entry.WithState(state => !state.Busy) && registry.HasRunnableWork(entry)) registry.Trigger(sessionId);
            }
        }
    }

    internal static IReadOnlyList<QueueItem> DrainLeading(SessionEntry entry)
    {
        return entry.WithState(state =>
        {
            return (IReadOnlyList<QueueItem>)state.Queue.Where(SessionCompactor.Ordinary).ToArray();
        });
    }

    private static async Task<bool> ResumeQueuedOverrideAsync(SessionEntry entry)
    {
        var resume = entry.WithState(state =>
        {
            if (state.Meta["runQueuedAfterStop"]?.GetValue<bool>() != true) return false;
            state.Meta.Remove("runQueuedAfterStop"); state.Stopping = false;
            return true;
        });
        if (resume) await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        return resume;
    }
}
