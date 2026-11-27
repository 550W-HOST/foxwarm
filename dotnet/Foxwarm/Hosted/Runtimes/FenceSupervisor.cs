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
/// How a stop ended: whether it is confirmed (it completed successfully; a fault or a
/// cancellation never confirms) and the <see cref="Stopwatch"/> timestamp when that was decided.
/// </summary>
internal readonly record struct StopResult(bool Confirmed, long At)
{
    internal static StopResult Now(bool confirmed) => new(confirmed, Stopwatch.GetTimestamp());

    /// <summary>
    /// The result of <paramref name="stop"/>, timestamped by a continuation that runs inline as
    /// it completes: a queued continuation can't make a timely stop look late.
    /// </summary>
    internal static Task<StopResult> Of(Task stop) =>
        stop.ContinueWith(
            task => Now(task.IsCompletedSuccessfully),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default
        );
}

/// <summary>
/// A stop the supervisor decides: confirmed when <see cref="Stopped"/> reports a confirmed stop
/// before the hard stop, otherwise the process ends at the hard stop.
/// </summary>
internal sealed class Obligation
{
    private readonly TaskCompletionSource<bool> decided = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal Obligation(string what, Func<long> hardStop, Task<StopResult> stopped)
    {
        What = what;
        HardStop = hardStop;
        Stopped = stopped;
    }

    internal string What { get; }

    /// <summary>The <see cref="Stopwatch"/> timestamp the stop must be confirmed before; may move.</summary>
    internal Func<long> HardStop { get; }

    internal Task<StopResult> Stopped { get; }

    /// <summary>True once the stop was confirmed in time; false once the supervisor escalated.</summary>
    internal Task<bool> Decided => decided.Task;

    internal bool Decide(bool confirmed) => decided.TrySetResult(confirmed);
}

