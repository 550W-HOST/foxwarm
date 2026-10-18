namespace Foxwarm.Vector;

// Source's owner-local barrier: readers overlap; queued exclusive work runs before waiting readers.
internal sealed class VectorOperationGate
{
    private readonly object gate = new();
    private readonly Queue<TaskCompletionSource<IDisposable>> regular = new();
    private readonly Queue<TaskCompletionSource<IDisposable>> exclusive = new();
    private int readers;
    private bool writer;

    internal Task<IDisposable> EnterAsync(bool exclusive = false)
    {
        lock (gate)
        {
            if (!exclusive && !writer && this.exclusive.Count == 0)
            {
                readers++;
                return Task.FromResult<IDisposable>(new Lease(this, false));
            }
            var waiter = new TaskCompletionSource<IDisposable>(TaskCreationOptions.RunContinuationsAsynchronously);
            (exclusive ? this.exclusive : regular).Enqueue(waiter);
            Admit();
            return waiter.Task;
        }
    }
    private void Admit()
    {
        if (writer || readers > 0)
            return;
        if (exclusive.TryDequeue(out var next))
        {
            writer = true;
            next.SetResult(new Lease(this, true));
        }
        else
            while (regular.TryDequeue(out next))
            {
                readers++;
                next.SetResult(new Lease(this, false));
            }
    }
    private sealed class Lease(VectorOperationGate owner, bool exclusive) : IDisposable
    {
        private int disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0)
                return;
            lock (owner.gate)
            {
                if (exclusive)
                    owner.writer = false;
                else
                    owner.readers--;
                owner.Admit();
            }
        }
    }
}
