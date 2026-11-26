using System.Diagnostics;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Lease;

/// <summary>
/// Keeps the owner's lease and fences the runtime when it can no longer prove ownership. It
/// renews every <see cref="LeaseTimings.RenewInterval"/>. It fences when a renewal finds the
/// lease taken over, released or expired, when a write is refused by the epoch fence, or when no
/// renewal has succeeded within <see cref="LeaseTimings.FenceAfter"/> of the start of the last
/// successful one. Fencing closes every attached <see cref="TenantDb"/> and cancels
/// <see cref="Lost"/>; the hosted entry then shuts the runtime down.
/// </summary>
internal sealed class LeaseMonitor : IAsyncDisposable
{
    private readonly TenantLease lease;
    private readonly LeaseTimings timings;
    private readonly Action<string>? log;
    private readonly CancellationTokenSource lost = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly TaskCompletionSource<string> fenced = new(
        TaskCreationOptions.RunContinuationsAsynchronously
    );
    private readonly List<TenantDb> attached = [];
    private readonly object gate = new();
    private long lastSuccessStart;
    private Task? loop;
    private int released;

    internal LeaseMonitor(
        TenantLease lease,
        LeaseGrant grant,
        LeaseTimings timings,
        Action<string>? log = null
    )
    {
        timings.Validate();
        this.lease = lease;
        this.timings = timings;
        this.log = log;
        Grant = grant;
        // The acquisition counts as the first renewal, from before its transaction began: the
        // expiry counts from the transaction's database time, and the commit, the handover and
        // whatever else came before this point take from the same budget.
        lastSuccessStart = grant.AcquisitionStart != 0 ? grant.AcquisitionStart : Stopwatch.GetTimestamp();
    }

    internal LeaseGrant Grant { get; }

    /// <summary>Cancelled when the runtime fenced itself.</summary>
    internal CancellationToken Lost => lost.Token;

    /// <summary>Completes with the reason once the runtime fenced itself.</summary>
    internal Task<string> Fenced => fenced.Task;

    /// <summary>
    /// <see cref="SinceRenewal"/> when the runtime fenced itself, taken before fencing closed
    /// anything; null until then.
    /// </summary>
    internal TimeSpan? FencedSinceRenewal { get; private set; }

    /// <summary>Time since the start of the last successful renewal.</summary>
    internal TimeSpan SinceRenewal => Stopwatch.GetElapsedTime(RenewalStart);

    /// <summary>The <see cref="Stopwatch"/> timestamp of the start of the last successful renewal.</summary>
    internal long RenewalStart => Interlocked.Read(ref lastSuccessStart);

    internal void Start()
    {
        if (loop is not null)
            return;
        loop = Task.WhenAll(Task.Run(RunAsync), Task.Run(WatchDeadlineAsync));
    }

    /// <summary>Closes <paramref name="database"/> when fencing, and fences on its refused writes.</summary>
    internal void Attach(TenantDb database)
    {
        lock (gate)
        {
            if (fenced.Task.IsCompleted)
                database.Close();
            else
                attached.Add(database);
        }
        database.Fenced += error => Fence("A write was refused by the tenant lease fence: " + error.Message);
    }

    internal void Fence(string reason)
    {
        TenantDb[] databases;
        var since = SinceRenewal;
        lock (gate)
        {
            if (fenced.Task.IsCompleted)
                return;
            FencedSinceRenewal = since;
            fenced.TrySetResult(reason);
            databases = [.. attached];
        }
        foreach (var database in databases)
            database.Close();
        log?.Invoke($"[lease] Tenant {Grant.Tenant} epoch {Grant.Epoch} fenced: {reason}");
        try
        {
            lost.Cancel();
        }
        catch (AggregateException) { }
    }

    /// <summary>
    /// Stops renewing and releases the lease so a standby takes over at once. Call after the
    /// runtime has stopped writing. Does nothing once fenced.
    /// </summary>
    internal async Task ReleaseAsync(CancellationToken token = default)
    {
        if (Interlocked.Exchange(ref released, 1) != 0)
            return;
        await StopAsync().ConfigureAwait(false);
        if (fenced.Task.IsCompleted)
            return;
        Fence("released");
        try
        {
            await lease.ReleaseAsync(Grant, token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // The lease then expires after its TTL instead.
            log?.Invoke("[lease] Releasing the tenant lease failed: " + error.Message);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        lost.Dispose();
        stopping.Dispose();
    }

    private async Task StopAsync()
    {
        try
        {
            stopping.Cancel();
        }
        catch (ObjectDisposedException) { }
        if (loop is not null)
            await loop.ConfigureAwait(false);
    }

    // Fences at the deadline even while a renewal attempt is still blocked.
    private async Task WatchDeadlineAsync()
    {
        while (!stopping.IsCancellationRequested && !fenced.Task.IsCompleted)
        {
            var remaining = timings.FenceAfter - SinceRenewal;
            if (remaining <= TimeSpan.Zero)
            {
                Fence($"No lease renewal succeeded for {timings.FenceAfter.TotalSeconds:0.#} s.");
                return;
            }
            try
            {
                await Task.Delay(remaining, stopping.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task RunAsync()
    {
        while (!stopping.IsCancellationRequested && !fenced.Task.IsCompleted)
        {
            var remaining = timings.FenceAfter - SinceRenewal;
            if (remaining <= TimeSpan.Zero)
            {
                Fence($"No lease renewal succeeded for {timings.FenceAfter.TotalSeconds:0.#} s.");
                return;
            }
            var attemptStart = Stopwatch.GetTimestamp();
            using (var attempt = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token))
            {
                attempt.CancelAfter(remaining < timings.RenewInterval ? remaining : timings.RenewInterval);
                try
                {
                    // The client may not honour cancellation promptly on a dead network path;
                    // stop waiting at the attempt's bound regardless.
                    var renewal = lease.RenewAsync(Grant, timings.Ttl, attempt.Token);
                    _ = renewal.ContinueWith(
                        task => _ = task.Exception,
                        TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously
                    );
                    if (
                        await renewal
                            .WaitAsync(attempt.Token)
                            .ConfigureAwait(false)
                    )
                        Interlocked.Exchange(ref lastSuccessStart, attemptStart);
                    else
                    {
                        Fence("The tenant lease was taken over, released or expired.");
                        return;
                    }
                }
                catch (Exception) when (stopping.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception error)
                {
                    log?.Invoke("[lease] Renewal failed: " + error.Message);
                }
            }
            var untilNext = timings.RenewInterval - Stopwatch.GetElapsedTime(attemptStart);
            var untilDeadline = timings.FenceAfter - SinceRenewal;
            var delay = untilNext < untilDeadline ? untilNext : untilDeadline;
            if (delay > TimeSpan.Zero)
                try
                {
                    await Task.Delay(delay, stopping.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
        }
    }
}
