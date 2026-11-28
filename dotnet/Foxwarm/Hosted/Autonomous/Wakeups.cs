using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Hosted.Autonomous;

// The scan only discovers demand. A replica's router determines whether its boot may try;
// the ordinary activation coordinator and lease CAS decide who actually starts the tenant.
internal sealed class Wakeups(
    PgDatabase database,
    TimeSpan liveFor,
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
            : "l.state = 'released' AND w.due_at <= now() + make_interval(secs => $4)";
        return await database.ClusterAsync(async (tx, ct) =>
        {
            object?[] parameters = recovery
                ? [liveFor.TotalSeconds, RankGrace.TotalSeconds, BatchSize]
                : [liveFor.TotalSeconds, RankGrace.TotalSeconds, BatchSize, Interval.TotalSeconds];
            await using var command = tx.Command($"""
                WITH live AS (
                    SELECT DISTINCT ON (coalesce(name, replica_id)) role, draining, reader_version
                    FROM replicas WHERE heartbeat_at > now() - make_interval(secs => $1)
                    ORDER BY coalesce(name, replica_id), started_at, replica_id
                )
                SELECT t.tenant_id, t.name, now() >= {due} + make_interval(secs => $2) FROM {source}
                  JOIN tenants t ON t.tenant_id = l.tenant_id
                WHERE t.state = 'active' AND {predicate}
                  AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= now())
                  AND EXISTS (SELECT FROM live r WHERE NOT r.draining AND r.reader_version >= t.min_reader_version
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

    internal async Task ScanAsync(CancellationToken token)
    {
        foreach (var cause in new[] { ActivationCause.Wakeup, ActivationCause.Recovery })
        {
            var candidates = await ReadAsync(cause, token).ConfigureAwait(false);
            await Parallel.ForEachAsync(candidates, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = token },
                async (item, ct) =>
                {
                    try
                    {
                        if (await mayStart(item.Slug, item.GraceElapsed, ct).ConfigureAwait(false))
                            await activate(item.Slug, item.Cause, ct).ConfigureAwait(false);
                    }
                    catch (Exception error) when (error is TenantHeldElsewhereException or TenantNotEligibleException or LeaseRefusedException or TenantFencedException) { }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                    catch (Exception error) { log($"[hosted] Wake-up for tenant {item.TenantId} failed: {error.Message}"); }
                }).ConfigureAwait(false);
        }
    }

    internal async Task RunAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(Interval);
        try
        {
            do
            {
                try { await ScanAsync(token).ConfigureAwait(false); }
                catch (Exception error) when (!token.IsCancellationRequested) { log("[hosted] Wake-up scan failed: " + error.Message); }
            } while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }
}
