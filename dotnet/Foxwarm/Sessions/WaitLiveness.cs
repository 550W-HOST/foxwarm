using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Observed dependency progress diagnostic, never task-completion detection.
internal sealed class WaitLiveness(SessionManager manager) : IAsyncDisposable
{
    private const int MaxConcurrentWakes = 4;
    internal const long MaxInactivityMilliseconds = 24 * 60 * 60 * 1000;

    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, CancellationTokenSource> scheduled = new(
        StringComparer.Ordinal
    );
    private readonly Dictionary<string, string[]> dependencies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> reverse = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string WaitId, QueueItem Item)> pending = new(
        StringComparer.Ordinal
    );
    private readonly Queue<string> order = new();
    private readonly Dictionary<string, TaskCompletionSource> active = new(StringComparer.Ordinal);
    private readonly HashSet<Task> tasks = [];
    private readonly Dictionary<string, HashSet<Task>> sessionTasks = new(StringComparer.Ordinal);

    internal static long ActivityCutoff(long now) => now - MaxInactivityMilliseconds;

    internal static bool Recent(double lastMessageTime, long now) =>
        lastMessageTime >= ActivityCutoff(now);

    private static string[] Sources(JsonObject wait)
    {
        var all = SessionWait.Strings(wait["waitAll"]?["sessions"]);
        var satisfied = SessionWait.Strings(wait["waitAll"]?["satisfiedSessions"]);
        return all.Except(satisfied, StringComparer.Ordinal)
            .Concat(SessionWait.Strings(wait["waitAnySessions"]))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
    }

    private static bool Candidate(SessionMetadata? metadata) =>
        metadata is not null
        && Recent(metadata.LastMessageTime, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        && metadata.Wait is JsonObject wait
        && SessionWait.Number(wait["declarationVersion"]) == 1
        && wait["waitForInput"]?.GetValue<bool>() != true
        && !(SessionWait.Number(wait["timeoutSeconds"]) > 0)
        && SessionWait.Strings(wait["waitExecIds"]).Length == 0
        && Sources(wait).Length > 0;

    internal void Transition(string sessionId)
    {
        var owner = manager.Find(sessionId);
        var meta = owner?.Metadata() ?? manager.CatalogMetadata(sessionId);
        var wait = meta?.Wait;
        lock (gate)
        {
            if (lifetime.IsCancellationRequested)
                return;
            var priorIdentity = dependencies
                .Keys.Concat(scheduled.Keys)
                .Concat(active.Keys)
                .Concat(pending.Keys)
                .FirstOrDefault(key =>
                    key != sessionId && manager.SameAdmittedLifetime(key, sessionId)
                );
            if (priorIdentity is not null)
                sessionId = priorIdentity;
            if (
                (meta is null || !meta.Busy && meta.QueueLength == 0)
                && active.Remove(sessionId, out var released)
            )
                released.TrySetResult();
            if (dependencies.Remove(sessionId, out var old))
                foreach (var dependency in old)
                    if (reverse.TryGetValue(dependency, out var waiters))
                    {
                        waiters.Remove(sessionId);
                        if (waiters.Count == 0)
                            reverse.Remove(dependency);
                    }
            if (Candidate(meta))
            {
                var next = Sources(wait!);
                dependencies[sessionId] = next;
                foreach (var dependency in next)
                {
                    if (!reverse.TryGetValue(dependency, out var waiters))
                        reverse[dependency] = waiters = new(StringComparer.Ordinal);
                    waiters.Add(sessionId);
                }
            }
            Schedule(sessionId);
            foreach (
                var affected in reverse
                    .Where(pair =>
                        pair.Key == sessionId || manager.SameAdmittedLifetime(pair.Key, sessionId)
                    )
                    .Select(pair => pair.Value)
                    .ToArray()
            )
            foreach (var waiter in affected.ToArray())
                Schedule(waiter);
            Pump();
        }
    }

    private void Schedule(string id)
    {
        if (scheduled.Remove(id, out var prior))
            prior.Cancel();
        var metadata = manager.Find(id)?.Metadata() ?? manager.CatalogMetadata(id);
        var wait = metadata?.Wait;
        if (!manager.CanRunCallbacks(id) || !Candidate(metadata))
            return;
        var expected = SessionWait.Text(wait!["id"])!;
        var stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        scheduled[id] = stop;
        Track(
            id,
            async () =>
            {
                try
                {
                    await Task.Delay(300, stop.Token);
                    lock (gate)
                        if (
                            scheduled.TryGetValue(id, out var current)
                            && ReferenceEquals(current, stop)
                        )
                            scheduled.Remove(id);
                    Diagnose(id, expected);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
                finally
                {
                    stop.Dispose();
                }
            }
        );
    }

    private void Diagnose(string id, string expected)
    {
        var owner = manager.Find(id);
        var metadata = owner?.Metadata() ?? manager.CatalogMetadata(id);
        var wait = metadata?.Wait;
        if (!Candidate(metadata) || SessionWait.Text(wait!["id"]) != expected)
            return;
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var memo = new Dictionary<string, bool>(StringComparer.Ordinal);
        bool Visit(string currentId, bool root = false)
        {
            if (memo.TryGetValue(currentId, out var known))
                return known;
            if (!visiting.Add(currentId))
                return false;
            var current = manager.Find(currentId);
            var metadata = current?.Metadata() ?? manager.CatalogMetadata(currentId);
            var state = current?.WaitSnapshot() ?? metadata?.Wait;
            var sources = state is null ? [] : Sources(state);
            var progress =
                !root && (metadata?.Busy == true || metadata?.QueueLength > 0)
                || SessionWait.Number(state?["timeoutSeconds"]) > 0
                || state?["waitForInput"]?.GetValue<bool>() == true
                || SessionWait.Strings(state?["waitExecIds"]).Length > 0;
            if (!progress)
                progress = sources.Any(source => Visit(source));
            visiting.Remove(currentId);
            memo[currentId] = progress;
            return progress;
        }
        if (Visit(id, root: true))
            return;
        var item = SessionWait.Event(
            "wait-sources-quiescent",
            "The declared wait dependency Sessions currently show no queued, active, timed, exec-backed, input-backed, or transitively declared progress path after a short recheck. This is an observed potentially quiescent state, not proof of deadlock; explicit user or inter-session input may be needed.",
            fields: new JsonObject { ["waitLivenessWaitId"] = expected }
        );
        lock (gate)
        {
            if (lifetime.IsCancellationRequested || active.ContainsKey(id))
                return;
            if (!pending.ContainsKey(id))
                order.Enqueue(id);
            pending[id] = (expected, item);
            Pump();
        }
    }

    private void Pump()
    {
        if (lifetime.IsCancellationRequested)
            return;
        while (active.Count < MaxConcurrentWakes && order.TryDequeue(out var id))
        {
            if (!pending.Remove(id, out var wake))
                continue;
            var metadata = manager.Find(id)?.Metadata() ?? manager.CatalogMetadata(id);
            var wait = metadata?.Wait;
            if (!Candidate(metadata) || SessionWait.Text(wait!["id"]) != wake.WaitId)
                continue;
            var settled = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            active.Add(id, settled);
            Track(
                id,
                async () =>
                {
                    try
                    {
                        await manager.AdmitWaitEventAsync(id, wake.Item);
                        while (!lifetime.IsCancellationRequested)
                        {
                            var metadata = manager.Find(id)?.Metadata();
                            if (metadata is null || !metadata.Busy && metadata.QueueLength == 0)
                                break;
                            using var recheck = CancellationTokenSource.CreateLinkedTokenSource(
                                lifetime.Token
                            );
                            await Task.WhenAny(
                                settled.Task,
                                Task.Delay(TimeSpan.FromMinutes(5), recheck.Token)
                            );
                            recheck.Cancel();
                            if (settled.Task.IsCompleted)
                                break;
                        }
                    }
                    catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
                    catch (Exception error)
                    {
                        manager.Find(id)?.Entry.RecordBackgroundProcessorFailure(error);
                    }
                    finally
                    {
                        lock (gate)
                        {
                            if (
                                active.TryGetValue(id, out var current)
                                && ReferenceEquals(current, settled)
                            )
                                active.Remove(id);
                            Pump();
                        }
                    }
                }
            );
        }
    }

    // Schedule asynchronous work without inheriting the coordination lock; record it for shutdown drain.
    private void Track(string id, Func<Task> work)
    {
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var task = Task.Run(async () =>
        {
            await ready.Task;
            await work();
        });
        tasks.Add(task);
        if (!sessionTasks.TryGetValue(id, out var owned))
            sessionTasks[id] = owned = [];
        owned.Add(task);
        _ = task.ContinueWith(
            completed =>
            {
                lock (gate)
                {
                    tasks.Remove(completed);
                    if (sessionTasks.TryGetValue(id, out var set))
                    {
                        set.Remove(completed);
                        if (set.Count == 0)
                            sessionTasks.Remove(id);
                    }
                }
            },
            TaskScheduler.Default
        );
        ready.TrySetResult();
    }

    internal async Task RetireAsync(string id)
    {
        string[] keys;
        lock (gate)
            keys = sessionTasks
                .Keys.Concat(scheduled.Keys)
                .Concat(dependencies.Keys)
                .Concat(pending.Keys)
                .Concat(active.Keys)
                .Append(id)
                .Where(key => key == id || manager.SameAdmittedLifetime(key, id))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
        foreach (var key in keys)
            await RetireExactAsync(key);
    }

    private async Task RetireExactAsync(string id)
    {
        CancellationTokenSource? stop;
        Task[] remaining;
        lock (gate)
        {
            scheduled.Remove(id, out stop);
            pending.Remove(id);
            if (active.Remove(id, out var settled))
                settled.TrySetResult();
            if (dependencies.Remove(id, out var old))
                foreach (var dependency in old)
                    if (reverse.TryGetValue(dependency, out var waiters))
                    {
                        waiters.Remove(id);
                        if (waiters.Count == 0)
                            reverse.Remove(dependency);
                    }
            remaining = sessionTasks.GetValueOrDefault(id)?.ToArray() ?? [];
        }
        try
        {
            stop?.Cancel();
        }
        catch (ObjectDisposedException) { }
        await Task.WhenAll(remaining);
    }

    internal void Stop()
    {
        lock (gate)
            lifetime.Cancel();
    }

    internal async Task DrainAsync()
    {
        Task[] remaining;
        lock (gate)
            remaining = tasks.ToArray();
        await Task.WhenAll(remaining);
    }

    public async ValueTask DisposeAsync()
    {
        Stop();
        await DrainAsync();
        lifetime.Dispose();
    }
}
