namespace Foxwarm.Images;

// Each tenant has at most one place in the ready list, however many media requests it has.
// Releasing its worker puts the tenant at the back if it still needs service.
internal sealed class DecoderAdmission
{
    private sealed class Tenant(int key)
    {
        internal int Key => key;
        internal bool Active;
        internal readonly LinkedList<TaskCompletionSource<IDisposable>> Waiting = [];
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

    internal async Task<IDisposable> EnterAsync(int key, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Tenant tenant;
        var ticket = new TaskCompletionSource<IDisposable>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        LinkedListNode<TaskCompletionSource<IDisposable>> node;
        lock (gate)
        {
            if (!tenants.TryGetValue(key, out tenant!))
                tenants.Add(key, tenant = new(key));
            node = tenant.Waiting.AddLast(ticket);
            Update(tenant);
            Dispatch();
        }
        try
        {
            return await ticket.Task.WaitAsync(TimeSpan.FromSeconds(15), token);
        }
        catch (Exception error) when (error is TimeoutException or OperationCanceledException)
        {
            lock (gate)
            {
                if (node.List is not null)
                {
                    tenant.Waiting.Remove(node);
                    Update(tenant);
                }
                else
                    ticket.Task.Result.Dispose(); // dispatch won the race with cancellation
            }
            if (error is OperationCanceledException)
                throw;
            MainLog.Diagnostic("Image decoder: wait deadline expired.", failure: true);
            throw new ImageProcessingException(DecoderProtocol.Busy);
        }
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
            var ticket = tenant.Waiting.First!.Value;
            tenant.Waiting.RemoveFirst();
            tenant.Active = true;
            active++;
            ticket.SetResult(new Slot(this, tenant));
        }
    }
}