/// <summary>
/// Bounds how long a replica waits for a fenced or failed tenant runtime to stop (plan §2.3).
/// Every stop it watches is an <see cref="Obligation"/> with a hard stop: absolute, counted from
/// the loss (or, while the grant is current, from its deadline), never from when a handler
/// started. One dedicated thread, independent of the thread pool and armed before anything can
/// stall, decides each obligation once: a stop confirmed before its hard stop ends quietly; any
/// other outcome ends the process with <see cref="HostedExit.Fenced"/> at the hard stop,
/// directly: without waiting for other tenants' drains, releases or the pool's disposal, and
/// with nothing synchronous ahead of the exit (the log line is queued, best effort). An overdue
/// confirmation never wins: it is compared with the hard stop by its own timestamp. A process
/// suspended past a hard stop exits as soon as it runs again; while it is suspended, only the
/// lease's SQL epoch fence protects commits.
/// </summary>
internal sealed class FenceSupervisor
{
    private readonly Action<int> exit;
    private readonly Action<string>? log;
    private readonly TaskCompletionSource<string> escalated = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object gate = new();
    private readonly List<Obligation> pending = [];
    private readonly AutoResetEvent signal = new(false);
    private bool running;
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
        DrainTicks = (long)(drainBound.TotalSeconds * Stopwatch.Frequency);
        this.exit = exit;
        this.log = log;
    }

    internal TimeSpan DrainBound { get; }

    /// <summary><see cref="DrainBound"/> in <see cref="Stopwatch"/> ticks.</summary>
    internal long DrainTicks { get; }

    /// <summary>Completes with the reason once the supervisor ended the process.</summary>
    internal Task<string> Escalated => escalated.Task;

    /// <summary>
    /// Watches a stop until <paramref name="hardStop"/> (read again on every decision, so a
    /// renewal can move it forward and a loss back). Armed on return.
    /// </summary>
    internal Obligation Watch(string what, Func<long> hardStop, Task<StopResult> stopped)
    {
        var obligation = new Obligation(what, hardStop, stopped);
        lock (gate)
        {
            pending.Add(obligation);
            if (!running)
            {
                running = true;
                new Thread(Decide) { IsBackground = true, Name = "Foxwarm fence deadline" }.Start();
            }
        }
        // A stop that ends, or a hard stop that moves back, is decided without waiting.
        stopped.ContinueWith(_ => Wake(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        Wake();
        return obligation;
    }

    /// <summary>Makes the deadline thread decide again now (a hard stop moved back).</summary>
    internal void Wake() => signal.Set();

    /// <summary>
    /// Fences a runtime (the P1 replica): latches it, stops its renewal and closes its databases
    /// inline, then cancels its work and runs its stop off the caller's lane, with the hard stop
    /// <see cref="DrainBound"/> after <paramref name="fencedAt"/> (a <see cref="Stopwatch"/>
    /// timestamp), armed before any of those steps. True when the stop was confirmed in time;
    /// otherwise the process has been ended at the hard stop.
    /// </summary>
    internal Task<bool> FenceAsync(
        string what,
        long fencedAt,
        Action latch,
        Action stopRenewal,
        GenerationFence? fence,
        Func<Task> stop
    )
    {
        var stopped = new TaskCompletionSource<StopResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var obligation = Watch(what, () => fencedAt + DrainTicks, stopped.Task);
        Guard(latch);
        Guard(stopRenewal);
        fence?.Close();
        var stopping = Task.Run(async () =>
        {
            fence?.Cancel();
            await stop().ConfigureAwait(false);
        });
        _ = StopResult.Of(stopping).ContinueWith(result => stopped.TrySetResult(result.Result), TaskScheduler.Default);
        return obligation.Decided;
    }

    /// <summary>
    /// Joins a stop that is already running (a graceful drain the fence overtook, or a
    /// disposal), with the hard stop <see cref="DrainBound"/> after <paramref name="since"/>.
    /// </summary>
    internal Task<bool> JoinAsync(string what, long since, Task stopping) =>
        Watch(what, () => since + DrainTicks, StopResult.Of(stopping)).Decided;

    /// <summary>
    /// Ends the process at <paramref name="deadline"/> unless it has exited by then: for a stop
    /// that is already known to be unconfirmed, while the caller unwinds.
    /// </summary>
    internal void ExitBy(string what, long deadline) =>
        _ = Watch(what, () => deadline, Task.FromResult(new StopResult(false, 0)));

    /// <summary>Ends the process now with <see cref="HostedExit.Fenced"/>.</summary>
    internal void Escalate(string reason)
    {
        if (Interlocked.Exchange(ref exiting, 1) != 0)
            return;
        escalated.TrySetResult(reason);
        if (log is { } write)
            ThreadPool.UnsafeQueueUserWorkItem(_ => write("[hosted] Exiting: " + reason), null);
        exit(HostedExit.Fenced);
    }

    // The deadline thread: decides every pending obligation that has a result or has reached its
    // hard stop, then sleeps until the earliest remaining hard stop or a signal. It never exits
    // the process before a hard stop, and a confirmation counts only if its own timestamp is
    // before the hard stop. It ends when nothing is pending.
    private void Decide()
    {
        while (true)
        {
            Obligation[] current;
            lock (gate)
            {
                if (pending.Count == 0)
                {
                    running = false;
                    return;
                }
                current = [.. pending];
            }
            var next = long.MaxValue;
            foreach (var obligation in current)
            {
                var hardStop = obligation.HardStop();
                var stopped = obligation.Stopped;
                if (stopped.IsCompletedSuccessfully && stopped.Result.Confirmed && stopped.Result.At < hardStop)
                    Settle(obligation, confirmed: true);
                else if (Stopwatch.GetTimestamp() >= hardStop)
                {
                    Settle(obligation, confirmed: false);
                    Escalate($"{obligation.What} didn't confirm its stop by its hard stop.");
                }
                else
                    next = Math.Min(next, hardStop);
            }
            if (next == long.MaxValue)
            {
                // Nothing with a finite hard stop: wait for a new obligation, a result or a loss.
                signal.WaitOne();
                continue;
            }
            var wait = (double)(next - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
            if (wait > 0)
                signal.WaitOne((int)Math.Min(int.MaxValue, Math.Ceiling(wait)));
        }
    }

    private void Settle(Obligation obligation, bool confirmed)
    {
        lock (gate)
            pending.Remove(obligation);
        obligation.Decide(confirmed);
    }

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
