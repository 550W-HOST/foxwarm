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
    private long turnSequence;

    internal SessionTurnRunner(SessionRegistry registry, LocalSessionTurnHostFactory hosts)
    {
        this.registry = registry;
        this.hosts = hosts;
    }

    public async Task ProcessQueueAsync(string sessionId)
    {
        var entry = registry.GetRequired(sessionId);
        if (!entry.TryClaimProcessor()) return;
        var claimed = false;
        var failed = false;
        try
        {
            var host = hosts.For(entry);
            claimed = await host.TryClaimBusyAsync().ConfigureAwait(false);
            if (!claimed) return;
            while (true)
            {
                if (entry.WithState(state => state.Stopping))
                {
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                if (!entry.WithState(state => state.Queue.Count > 0)) break;
                await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
                var batch = DrainLeading(entry);
                if (batch.Count == 0)
                {
                    var remainingHead = entry.WithState(state => state.Queue.FirstOrDefault()?.CloneItem());
                    if (remainingHead is not null) SessionIngress.EnsureSupportedForRunner(remainingHead);
                    break;
                }
                await host.AppendQueuedInputsAsync(batch).ConfigureAwait(false);
                try
                {
                    var result = await host.ChatAsync($"turn-{Interlocked.Increment(ref turnSequence)}").ConfigureAwait(false);
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
