using System.Diagnostics;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>
/// The fencing side of one generation, handed to its runtime: the databases to close when it
/// is fenced and the token its work observes. Closing is immediate and inline; cancelling the
/// token runs the runtime's cancellation callbacks, which may block, so the supervisor does
/// that off the caller's lane.
/// </summary>
internal sealed class GenerationFence
{
    private readonly object gate = new();
    private readonly List<TenantDb> databases = [];
    private readonly CancellationTokenSource lost = new();
    private bool closed;

    /// <summary>Raised once when an attached database's write is refused by the epoch fence (FW001).</summary>
    internal event Action<TenantFencedException>? Refused;

    /// <summary>Cancelled when the generation is fenced.</summary>
    internal CancellationToken Lost => lost.Token;

    internal bool IsClosed
    {
        get
        {
            lock (gate)
                return closed;
        }
    }

    /// <summary>Closes <paramref name="database"/> with the generation, and reports its refused writes.</summary>
    internal void Attach(TenantDb database)
    {
        lock (gate)
        {
            if (closed)
                database.Close();
            else
                databases.Add(database);
        }
        database.Fenced += error => Refused?.Invoke(error);
    }

    // Every attached database refuses new transactions from here on.
    internal void Close()
    {
        TenantDb[] current;
        lock (gate)
        {
            closed = true;
            current = [.. databases];
        }
        foreach (var database in current)
            database.Close();
    }

    // Runs the runtime's cancellation callbacks; may block on a callback that stalls.
    internal void Cancel()
    {
        try
        {
            lost.Cancel();
        }
        catch (AggregateException) { }
        catch (ObjectDisposedException) { }
    }
}

/// <summary>
/// Bounds how long a replica waits for a fenced or failed tenant runtime to stop (plan §2.3).
/// The deadline is absolute, counted from the fence. A stop that is confirmed in time (the
/// runtime's disposal completed) ends quietly. An unconfirmed stop at the deadline ends the
/// process with <see cref="HostedExit.Fenced"/>, directly: from a dedicated thread, without
/// waiting for other tenants' drains, releases or the pool's disposal, and regardless of a
/// starved thread pool. That holds for an overrun, for a stop that faulted while work was
/// still admitted, for a cancellation callback that stalls synchronously, and for a fence
/// during graceful shutdown. A grant whose stop wasn't confirmed is never released cleanly;
/// it expires.
/// </summary>
internal sealed class FenceSupervisor
{
    private readonly Action<int> exit;
    private readonly Action<string>? log;
    private readonly TaskCompletionSource<string> escalated = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int exiting;

    /// <param name="drainBound">
    /// How long a fenced runtime gets to stop. With the fence deadline it must stay below the
    /// lease TTL, so the process is gone before a successor can acquire.
    /// </param>
    /// <param name="exit">Ends the process; <see cref="Environment.Exit"/> in production.</param>
    internal FenceSupervisor(
        Lease.LeaseTimings timings,
        TimeSpan drainBound,
        Action<int> exit,
        Action<string>? log = null
    )
    {
        timings.Validate();
        if (drainBound <= TimeSpan.Zero || timings.FenceAfter + drainBound >= timings.Ttl)
            throw new ArgumentException("The drain bound must be positive and below the lease TTL minus the fence deadline.");
        DrainBound = drainBound;
        this.exit = exit;
        this.log = log;
    }

    internal TimeSpan DrainBound { get; }

    /// <summary>Completes with the reason once the supervisor ended the process.</summary>
    internal Task<string> Escalated => escalated.Task;

