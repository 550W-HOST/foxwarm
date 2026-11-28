namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private Foxwarm.Timers.IProducerAdmission? producers;
    internal Foxwarm.Terminal.TerminalRegistry? LocalTerminals { get; set; }

    internal Foxwarm.Timers.IProducerAdmission? ScheduledProducers => producers;

    internal void EnableScheduledProducers(Foxwarm.Timers.RuntimeSchedule schedule)
    {
        producers = schedule.Admission;
        timers.EnableWakeups(schedule.Occurrence, producers);
    }

    // Evaluated under the generation admission gate. Never read a database or wait for a
    // producer here: this decision is followed by an ordered stop, settle and persisted scan.
    internal bool MayUnload
    {
        get
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!accepting || LocalTerminals?.HasLiveShells == true || !deferredRecovery.IsCompleted || ManagedChannels?.HasLiveTransport == true
                || Nodes.HasConnections || ToolScript.HasActiveRuns || executor.TrackedCount != 0
                || waitTimeouts.DueWithin(now + (long)Foxwarm.Timers.MainTimers.WakeLead.TotalMilliseconds)
                || timers.NeedsActiveRuntime(now))
                return false;
            lock (copyGate)
                if (copies.Count != 0) return false;
            return !sessions.Values.Any(owner => owner.Processing || owner.Entry.HasProcessor || owner.Compactor.Active
                || owner.HasSubscribers || owner.Entry.WithState(state => state.Busy));
        }
    }

    internal async Task StopWakeupProducersAsync()
    {
        timers.StopFuture();
        waitTimeouts.Stop();
        waitLiveness.Stop();
        if (ManagedChannels is { } channels)
        {
            if (!await channels.SettleHostedPollersAsync().ConfigureAwait(false)) BeginShutdown();
            await channels.StopIngressAsync().ConfigureAwait(false);
        }
    }

    internal async Task SettleWakeupProducersAsync()
    {
        await timers.DisposeAsync();
        await waitTimeouts.DrainAsync();
        await waitLiveness.DrainAsync();
    }
}
