namespace Foxwarm.Storage;

/// <summary>Serializes a store whose transaction bodies call synchronous store members.</summary>
internal sealed class StoreGate
{
    private readonly SemaphoreSlim semaphore = new(1, 1);
    private readonly AsyncLocal<Hold?> holder = new();

    // A synchronous nested call joins its caller. A Task started by the body inherits its
    // execution context, but cannot join the running transaction from another thread or later.
    internal bool IsHeld => holder.Value is { Active: true } hold && hold.Thread == Environment.CurrentManagedThreadId;

    internal IDisposable Enter()
    {
        if (IsHeld)
            return Joined.Instance;
        semaphore.Wait();
        return new Hold(this, release: true);
    }

    // Waits for the gate without a worker thread; the database also waits asynchronously for
    // its statement slot. A continuation can switch threads before the transaction body runs.
    internal async Task<T> HoldAsync<T>(Func<Task<T>> operation, CancellationToken token = default)
    {
        await semaphore.WaitAsync(token).ConfigureAwait(false);
        try
        {
            return await operation().ConfigureAwait(false);
        }
        finally
        {
            semaphore.Release();
        }
    }

    // Called with the semaphore held. Mark the thread actually running the synchronous body.
    internal T InBody<T>(Func<T> body)
    {
        if (IsHeld)
            return body();
        using var hold = new Hold(this, release: false);
        return body();
    }

    private sealed class Hold : IDisposable
    {
        private readonly StoreGate gate;
        private readonly bool release;
        private readonly Hold? previous;
        internal readonly int Thread = Environment.CurrentManagedThreadId;
        internal volatile bool Active = true;

        internal Hold(StoreGate gate, bool release)
        {
            this.gate = gate;
            this.release = release;
            previous = gate.holder.Value;
            gate.holder.Value = this;
        }

        public void Dispose()
        {
            Active = false;
            gate.holder.Value = previous;
            if (release)
                gate.semaphore.Release();
        }
    }

    private sealed class Joined : IDisposable
    {
        internal static readonly Joined Instance = new();
        public void Dispose() { }
    }
}
