namespace Foxwarm.Images;

// Each tenant has at most one place in the ready list, however many media requests it has.
// Releasing its worker puts the tenant at the back if it still needs service.
internal sealed class DecoderAdmission
{
    private const long TenantLimit = 2L * DecoderProtocol.MaxBytes;
    private const long ReplicaLimit = 4 * TenantLimit;

    private sealed class Ticket(long bytes)
    {
        // Charge a small minimum even for metadata-only calls: a queue of tiny images still
        // retains tickets, cancellation state, and (for staged uploads) open file handles.
        internal long Charge { get; } = Math.Max(bytes, 1024 * 1024);
        internal readonly TaskCompletionSource<IDisposable> Slot = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
    }

    private sealed class Tenant(int key)
    {
        internal int Key => key;
        internal bool Active;
        internal readonly LinkedList<Ticket> Waiting = [];
        internal long PendingBytes;
        internal LinkedListNode<Tenant>? Ready;
    }

    private sealed class Slot(DecoderAdmission owner, Tenant tenant) : IDisposable
    {
        private int released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
                owner.Release(tenant);
        }
    }

    private readonly object gate = new();
    private readonly Dictionary<int, Tenant> tenants = [];
    private readonly LinkedList<Tenant> ready = [];
    private int active;
    private long pendingBytes;

    internal async Task<IDisposable> EnterAsync(int key, long bytes, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Tenant tenant;
        var ticket = new Ticket(bytes);
        LinkedListNode<Ticket> node;
        lock (gate)
        {
            tenants.TryGetValue(key, out var existing);
            // A tenant with an available slot can run immediately, even if other tenants
            // have already reserved all waiting capacity. Dispatch below holds this same lock.
            if (
                (active == 2 || existing?.Active == true)
                && (
                    ticket.Charge > TenantLimit - (existing?.PendingBytes ?? 0)
                    || ticket.Charge > ReplicaLimit - pendingBytes
                )
            )
                throw new ImageProcessingException(DecoderProtocol.Busy);
            if (existing is null)
                tenants.Add(key, tenant = new(key));
            else
                tenant = existing;
            tenant.PendingBytes += ticket.Charge;
            pendingBytes += ticket.Charge;
            node = tenant.Waiting.AddLast(ticket);
            Update(tenant);
            Dispatch();
        }
        try
        {
            return await ticket.Slot.Task.WaitAsync(TimeSpan.FromSeconds(15), token);
        }
        catch (Exception error) when (error is TimeoutException or OperationCanceledException)
        {
            lock (gate)
            {
                if (node.List is not null)
                {
                    Remove(tenant, node);
                    Update(tenant);
                }
                else
                    ticket.Slot.Task.Result.Dispose(); // dispatch won the race with cancellation
            }
            if (error is OperationCanceledException)
                throw;
            MainLog.Diagnostic("Image decoder: wait deadline expired.", failure: true);
            throw new ImageProcessingException(DecoderProtocol.Busy);
        }
    }

    private void Remove(Tenant tenant, LinkedListNode<Ticket> node)
    {
        tenant.Waiting.Remove(node);
        tenant.PendingBytes -= node.Value.Charge;
        pendingBytes -= node.Value.Charge;
    }

    private void Release(Tenant tenant)
    {
        lock (gate)
        {
            active--;
            tenant.Active = false;
            Update(tenant);
            Dispatch();
        }
    }

    private void Update(Tenant tenant)
    {
        if (tenant.Active)
            return;
        if (tenant.Waiting.Count != 0)
        {
            tenant.Ready ??= ready.AddLast(tenant);
            return;
        }
        if (tenant.Ready is not null)
            ready.Remove(tenant.Ready);
        tenants.Remove(tenant.Key);
    }

    private void Dispatch()
    {
        while (active < 2 && ready.First is { } next)
        {
            var tenant = next.Value;
            ready.RemoveFirst();
            tenant.Ready = null;
            var ticket = tenant.Waiting.First!;
            Remove(tenant, ticket);
            tenant.Active = true;
            active++;
            ticket.Value.Slot.SetResult(new Slot(this, tenant));
        }
    }
}
