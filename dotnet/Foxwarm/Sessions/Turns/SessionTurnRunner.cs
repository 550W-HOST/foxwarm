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

    private readonly object lifecycle = new();
    private readonly Dictionary<SessionEntry, TaskCompletionSource> processors = new();
    private volatile bool closing;
    private Task? shutdown;

    internal bool Closing => closing;

    internal void CloseAdmission()
    {
        lock (lifecycle)
            closing = true;
    }

    internal void AssertCanContinue()
    {
        if (closing)
            throw new SessionTurnShutdownException();
    }

    internal Task ShutdownAsync(TimeSpan? grace = null, TimeSpan? cancellation = null)
    {
        lock (lifecycle)
        {
            closing = true;
            return shutdown ??= DrainAsync(
                processors.Values.Select(value => value.Task).ToArray(),
                grace ?? TimeSpan.FromSeconds(5),
                cancellation ?? TimeSpan.FromSeconds(5)
            );
        }
    }

    private async Task DrainAsync(Task[] accepted, TimeSpan grace, TimeSpan cancellation)
    {
        var settled = Task.WhenAll(accepted);
        try
        {
            await settled.WaitAsync(grace).ConfigureAwait(false);
            return;
        }
        catch (TimeoutException) { }
        SessionEntry[] current;
        lock (lifecycle)
            current = processors.Keys.ToArray();
        foreach (var entry in current)
            entry.CancelForShutdown();
        try
        {
            await settled.WaitAsync(cancellation).ConfigureAwait(false);
        }
        catch (TimeoutException error)
        {
            throw new SessionTurnDrainException(error);
        }
    }

    public async Task ProcessQueueAsync(string sessionId, bool retry = false)
    {
        var entry = registry.GetRequired(sessionId);
        if (closing)
        {
            if (retry)
                throw new SessionTurnShutdownException();
            return;
        }
        var admission = entry.AdmitMutation();
        TaskCompletionSource? settled = null;
        try
        {
            lock (lifecycle)
            {
                if (closing)
                {
                    if (retry)
                        throw new SessionTurnShutdownException();
                }
                else if (entry.TryClaimAdmittedProcessor())
                {
                    settled = new(TaskCreationOptions.RunContinuationsAsynchronously);
                    processors.Add(entry, settled);
                }
                else if (retry)
                    throw new InvalidOperationException("Session is already running.");
            }
        }
        catch
        {
            admission?.Dispose();
            throw;
        }
        if (settled is null)
        {
            admission?.Dispose();
            return;
        }
        admission?.Dispose();
        await RunProcessorAsync(sessionId, entry, settled, retry).ConfigureAwait(false);
    }

    private async Task RunProcessorAsync(
        string sessionId,
        SessionEntry entry,
        TaskCompletionSource settled,
        bool retry
    )
    {
        var turnScope = entry.EnterTurnScope();
        var claimed = false;
        var failed = false;
        var interrupted = false;
        var turnSelected = retry;
        try
        {
            if (retry)
                entry.WithState(state =>
                {
                    if (state.Busy || state.Stopping)
                        throw new InvalidOperationException("Session is already running.");
                    if (SessionRuntimeState.WaitProjection(state.Meta) is not null)
                        throw new SessionContinuationUnavailableException(
                            "Session is waiting and cannot be continued manually."
                        );
                    if (!SessionContinuation.IsIncomplete(state.History))
                        throw new SessionContinuationUnavailableException();
                });
            var host = hosts.For(entry);
            claimed = await host.TryClaimBusyAsync().ConfigureAwait(false);
            if (!claimed)
                return;
            var retryPending = retry;
            while (true)
            {
                if (entry.WithState(state => state.Stopping))
                {
                    if (await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false))
                    {
                        AssertCanContinue();
                        continue;
                    }
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                AssertCanContinue();
                await host.SafePointAsync().ConfigureAwait(false);
                if (retryPending)
                {
                    retryPending = false;
                    await entry.SaveLane.ClearWaitAsync().ConfigureAwait(false);
                    if (registry.OnTurnStarting is not null)
                        await registry.OnTurnStarting(entry).ConfigureAwait(false);
                }
                else
                {
                    if (
                        entry.WithState(state => SessionWait.Current(state.Meta) is not null)
                        && !registry.HasRunnableWork(entry)
                    )
                        break;
                    if (!entry.WithState(state => state.Queue.Any(SessionCompactor.Ordinary)))
                        break;
                    if (registry.OnTurnStarting is not null)
                        await registry.OnTurnStarting(entry).ConfigureAwait(false);
                    await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
                    await host.SafePointAsync().ConfigureAwait(false);
                    AssertCanContinue();
                    var batch = DrainLeading(entry);
                    if (batch.Count == 0)
                        break;
                    turnSelected = true;
                    await host.AppendQueuedInputsAsync(batch).ConfigureAwait(false);
                }
                AssertCanContinue();
                try
                {
                    var result = await host.ChatAsync(Guid.NewGuid().ToString())
                        .ConfigureAwait(false);
                    if (
                        (result.AssistantMessage is not null || result.Usage is not null)
                        && !closing
                        && registry.OnTurnCompleted is not null
                    )
                        await registry.OnTurnCompleted(entry, result).ConfigureAwait(false);
                    turnSelected = false;
                    if (result.Terminal || closing)
                        break;
                }
                catch (OperationCanceledException) when (entry.WithState(state => state.Stopping))
                {
                    if (await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false))
                    {
                        AssertCanContinue();
                        // Retry preparation may have committed the selected inputs before Run queued canceled it.
                        retryPending = entry.WithState(state =>
                            !state.Queue.Any(SessionCompactor.Ordinary)
                            && SessionContinuation.IsIncomplete(state.History)
                        );
                        continue;
                    }
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                    claimed = false;
                    break;
                }
                catch (SessionTurnShutdownException)
                {
                    interrupted = true;
                    break;
                }
                catch (OperationCanceledException)
                    when (closing && entry.ShutdownCancellationRequested)
                {
                    interrupted = true;
                    break;
                }
                catch (Foxwarm.Tools.ToolAuthorizationUnavailableException error)
                {
                    failed = true; // This terminal outcome must not immediately consume/retrigger queued work.
                    entry.RecordBackgroundProcessorFailure(error);
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
                    failed = error is Foxwarm.Models.ModelPreparationException;
                    entry.RecordBackgroundProcessorFailure(error);
                    break;
                }
            }
        }
        catch (SessionTurnShutdownException)
        {
            if (
                claimed
                && entry.WithState(state => state.Stopping)
                && !await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false)
            )
            {
                await hosts.For(entry).FinalizeStoppedAsync().ConfigureAwait(false);
                claimed = false;
            }
            else
                interrupted = claimed && turnSelected;
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
                if (claimed && !interrupted)
                    await hosts.For(entry).ReleaseBusyAsync().ConfigureAwait(false);
            }
            catch
            {
                failed = true;
                throw;
            }
            finally
            {
                entry.ReleaseProcessor();
                lock (lifecycle)
                    processors.Remove(entry);
                try
                {
                    if (
                        !closing
                        && !failed
                        && entry.WithState(state => !state.Busy)
                        && registry.HasRunnableWork(entry)
                    )
                        registry.Trigger(sessionId);
                }
                finally
                {
                    turnScope.Dispose();
                    settled.TrySetResult();
                }
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
        entry.WithState(state => DeferredQueueInput.Mark(state.Queue));
        var resume = entry.WithState(state =>
        {
            if (state.Meta["runQueuedAfterStop"]?.GetValue<bool>() != true)
                return false;
            state.Meta.Remove("runQueuedAfterStop");
            state.Stopping = false;
            return true;
        });
        if (resume)
        {
            await entry.SaveLane.ClearWaitAsync().ConfigureAwait(false);
            await entry.SaveLane.SaveBestEffortAsync().ConfigureAwait(false);
        }
        return resume;
    }
}
