using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Main-local port of waitLiveness.ts: an observed progress diagnostic, never task-completion detection.
internal sealed class WaitLiveness(SessionManager manager) : IAsyncDisposable
{
    private const int MaxConcurrentWakes = 4;
    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Dictionary<string, CancellationTokenSource> scheduled = new(
        StringComparer.Ordinal
    );
    private readonly Dictionary<string, string[]> dependencies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> reverse = new(StringComparer.Ordinal);
    private readonly Dictionary<
        string,
        (string WaitId, string Fingerprint, string LegacyFingerprint, QueueItem Item)
    > pending = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    private readonly Dictionary<string, TaskCompletionSource> active = new(StringComparer.Ordinal);
    private readonly HashSet<Task> tasks = [];
    private readonly Dictionary<string, HashSet<Task>> sessionTasks = new(StringComparer.Ordinal);

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

    private static bool Candidate(JsonObject? wait) =>
        wait is not null
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
            if (Candidate(wait))
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
        var wait = manager.Find(id)?.WaitSnapshot() ?? manager.CatalogMetadata(id)?.Wait;
        if (!manager.CanRunCallbacks(id) || !Candidate(wait))
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
        var wait = owner?.WaitSnapshot() ?? manager.CatalogMetadata(id)?.Wait;
        if (!Candidate(wait) || SessionWait.Text(wait!["id"]) != expected)
            return;
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var memo = new Dictionary<string, bool>(StringComparer.Ordinal);
        var observed = new List<string>();
        var legacyObserved = new List<string>();
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
            // Retain the original C# writer's observation only for reading its persisted receipts.
            // New identities use Source's JSON.stringify field order, omissions and spelling.
            var observation = new JsonObject
            {
                ["sessionId"] = currentId,
                ["exists"] = metadata is not null,
                ["state"] =
                    metadata?.Busy == true ? "active"
                    : state is not null ? "waiting"
                    : "idle",
                ["queueLength"] = metadata?.QueueLength ?? 0,
                ["timeoutSeconds"] = state?["timeoutSeconds"]?.DeepClone(),
                ["waitForInput"] = state?["waitForInput"]?.GetValue<bool>() == true,
                ["waitExecIds"] = state?["waitExecIds"]?.DeepClone() ?? new JsonArray(),
                ["dependencies"] = new JsonArray(
                    sources.Select(source => (JsonNode?)JsonValue.Create(source)).ToArray()
                ),
            };
            legacyObserved.Add(observation.ToJsonString());
            if (metadata is null)
                observation.Remove("state");
            else
                observation["state"] = (
                    current?.RuntimeSnapshot(metadata)
                    ?? SessionRuntimeState.Build(metadata, toolActive: false, compacting: false)
                )["state"]!.DeepClone();
            if (state?.ContainsKey("timeoutSeconds") != true)
                observation.Remove("timeoutSeconds");
            observed.Add(EcmaJson.Stringify(observation));
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
        static string Fingerprint(List<string> rows)
        {
            rows.Sort(StringComparer.Ordinal);
            return Convert
                .ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', rows))))[..24]
                .ToLowerInvariant();
        }
        var fingerprint = Fingerprint(observed);
        var legacyFingerprint = Fingerprint(legacyObserved);
        var prior = owner is null
            ? SessionWait.Strings(manager.Catalog.Get(id)?["meta"]?["waitLivenessFingerprints"])
            : owner.Entry.WithState(state => SessionWait.Strings(state.Meta["waitLivenessFingerprints"]));
        if (prior.Contains(fingerprint, StringComparer.Ordinal)
            || prior.Contains(legacyFingerprint, StringComparer.Ordinal))
            return;
        var item = SessionWait.Event(
            "wait-sources-quiescent",
            "The declared wait dependency Sessions currently show no queued, active, timed, exec-backed, input-backed, or transitively declared progress path after a short recheck. This is an observed potentially quiescent state, not proof of deadlock; explicit user or inter-session input may be needed.",
            new JsonObject { ["fingerprint"] = fingerprint },
            new JsonObject
            {
                ["waitLivenessFingerprint"] = fingerprint,
                ["waitLivenessWaitId"] = expected,
            }
        );
        lock (gate)
        {
            if (lifetime.IsCancellationRequested || active.ContainsKey(id))
                return;
            if (!pending.ContainsKey(id))
                order.Enqueue(id);
            pending[id] = (expected, fingerprint, legacyFingerprint, item);
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
            var wait = manager.Find(id)?.WaitSnapshot() ?? manager.CatalogMetadata(id)?.Wait;
            if (!Candidate(wait) || SessionWait.Text(wait!["id"]) != wake.WaitId)
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
                        // A cold projection may lag committed JSON. Check the original C# receipt
                        // against the admitted authority too; ordinary Source receipts and stale wait
                        // tokens remain checked by the save lane before delivery.
                        var owner = await manager.GetExistingAsync(id);
                        if (owner is null || owner.Entry.WithState(state =>
                            SessionWait.Strings(state.Meta["waitLivenessFingerprints"])
                                .Contains(wake.LegacyFingerprint, StringComparer.Ordinal)))
                            return;
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
