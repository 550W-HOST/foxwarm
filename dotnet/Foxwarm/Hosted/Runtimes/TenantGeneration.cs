using Foxwarm.Hosted.Lease;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>
/// One tenant runtime's identity: created by one activation, retired once. The epoch is the
/// lease grant's; the number counts this replica's generations of the tenant, so two runtimes
/// over the same grant (one retired by an aborted idle release, then its successor) still
/// differ. Fences, callbacks and disposal name an exact generation, never only a tenant.
/// </summary>
internal sealed record GenerationId(int TenantId, string Tenant, long Epoch, long Number)
{
    public override string ToString() => $"{Tenant}@{Epoch}.{Number}";
}

/// <summary>What a generation's runtime is built from.</summary>
/// <param name="Wakeup">
/// The tenant's wake-up row when the activation began: the due occurrence the runtime fires
/// even if it is already past. The row stays until the runtime replaces or clears it.
/// </param>
/// <param name="Fence">
/// The runtime attaches its <c>TenantDb</c> here, so a fence closes it at once and a refused
/// write fences the generation; its work observes <see cref="GenerationFence.Lost"/>.
/// </param>
internal sealed record ActivationContext(
    GenerationId Generation,
    LeaseGrant Grant,
    AdmissionGate Gate,
    WakeupRow? Wakeup,
    GenerationFence Fence
);

/// <summary>
/// A tenant runtime as the activation coordinator drives it. Idle release calls the last four
/// members in order, after the generation's gate is latched.
/// </summary>
internal interface IGenerationRuntime : IAsyncDisposable
{
    /// <summary>
    /// Starts the runtime; it is published (admits work) only after this completes. It completes
    /// only when the start itself has ended: <paramref name="token"/> may be passed on to the
    /// start, but never cancels just the wait for it, so a fenced or shut down generation's
    /// settlement covers its whole start (the supervisor bounds it).
    /// </summary>
    Task StartAsync(CancellationToken token);

    void CredentialRotated() { }

    /// <summary>
    /// The runtime's own idle check, evaluated under the admission lock: no busy Session, no
    /// channel poller, no Node connection, no running ToolScript or exec, no timer due within
    /// the wake-up horizon.
    /// </summary>
    bool Idle { get; }

    /// <summary>Acknowledge a reconciled wake-up only after successful publication.</summary>
    Task PublishedAsync(CancellationToken token) => Task.CompletedTask;

    /// <summary>Stops work the runtime starts on its own: timers, pollers, wait timeouts.</summary>
    Task StopProducersAsync(CancellationToken token);

    /// <summary>Waits for in-flight deliveries to finish, including their completion saves.</summary>
    Task SettleAsync(CancellationToken token);

    /// <summary>
    /// The next time the tenant must run without traffic, from its persisted state; null when
    /// nothing is due.
    /// </summary>
    Task<WakeupDue?> NextDueAsync(CancellationToken token);

    /// <summary>The stopped clock's nomination, even if the final canonical wait read failed.</summary>
    System.Text.Json.Nodes.JsonObject? RecoveryOccurrence => null;
}

/// <summary>Builds a generation's runtime; it isn't started yet.</summary>
internal delegate Task<IGenerationRuntime> GenerationFactory(
    ActivationContext context,
    CancellationToken token
);

/// <summary>
/// A tenant runtime generation, from its registration (before its runtime is built) to its
/// retirement. <see cref="Stopped"/> reports the settlement of everything the generation
/// started: its build, or its release steps, the runtime's disposal and the admitted work.
/// </summary>
internal sealed class TenantGeneration
{
    private readonly TaskCompletionSource<StopResult> stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource disposed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int disposing;
    private int retiring;
    private int fenced;

    internal TenantGeneration(GenerationId id, GrantHandle handle, AdmissionGate gate, GenerationFence fence)
    {
        Id = id;
        Handle = handle;
        Gate = gate;
        Fence = fence;
    }

    internal GenerationId Id { get; }

    /// <summary>The grant this generation runs under, as the renewer tracks it.</summary>
    internal GrantHandle Handle { get; }

    internal LeaseGrant Grant => Handle.Grant;

    internal GenerationFence Fence { get; }

    internal AdmissionGate Gate { get; }

    /// <summary>The runtime, once the factory returned it.</summary>
    internal IGenerationRuntime? Runtime { get; set; }

    /// <summary>Set at publication: the gate opened and the runtime serves.</summary>
    internal bool Published { get; set; }

