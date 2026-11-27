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

    internal Task ShutdownAsync(
        TimeSpan? grace = null,
        TimeSpan? cancellation = null,
        Action<SessionEntry>? cancelForeground = null
    )
    {
        lock (lifecycle)
        {
            closing = true;
            return shutdown ??= DrainAsync(
                processors.Values.Select(value => value.Task).ToArray(),
                grace ?? TimeSpan.FromSeconds(5),
                cancellation ?? TimeSpan.FromSeconds(5),
                cancelForeground
            );
        }
    }

    private async Task DrainAsync(
        Task[] accepted,
        TimeSpan grace,
        TimeSpan cancellation,
        Action<SessionEntry>? cancelForeground
    )
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
        {
            entry.CancelForShutdown();
            cancelForeground?.Invoke(entry);
        }
        try
        {
            await settled.WaitAsync(cancellation).ConfigureAwait(false);
        }
        catch (TimeoutException error)
        {
            throw new SessionTurnDrainException(error);
        }
    }

    public async Task ProcessQueueAsync(
        string sessionId,
        bool retry = false,
        Action? admitted = null
    )
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
        await RunProcessorAsync(sessionId, entry, settled, retry, admitted).ConfigureAwait(false);
    }

    // Waits for a busy-turn slot under the Session's cancellation registration, so Stop and
    // shutdown cancel the wait as they cancel a running turn; null when either ended it.
    private static async Task<IDisposable?> AdmitTurnAsync(
        SessionEntry entry,
        Func<CancellationToken, ValueTask<IDisposable>> admit
    )
    {
        var waiting = new CancellationTokenSource();
        CancellationHandle handle;
        try
        {
            handle = entry.RegisterCancellation(waiting)!;
        }
        catch (OperationCanceledException)
        {
            waiting.Dispose();
            return null;
        }
        try
        {
            return await admit(handle.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (handle.Token.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            entry.ClearCancellation(handle);
        }
    }

    private async Task RunProcessorAsync(
        string sessionId,
        SessionEntry entry,
        TaskCompletionSource settled,
        bool retry,
        Action? admitted
    )
    {
        var turnScope = entry.EnterTurnScope();
        IDisposable? turnSlot = null;
        var claimed = false;
        var ranTurn = false;
        var failed = false;
        var interrupted = false;
        var turnSelected = retry;
        var suspended = false;
        var llmFailed = false;
        Exception? escapingError = null;
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
                    if (
                        ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope)
                            ? !ClaudeRuntimeState.CanContinue(
                                state.AuthorityEnvelope,
                                state.Queue.Any(SessionCompactor.Ordinary)
                            )
                            : !SessionContinuation.IsIncomplete(state.History)
                    )
                        throw new SessionContinuationUnavailableException();
                });
            var host = hosts.For(entry);
            // The tenant's busy-turn limit, before the busy claim: a waiting Session stays not
            // busy and keeps its queued input; Stop and shutdown end the wait.
            var entered = registry.TurnAdmission is not { } admitTurn
                || (turnSlot = await AdmitTurnAsync(entry, admitTurn).ConfigureAwait(false)) is not null;
            if (turnSlot is not null)
                turnScope.AttachSlot(turnSlot);
            claimed = entered && await host.TryClaimBusyAsync(continuing: retry).ConfigureAwait(false);
            if (!claimed)
            {
                // A Stop that no running turn observed: it arrived after this processor was
                // admitted but before it claimed busy, or after a previous turn last checked for
                // it. This processor holds the only claim, so it finalizes the Stop as a turn
                // would; otherwise Stopping refuses every later claim while runnable input
                // retriggers processors without end.
                if (
                    entry.WithState(state => state.Stopping && !state.Busy)
                    && !await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false)
                )
                    await host.FinalizeStoppedAsync().ConfigureAwait(false);
                return;
            }
            ranTurn = true;
            admitted?.Invoke();
            var retryPending =
                retry
                && !entry.WithState(state =>
                    ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope)
                    && state.Queue.Any(SessionCompactor.Ordinary)
                );
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
                    suspended = result.Suspended;
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
                    if (registry.OnTurnFailure is not null)
                        await registry.OnTurnFailure(error, true).ConfigureAwait(false);
                    break;
                }
                catch (AuthorityCommittedException)
                {
                    throw;
                }
                catch (Exception error)
                {
                    if (
                        closing
                        && entry.WithState(state =>
                            ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope)
                        )
                    )
                    {
                        interrupted = true;
                        break;
                    }
                    // The current turn does not auto-retry a chat failure, but an HTTP host
                    // must be able to report its terminal outcome rather than imply success.
                    failed =
                        error is Foxwarm.Models.ModelPreparationException
                        || entry.WithState(state =>
                            ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope)
                        );
                    llmFailed =
                        error
                            is Foxwarm.Models.ModelRequestException
                            {
                                Scope: Foxwarm.Models.ModelRequestScope.Canonical,
                                Final.Final: true,
                            };
                    entry.RecordBackgroundProcessorFailure(error);
                    // Retry-notice persistence is best-effort; an unrepresented model failure uses temporary presentation.
                    if (registry.OnTurnFailure is not null)
                        await registry
                            .OnTurnFailure(error, error is not Foxwarm.Models.ModelRequestException)
                            .ConfigureAwait(false);
                    if (llmFailed && entry.WithState(state => state.Stopping))
                    {
                        llmFailed = false;
                        if (await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false))
                        {
                            AssertCanContinue();
                            retryPending = entry.WithState(state =>
                                !state.Queue.Any(SessionCompactor.Ordinary)
                                && SessionContinuation.IsIncomplete(state.History)
                            );
                            continue;
                        }
                        await host.FinalizeStoppedAsync().ConfigureAwait(false);
                        claimed = false;
                    }
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
        catch (Exception error)
        {
            failed = true;
            escapingError = error;
            throw;
        }
        finally
        {
            try
            {
                try
                {
                    if (claimed && !interrupted)
                    {
                        var host = hosts.For(entry);
                        // A Stop accepted after the loop last checked for it (for example at the
                        // final safe point) is finished as the loop would have finished it.
                        if (
                            !failed
                            && entry.WithState(state => state.Stopping)
                            && !await ResumeQueuedOverrideAsync(entry).ConfigureAwait(false)
                        )
                            await host.FinalizeStoppedAsync().ConfigureAwait(false);
                        else
                            await host.ReleaseBusyAsync(llmFailed).ConfigureAwait(false);
                    }
                }
                catch (Exception error)
                {
                    escapingError = error;
                    throw;
                }
                finally
                {
                    if (registry.OnProcessorFinalizing is { } finalizing)
                        await finalizing(entry, escapingError, interrupted, suspended)
                            .ConfigureAwait(false);
                }
            }
            catch
            {
                failed = true;
                throw;
            }
            finally
            {
                // Claims are taken under the lifecycle lock, so releasing the claim together with the
                // registration keeps a concurrent start from claiming an entry that is still registered.
                lock (lifecycle)
                {
                    processors.Remove(entry);
                    entry.ReleaseProcessor();
                }
                // The busy-turn slot goes after the claim, so its waiters find this Session idle.
                if (turnSlot is not null)
                    turnScope.ReleaseOwnerSlot();
                try
                {
                    // A Stop that arrived after the checks above, while the claim was still held,
                    // goes to a new processor, which finalizes it. A processor that only tried to
                    // finalize a Stop and failed does not retrigger itself.
                    if (
                        !closing
                        && entry.WithState(state => !state.Busy)
                        && (
                            (!failed && registry.HasRunnableWork(entry))
                            || ((!failed || ranTurn) && entry.HasUnobservedStop)
                        )
                    )
                        registry.Trigger(sessionId);
                }
                finally
                {
                    entry.NotifyProcessorReleased();
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
            return (IReadOnlyList<QueueItem>)
                (
                    ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope)
                        ? state.Queue.Where(SessionCompactor.Ordinary).Take(1)
                        : state.Queue.Where(SessionCompactor.Ordinary)
                ).ToArray();
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
