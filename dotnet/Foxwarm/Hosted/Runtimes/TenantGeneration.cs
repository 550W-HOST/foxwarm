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
internal sealed record ActivationContext(
    GenerationId Generation,
    LeaseGrant Grant,
    AdmissionGate Gate,
    WakeupRow? Wakeup
);

/// <summary>
/// A tenant runtime as the activation coordinator drives it. Idle release calls the last four
/// members in order, after the generation's gate is latched.
/// </summary>
internal interface IGenerationRuntime : IAsyncDisposable
{
    /// <summary>Starts the runtime; it is published (admits work) only after this completes.</summary>
    Task StartAsync(CancellationToken token);

    /// <summary>
    /// The runtime's own idle check, evaluated under the admission lock: no busy Session, no
    /// channel poller, no Node connection, no running ToolScript or exec, no timer due within
    /// the wake-up horizon.
    /// </summary>
    bool Idle { get; }

    /// <summary>Stops work the runtime starts on its own: timers, pollers, wait timeouts.</summary>
    Task StopProducersAsync(CancellationToken token);

    /// <summary>Waits for in-flight deliveries to finish, including their completion saves.</summary>
    Task SettleAsync(CancellationToken token);

    /// <summary>
    /// The next time the tenant must run without traffic, from its persisted state; null when
    /// nothing is due.
    /// </summary>
    Task<WakeupDue?> NextDueAsync(CancellationToken token);
}

/// <summary>Builds a generation's runtime; it isn't started yet.</summary>
internal delegate Task<IGenerationRuntime> GenerationFactory(
    ActivationContext context,
    CancellationToken token
);

/// <summary>A published tenant runtime generation.</summary>
internal sealed class TenantGeneration
{
    internal TenantGeneration(GenerationId id, LeaseGrant grant, AdmissionGate gate, IGenerationRuntime runtime)
    {
        Id = id;
        Grant = grant;
        Gate = gate;
        Runtime = runtime;
    }

    internal GenerationId Id { get; }

    internal LeaseGrant Grant { get; }

    internal AdmissionGate Gate { get; }

    internal IGenerationRuntime Runtime { get; }

    /// <summary>Completes when the runtime has been disposed.</summary>
    internal Task Disposed => disposed.Task;

    private readonly TaskCompletionSource disposed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int disposing;

    // Exactly one disposal per generation; later callers join it.
    internal Task DisposeOnceAsync()
    {
        if (Interlocked.Exchange(ref disposing, 1) == 0)
            _ = RunAsync();
        return disposed.Task;

        async Task RunAsync()
        {
            try
            {
                await Runtime.DisposeAsync().ConfigureAwait(false);
                disposed.TrySetResult();
            }
            catch (Exception error)
            {
                disposed.TrySetException(error);
            }
        }
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
}
