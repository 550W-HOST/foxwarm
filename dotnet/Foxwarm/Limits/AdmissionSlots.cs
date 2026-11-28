namespace Foxwarm.Limits;

/// <summary>
/// A tenant limit refused or timed out an admission. The message is the user-facing reason;
/// <see cref="Limit"/> names the limit's key in <c>tenants.limits</c>.
/// </summary>
internal sealed class TenantLimitException(string limit, string message)
    : InvalidOperationException(message)
{
    internal string Limit { get; } = limit;
    // A rejected byte reservation, used to wait for room without rereading its persisted size.
    internal long RequestedBytes { get; init; }
}

/// <summary>
/// A counting admission that queues: <see cref="EnterAsync"/> waits for a free slot and the
/// returned lease frees it. With a parent (a replica's budget), a slot is taken in both, own
/// first, so a tenant at its own limit never holds a replica slot while it waits.
/// </summary>
internal sealed class AdmissionSlots
{
    private readonly SemaphoreSlim slots;
    private readonly AdmissionSlots? parent;

    internal AdmissionSlots(int capacity, AdmissionSlots? parent = null)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        Capacity = capacity;
        slots = new SemaphoreSlim(capacity, capacity);
        this.parent = parent;
    }

    internal int Capacity { get; }

    /// <summary>Slots in use.</summary>
    internal int InUse => Capacity - slots.CurrentCount;

    internal async ValueTask<IDisposable> EnterAsync(CancellationToken token = default)
    {
        await slots.WaitAsync(token).ConfigureAwait(false);
        IDisposable? outer = null;
        try
        {
            if (parent is not null)
                outer = await parent.EnterAsync(token).ConfigureAwait(false);
        }
        catch
        {
            slots.Release();
            throw;
        }
        return new Lease(this, outer);
    }

    internal IDisposable? TryEnter()
    {
        if (!slots.Wait(0)) return null;
        var outer = parent?.TryEnter();
        if (parent is null || outer is not null) return new Lease(this, outer);
        slots.Release();
        return null;
    }

    private sealed class Lease(AdmissionSlots owner, IDisposable? outer) : IDisposable
    {
        private int released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) != 0)
                return;
            outer?.Dispose();
            owner.slots.Release();
        }
    }

    /// <summary>A lease that holds nothing, for runtimes without limits.</summary>
    internal static IDisposable None { get; } = new Nothing();

    private sealed class Nothing : IDisposable
    {
        public void Dispose() { }
    }
}
