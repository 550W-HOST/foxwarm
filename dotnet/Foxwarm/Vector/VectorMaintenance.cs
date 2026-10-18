namespace Foxwarm.Vector;

// Source's owner-local coalescer; the runtime callback owns the table gate and native maintenance.
internal sealed class VectorMaintenance : IAsyncDisposable
{
    private readonly bool enabled;
    private readonly TimeProvider clock;
    private readonly Func<IReadOnlyList<string>, Task> check;
    private readonly Action? onError;
    private readonly object gate = new();
    private readonly HashSet<string> pending = new(StringComparer.Ordinal);
    private int mutations;
    private DateTimeOffset? firstRequested;
    private DateTimeOffset? notBefore;
    private ITimer? timer;
    private ITimer? periodic;
    private Task? running;
    private bool stopping;

    internal VectorMaintenance(bool enabled, TimeProvider clock, Func<IReadOnlyList<string>, Task> check, Action? onError = null)
    {
        this.enabled = enabled;
        this.clock = clock;
        this.check = check;
        this.onError = onError;
    }
    internal void Start()
    {
        lock (gate)
            if (enabled && !stopping && periodic is null)
                periodic = clock.CreateTimer(_ => Request("periodic"), null, TimeSpan.FromDays(1), TimeSpan.FromDays(1));
    }
    internal void RecordMutation()
    {
        lock (gate)
        {
            if (!enabled || stopping)
                return;
            if (++mutations >= 128)
            {
                mutations = 0;
                Request("mutation-threshold");
            }
        }
    }
    internal void Request(string trigger)
    {
        lock (gate)
        {
            if (!enabled || stopping || running is not null)
                return;
            pending.Add(trigger);
            if (firstRequested is null)
            {
                firstRequested = clock.GetUtcNow();
                Schedule();
            }
        }
    }
    internal Task StartupAsync()
    {
        lock (gate)
        {
            if (!enabled || stopping)
                return Task.CompletedTask;
            if (running is not null)
                return running;
            pending.Add("startup");
            return Launch();
        }
    }
    private void Schedule()
    {
        if (running is not null || stopping || firstRequested is null || timer is not null)
            return;
        var due = firstRequested.Value.AddMinutes(1);
        if (notBefore is { } retry && retry > due)
            due = retry;
        timer = clock.CreateTimer(_ =>
        {
            lock (gate)
            {
                timer?.Dispose();
                timer = null;
                _ = Launch();
            }
        }, null, due <= clock.GetUtcNow() ? TimeSpan.Zero : due - clock.GetUtcNow(), Timeout.InfiniteTimeSpan);
    }
    private Task Launch()
    {
        if (!enabled || stopping)
            return Task.CompletedTask;
        if (running is not null)
            return running;
        timer?.Dispose();
        timer = null;
        var triggers = pending.ToArray();
        pending.Clear();
        firstRequested = null;
        notBefore = null;
        if (triggers.Length == 0)
            return Task.CompletedTask;
        Task? task = null;
        task = Task.Run(async () =>
        {
            try { await check(triggers); }
            catch
            {
                try { onError?.Invoke(); } catch { }
                lock (gate)
                    if (!stopping)
                    {
                        pending.Add("retry");
                        firstRequested = clock.GetUtcNow();
                        notBefore = firstRequested.Value.AddHours(1);
                    }
            }
            finally
            {
                lock (gate)
                {
                    if (running == task)
                        running = null;
                    if (!stopping && pending.Count > 0)
                    {
                        firstRequested ??= clock.GetUtcNow();
                        Schedule();
                    }
                }
            }
        });
        running = task;
        return task;
    }
    public async ValueTask DisposeAsync()
    {
        Task? active;
        lock (gate)
        {
            stopping = true;
            timer?.Dispose();
            timer = null;
            periodic?.Dispose();
            periodic = null;
            pending.Clear();
            firstRequested = null;
            notBefore = null;
            active = running;
        }
        if (active is not null)
            await active;
    }
}
