namespace Foxwarm.Models;

// One physical attempt. Image activity and safety buffering latch the Source
// ten-minute floor; caller Stop and the separate hard deadline remain independent.
internal sealed class StreamActivityWatchdog : IDisposable
{
    private readonly object gate = new();
    private readonly ITimer timer;
    private int? inactivityMs;
    private bool finished;

    internal StreamActivityWatchdog(
        CancellationTokenSource attempt,
        int? inactivityMs,
        TimeProvider? clock = null
    )
    {
        this.inactivityMs = inactivityMs;
        timer = (clock ?? TimeProvider.System).CreateTimer(
            _ =>
            {
                lock (gate)
                {
                    if (finished)
                        return;
                    finished = true;
                    attempt.Cancel();
                }
            },
            null,
            inactivityMs is null ? Timeout.InfiniteTimeSpan : TimeSpan.FromMilliseconds(180000),
            Timeout.InfiniteTimeSpan
        );
    }

    internal void Progress()
    {
        lock (gate)
            if (!finished && inactivityMs is int timeout)
                timer.Change(TimeSpan.FromMilliseconds(timeout), Timeout.InfiniteTimeSpan);
    }

    internal void ExtendedActivity()
    {
        lock (gate)
        {
            if (finished)
                return;
            inactivityMs = Math.Max(inactivityMs ?? 60000, 600000);
            timer.Change(TimeSpan.FromMilliseconds(inactivityMs.Value), Timeout.InfiniteTimeSpan);
        }
    }

    internal void Finish()
    {
        lock (gate)
        {
            finished = true;
            timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            finished = true;
            timer.Dispose();
        }
    }
}
