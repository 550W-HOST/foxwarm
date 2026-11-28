using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Hosted.Autonomous;

// The scan only discovers demand. A replica's router determines whether its boot may try;
// the ordinary activation coordinator and lease CAS decide who actually starts the tenant.
internal sealed class Wakeups(
    PgDatabase database,
    TimeSpan liveFor,
    string role, int readerVersion,
    Func<string, bool, CancellationToken, Task<bool>> mayStart,
    Func<string, ActivationCause, CancellationToken, Task> activate,
    Action<string> log)
{
    internal static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan RankGrace = TimeSpan.FromSeconds(15);
    internal const int BatchSize = 64;

    internal sealed record Candidate(int TenantId, string Slug, ActivationCause Cause, bool GraceElapsed);

    internal async Task<Candidate[]> ReadAsync(ActivationCause cause, CancellationToken token)
    {
        bool recovery = cause == ActivationCause.Recovery;
        var due = recovery ? "l.expires_at" : "w.due_at";
        var source = recovery
            ? "tenant_leases l LEFT JOIN tenant_wakeups w USING (tenant_id)"
            : "tenant_wakeups w JOIN tenant_leases l USING (tenant_id)";
        var predicate = recovery
            ? "l.state = 'active' AND l.expires_at <= now()"
            : "l.state = 'released' AND w.due_at <= now() + make_interval(secs => $6)";
        return await database.ClusterAsync(async (tx, ct) =>
        {
            object?[] parameters = recovery
                ? [liveFor.TotalSeconds, RankGrace.TotalSeconds, BatchSize, role, readerVersion]
                : [liveFor.TotalSeconds, RankGrace.TotalSeconds, BatchSize, role, readerVersion, Interval.TotalSeconds];
            await using var command = tx.Command($"""
                WITH live AS (
                    SELECT DISTINCT ON (coalesce(name, replica_id)) role, capacity, reader_version
                    FROM replicas WHERE heartbeat_at > now() - make_interval(secs => $1)
                    ORDER BY coalesce(name, replica_id), started_at, replica_id
                )
                SELECT t.tenant_id, t.name, now() >= {due} + make_interval(secs => $2) FROM {source}
                  JOIN tenants t ON t.tenant_id = l.tenant_id
                WHERE t.state = 'active' AND {predicate} AND t.min_reader_version <= $5
                  AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= now())
                  AND EXISTS (SELECT FROM live r WHERE r.role=$4 AND (r.capacity->>'stopping') IS DISTINCT FROM 'true' AND (r.capacity->>'acceptingNew') IS DISTINCT FROM 'false' AND r.reader_version >= t.min_reader_version
                    AND ((t.profile = 'hosted' AND t.pinned_role IS NULL AND r.role = 'general')
                      OR (t.profile = 'operator' AND r.role = 'master-host')))
                ORDER BY {due}, t.tenant_id LIMIT $3
                """, parameters);
            List<Candidate> rows = [];
            await using var reader = await command.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
                rows.Add(new(reader.GetInt32(0), reader.GetString(1), cause, reader.GetBoolean(2)));
            return rows.ToArray();
        }, token).ConfigureAwait(false);
    }

    // One slow builder must not stall discovery. Reserve slots separately for expired grants
    // and due wake-ups, so a full class cannot indefinitely crowd the other out.
    private readonly object gate = new();
    private readonly Dictionary<int, (ActivationCause Cause, Task Work)> outstanding = [];
    internal async Task DiscoverAsync(CancellationToken token)
    {
        foreach (var cause in new[] { ActivationCause.Wakeup, ActivationCause.Recovery })
        {
            foreach (var candidate in await ReadAsync(cause, token).ConfigureAwait(false))
            {
                lock (gate)
                {
                    if (outstanding.ContainsKey(candidate.TenantId)) continue;
                    if (outstanding.Values.Count(item => item.Cause == cause) >= 4) break;
                    // Placement reads complete within the router's request budget. Only actual
                    // activations consume a slot across scans.
                }
                try
                {
                    if (!await mayStart(candidate.Slug, candidate.GraceElapsed, token).ConfigureAwait(false)) continue;
                }
                catch (Exception error) when (!token.IsCancellationRequested)
                {
                    log($"[hosted] Placement lookup for tenant {candidate.TenantId} failed: {error.Message}");
                    continue;
                }
                lock (gate)
                {
                    if (outstanding.ContainsKey(candidate.TenantId) || outstanding.Values.Count(item => item.Cause == cause) >= 4) continue;
                    outstanding[candidate.TenantId] = (cause, Task.Run(async () =>
                    {
                        try { await activate(candidate.Slug, cause, token).ConfigureAwait(false); }
                        catch (Exception error) when (error is TenantHeldElsewhereException or TenantNotEligibleException
                            or LeaseRefusedException or TenantFencedException or AutonomousDemandSettledException) { }
                        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                        catch (Exception error) { log($"[hosted] Wake-up for tenant {candidate.TenantId} failed: {error.Message}"); }
                        finally { lock (gate) outstanding.Remove(candidate.TenantId); }
                    }));
                }
            }
        }
    }

    private readonly System.Threading.Channels.Channel<bool> signals = System.Threading.Channels.Channel.CreateBounded<bool>(1);
    internal void Signal() => signals.Writer.TryWrite(true);

    internal Task DrainAsync()
    {
        lock (gate) return Task.WhenAll(outstanding.Values.Select(task => task.Work));
    }

    internal async Task RunAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                try { await DiscoverAsync(token).ConfigureAwait(false); }
                catch (Exception error) when (!token.IsCancellationRequested) { log("[hosted] Wake-up scan failed: " + error.Message); }
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(token);
                wait.CancelAfter(Interval);
                try { await signals.Reader.ReadAsync(wait.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally { await DrainAsync().ConfigureAwait(false); }
    }
}