    /// <summary>The supervisor's watch of this generation's stop, armed at registration.</summary>
    internal Obligation? Obligation { get; set; }

    /// <summary>True once the stop was confirmed in time; false once the supervisor escalated.</summary>
    internal Task<bool> Supervision => Obligation!.Decided;

    /// <summary>Whether a loss of the grant has fenced this generation.</summary>
    internal bool IsFenced => Volatile.Read(ref fenced) != 0;

    internal bool MarkFenced() => Interlocked.Exchange(ref fenced, 1) == 0;

    /// <summary>The settlement of everything the generation started; once.</summary>
    internal Task<StopResult> Stopped => stopped.Task;

    internal void Settle(StopResult result) => stopped.TrySetResult(result);

    // A settled null deadline means no wake-up; a failed read needs a recoverable hand-back.
    internal WakeupDue? HandBack { get; private set; }
    internal bool ScheduleSettled { get; private set; }

    internal Task<StopResult> RetireWithWakeupAsync(CancellationToken token) => RetireAsync(async () =>
    {
        using var steps = CancellationTokenSource.CreateLinkedTokenSource(token, Fence.Lost);
        var runtime = Runtime!;
        await runtime.StopProducersAsync(steps.Token).ConfigureAwait(false);
        await runtime.SettleAsync(steps.Token).ConfigureAwait(false);
        HandBack = await runtime.NextDueAsync(steps.Token).ConfigureAwait(false);
        ScheduleSettled = true;
    });

    /// <summary>Completes when the runtime has been disposed.</summary>
    internal Task Disposed => disposed.Task;

    // Exactly one disposal per generation; later callers join it. Never runs on the caller's
    // thread: a synchronous stall in one runtime's disposal can't hold another's.
    internal Task DisposeOnceAsync()
    {
        if (Interlocked.Exchange(ref disposing, 1) == 0)
            _ = Task.Run(async () =>
            {
                try
                {
                    if (Runtime is { } runtime)
                        await runtime.DisposeAsync().ConfigureAwait(false);
                    disposed.TrySetResult();
                }
                catch (Exception error)
                {
                    disposed.TrySetException(error);
                }
            });
        return disposed.Task;
    }

    /// <summary>
    /// Retires a published generation once: runs <paramref name="before"/> (an idle release's
    /// steps; their failure leaves the decision to the disposal), disposes the runtime, then waits
    /// for the admitted work to end. Confirmed only when the disposal completed successfully and
    /// the gate drained; a fault or a cancellation never confirms. Later callers join the first.
    /// </summary>
    internal Task<StopResult> RetireAsync(Func<Task>? before = null)
    {
        if (Interlocked.Exchange(ref retiring, 1) == 0)
            _ = Task.Run(async () =>
            {
                if (before is not null)
                    try
                    {
                        await before().ConfigureAwait(false);
                    }
                    catch (Exception) { }
                bool confirmed;
                try
                {
                    await DisposeOnceAsync().ConfigureAwait(false);
                    confirmed = true;
                }
                catch (Exception)
                {
                    confirmed = false;
                }
                if (confirmed)
                    await Gate.DrainedAsync().ConfigureAwait(false);
                Settle(StopResult.Now(confirmed));
            });
        return stopped.Task;
    }
}

/// <summary>The tenant can't be activated here now: another replica holds its lease.</summary>
internal sealed class TenantHeldElsewhereException(string tenant)
    : Exception($"Tenant {tenant} is held by another replica.");

/// <summary>The outcome of an idle release attempt.</summary>
internal enum IdleReleaseOutcome
{
    /// <summary>The lease was released with the tenant's wake-up row; the runtime is disposed.</summary>
    Released,

    /// <summary>Not idle (admitted work, recent activity, or the runtime's own check).</summary>
    Busy,

    /// <summary>Work arrived after the latch: the lease stays, and a new generation serves it.</summary>
    Aborted,

    /// <summary>The generation isn't the tenant's published one (already replaced or retired).</summary>
    NotCurrent,

    /// <summary>The grant was no longer current at the release transaction; nothing was written.</summary>
    Fenced,

    /// <summary>
    /// The runtime's stop wasn't confirmed: the grant is lost without a release, the tenant
    /// stays unavailable on this replica, and the process ends at the hard stop.
    /// </summary>
    StopFailed,

    /// <summary>
    /// The release didn't stop within the drain bound: its grant was lost (never released), so
    /// the supervised fence took over, and the process ends if the stop doesn't confirm.
    /// </summary>
    Overrun,
}
