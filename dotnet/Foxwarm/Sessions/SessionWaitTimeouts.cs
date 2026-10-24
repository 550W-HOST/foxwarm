using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Internal one-shot deadline ownership; active JSON is the restart authority, not a general timer table.
internal sealed class SessionWaitTimeouts(SessionManager manager) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<
        string,
        (string WaitId, CancellationTokenSource Stop, Task Task)
    > jobs = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource lifetime = new();
    private readonly object gate = new();
    private readonly HashSet<Task> tasks = [];

    internal void Transition(string sessionId)
    {
        if (!manager.CanRunCallbacks(sessionId))
            return;
        var wait =
            manager.Find(sessionId)?.WaitSnapshot() ?? manager.CatalogMetadata(sessionId)?.Wait;
        var id = SessionWait.Text(wait?["id"]);
        var seconds = SessionWait.Number(wait?["timeoutSeconds"]);
        lock (gate)
        {
            if (lifetime.IsCancellationRequested)
                return;
            var existing = jobs.FirstOrDefault(pair =>
                manager.SameAdmittedLifetime(pair.Key, sessionId)
            );
            if (existing.Value.Stop is not null && existing.Value.WaitId == id)
                return;
            if (jobs.TryGetValue(sessionId, out var prior))
            {
                if (prior.WaitId == id)
                    return;
                prior.Stop.Cancel();
                jobs.TryRemove(sessionId, out _);
            }
            if (
                id is null
                || seconds is not double duration
                || SessionWait.Number(wait?["startedAt"]) is not double started
            )
                return;
            var stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            var ready = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            async Task Fire()
            {
                try
                {
                    await ready.Task;
                    var remaining =
                        started + duration * 1000 - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    while (remaining > 0)
                    {
                        await Task.Delay(
                            TimeSpan.FromMilliseconds(Math.Min(remaining, int.MaxValue - 1)),
                            stop.Token
                        );
                        remaining =
                            started
                            + duration * 1000
                            - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    }
                    stop.Token.ThrowIfCancellationRequested();
                    var rendered = duration.ToString("G", CultureInfo.InvariantCulture);
                    await manager.AdmitWaitEventAsync(
                        sessionId,
                        SessionWait.Event(
                            "wait-timeout",
                            $"wait timeout reached after {rendered}s. No newer message or event triggered this session during the wait.",
                            new JsonObject { ["seconds"] = duration },
                            new JsonObject { ["waitTimeoutId"] = id }
                        )
                    );
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
                catch (Exception error)
                {
                    manager.Find(sessionId)?.Entry.RecordBackgroundProcessorFailure(error);
                }
                finally
                {
                    lock (gate)
                        if (
                            jobs.TryGetValue(sessionId, out var current)
                            && ReferenceEquals(current.Stop, stop)
                        )
                            jobs.TryRemove(sessionId, out _);
                    stop.Dispose();
                }
            }
            var task = Fire();
            tasks.Add(task);
            _ = task.ContinueWith(
                completed =>
                {
                    lock (gate)
                        tasks.Remove(completed);
                },
                TaskScheduler.Default
            );
            jobs[sessionId] = (id, stop, task);
            ready.TrySetResult();
        }
    }

    internal async Task RetireAsync(string id)
    {
        (string WaitId, CancellationTokenSource Stop, Task Task)? job = null;
        lock (gate)
        {
            var key = jobs.Keys.FirstOrDefault(key =>
                key == id || manager.SameAdmittedLifetime(key, id)
            );
            if (key is not null && jobs.TryRemove(key, out var current))
                job = current;
        }
        if (job is { } actual)
        {
            try
            {
                actual.Stop.Cancel();
            }
            catch (ObjectDisposedException) { }
            await actual.Task;
        }
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
