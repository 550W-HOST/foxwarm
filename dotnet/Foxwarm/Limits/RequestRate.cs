namespace Foxwarm.Limits;

/// <summary>
/// A token bucket for a tenant's HTTP requests (plan P2 §7.2: 50 per second, bursts of 100):
/// it holds up to <c>burst</c> tokens, refills <c>perSecond</c> each second and a request takes
/// one. Requests over it are refused at once, with the time until the next token.
/// </summary>
internal sealed class RequestRate(int perSecond, int burst, Func<long>? clock = null)
{
    private readonly Func<long> now = clock ?? (() => Environment.TickCount64);
    private readonly object gate = new();
    private double tokens = burst;
    private long refilled = (clock ?? (() => Environment.TickCount64))();

    /// <summary>Takes a token; otherwise the wait until one is available.</summary>
    internal bool TryTake(out TimeSpan retryAfter)
    {
        lock (gate)
        {
            var current = now();
            tokens = Math.Min(burst, tokens + (current - refilled) * perSecond / 1000.0);
            refilled = current;
            if (tokens >= 1)
            {
                tokens--;
                retryAfter = TimeSpan.Zero;
                return true;
            }
            retryAfter = TimeSpan.FromMilliseconds(Math.Ceiling((1 - tokens) * 1000.0 / perSecond));
            return false;
        }
    }
}

/// <summary>A tenant's open WebSockets (plan P2 §7.2: 64); one over is refused.</summary>
internal sealed class OpenCount(int limit)
{
    private int open;

    internal int Open => Volatile.Read(ref open);

    /// <summary>A lease for one more, or null at the limit.</summary>
    internal IDisposable? TryOpen()
    {
        if (Interlocked.Increment(ref open) > limit)
        {
            Interlocked.Decrement(ref open);
            return null;
        }
        return new Lease(this);
    }

    private sealed class Lease(OpenCount owner) : IDisposable
    {
        private int closed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref closed, 1) == 0)
                Interlocked.Decrement(ref owner.open);
        }
    }
}