    /// <summary>
    /// Fences a generation: latches it, stops its renewal and closes its databases inline, then
    /// cancels its work and joins its stop off the caller's lane, until the deadline counted
    /// from <paramref name="fencedAt"/> (a <see cref="Stopwatch"/> timestamp). True when the
    /// stop was confirmed in time; otherwise the process has been ended at the deadline.
    /// </summary>
    internal async Task<bool> FenceAsync(
        string what,
        long fencedAt,
        Action latch,
        Action stopRenewal,
        GenerationFence? fence,
        Func<Task> stop,
        Func<bool> drained
    )
    {
        var deadline = fencedAt + (long)(DrainBound.TotalSeconds * Stopwatch.Frequency);
        // Armed first: nothing after this point can keep the process past the deadline. The
        // event isn't disposed: the armed thread may still wait on it after this returns.
        var confirmed = new ManualResetEventSlim(false);
        Arm(what, deadline, confirmed);
        Guard(latch);
        Guard(stopRenewal);
        fence?.Close();
        var stopping = Task.Run(async () =>
        {
            fence?.Cancel();
            await stop().ConfigureAwait(false);
        });
        return await JoinAsync(what, deadline, stopping, drained, confirmed).ConfigureAwait(false);
    }

    /// <summary>
    /// Joins a stop that is already running (a graceful drain the fence overtook, or a
    /// disposal), until the deadline counted from <paramref name="since"/>.
    /// </summary>
    internal async Task<bool> JoinAsync(string what, long since, Task stopping, Func<bool> drained)
    {
        var deadline = since + (long)(DrainBound.TotalSeconds * Stopwatch.Frequency);
        var confirmed = new ManualResetEventSlim(false);
        Arm(what, deadline, confirmed);
        return await JoinAsync(what, deadline, stopping, drained, confirmed).ConfigureAwait(false);
    }

    private async Task<bool> JoinAsync(
        string what,
        long deadline,
        Task stopping,
        Func<bool> drained,
        ManualResetEventSlim confirmed
    )
    {
        var remaining = Remaining(deadline);
        if (remaining > TimeSpan.Zero)
            await Task.WhenAny(stopping, Task.Delay(remaining)).ConfigureAwait(false);
        var ok = stopping.IsCompletedSuccessfully || (stopping.IsFaulted && drained());
        if (stopping.IsFaulted)
            log?.Invoke($"[hosted] Stopping {what} failed: {stopping.Exception!.GetBaseException().Message}");
        if (ok)
        {
            confirmed.Set();
            return true;
        }
        // A faulted stop with work still admitted waits for the deadline: the work may finish.
        if (stopping.IsFaulted)
            while (Remaining(deadline) > TimeSpan.Zero && !drained())
                await Task.Delay(TimeSpan.FromMilliseconds(20)).ConfigureAwait(false);
        if (drained() && stopping.IsCompleted)
        {
            confirmed.Set();
            return true;
        }
        // The armed thread exits at the deadline; it doesn't depend on this continuation.
        return false;
    }

    // A dedicated thread, so a starved thread pool or a stalled callback can't delay the exit.
    private void Arm(string what, long deadline, ManualResetEventSlim confirmed)
    {
        var handle = confirmed.WaitHandle;
        var thread = new Thread(() =>
        {
            // A timed wait can return a little early; never exit before the deadline.
            for (var remaining = Remaining(deadline); remaining > TimeSpan.Zero; remaining = Remaining(deadline))
                if (handle.WaitOne(TimeSpan.FromMilliseconds(Math.Ceiling(remaining.TotalMilliseconds))))
                    return;
            if (confirmed.IsSet)
                return;
            Escalate($"{what} didn't stop within {DrainBound.TotalSeconds:0.#} s of its fence.");
        })
        {
            IsBackground = true,
            Name = "Foxwarm fence deadline",
        };
        thread.Start();
    }

    /// <summary>Ends the process now with <see cref="HostedExit.Fenced"/>.</summary>
    internal void Escalate(string reason)
    {
        if (Interlocked.Exchange(ref exiting, 1) != 0)
            return;
        log?.Invoke("[hosted] Exiting: " + reason);
        escalated.TrySetResult(reason);
        exit(HostedExit.Fenced);
    }

    private static TimeSpan Remaining(long deadline) =>
        TimeSpan.FromSeconds((double)(deadline - Stopwatch.GetTimestamp()) / Stopwatch.Frequency);

    private void Guard(Action step)
    {
        try
        {
            step();
        }
        catch (Exception error)
        {
            log?.Invoke("[hosted] A fence step failed: " + error.Message);
        }
    }
}
