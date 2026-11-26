namespace Foxwarm.Hosted.Runtimes;

/// <summary>Why a generation's admission closed.</summary>
internal enum AdmissionLatch
{
    /// <summary>Open, or not yet published.</summary>
    None,

    /// <summary>An idle release latched it; it reopens only as a new generation.</summary>
    IdleRelease,

    /// <summary>The routing drain of a move or a replica shutdown.</summary>
    Drain,

    /// <summary>The generation lost its grant.</summary>
    Fence,

    /// <summary>The runtime is stopping for any other reason.</summary>
    Stop,
}

/// <summary>
/// The one gate a tenant runtime generation admits work through: front and mesh requests,
/// channel deliveries, timers, ToolScript starts and Node execs. It opens once, when the
/// generation is published, and closes once (<see cref="Latch"/>); a latched gate never
/// reopens. Admission and the idle check run under one lock, so an idle release can't latch
/// while new work is being admitted, and work can't enter after the latch.
/// </summary>
internal sealed class AdmissionGate
{
    private readonly object gate = new();
    private readonly Func<long> clock;
    private bool open;
    private int inFlight;
    private long lastActivity;
    private TaskCompletionSource? drained;

    /// <param name="clock">A monotonic timestamp (<see cref="System.Diagnostics.Stopwatch"/>).</param>
    internal AdmissionGate(Func<long>? clock = null)
    {
        this.clock = clock ?? System.Diagnostics.Stopwatch.GetTimestamp;
        lastActivity = this.clock();
    }

    internal AdmissionLatch Latched { get; private set; }

    /// <summary>Admitted work still in progress.</summary>
    internal int InFlight
    {
        get
        {
            lock (gate)
                return inFlight;
        }
    }

    /// <summary>Admits work, or returns null (consuming nothing) when the gate isn't open.</summary>
    internal Admission? TryEnter()
    {
        lock (gate)
        {
            if (!open || Latched != AdmissionLatch.None)
                return null;
            inFlight++;
            lastActivity = clock();
            return new Admission(this);
        }
    }

    /// <summary>
    /// Latches the gate for an idle release when nothing is admitted, the generation has been
    /// without admissions for <paramref name="idleAfter"/>, and <paramref name="idle"/> (the
    /// runtime's own check: no busy Session, poller, Node connection or timer due soon) holds,
    /// all under the admission lock.
    /// </summary>
    internal bool TryLatchIdle(TimeSpan idleAfter, Func<bool> idle)
    {
        lock (gate)
        {
            if (!open || Latched != AdmissionLatch.None || inFlight > 0)
                return false;
            if (System.Diagnostics.Stopwatch.GetElapsedTime(lastActivity, clock()) < idleAfter)
                return false;
            if (!idle())
                return false;
            Latched = AdmissionLatch.IdleRelease;
            return true;
        }
    }

    /// <summary>Closes the gate for good; the first reason sticks.</summary>
    internal void Latch(AdmissionLatch reason)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(reason, AdmissionLatch.None);
        lock (gate)
            if (Latched == AdmissionLatch.None)
                Latched = reason;
    }

    /// <summary>Completes when no admitted work remains; call after <see cref="Latch"/>.</summary>
    internal Task DrainedAsync()
    {
        lock (gate)
        {
            if (inFlight == 0)
                return Task.CompletedTask;
            drained ??= new(TaskCreationOptions.RunContinuationsAsynchronously);
            return drained.Task;
        }
    }

    // Publication: the generation's start completed with a current grant.
    internal void Open()
    {
        lock (gate)
        {
            if (Latched == AdmissionLatch.None)
            {
                open = true;
                lastActivity = clock();
            }
        }
    }

    private void Exit()
    {
        TaskCompletionSource? settled = null;
        lock (gate)
        {
            inFlight--;
            lastActivity = clock();
            if (inFlight == 0 && drained is not null)
                (settled, drained) = (drained, null);
        }
        settled?.TrySetResult();
    }

    /// <summary>One admitted unit of work; disposing it ends the admission.</summary>
    internal sealed class Admission(AdmissionGate owner) : IDisposable
    {
        private int ended;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref ended, 1) == 0)
                owner.Exit();
        }
    }
}
