using System.Diagnostics;
using System.Threading.Channels;
using Foxwarm.Hosted.Forwarding;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Runtimes;

/// <summary>Consumes durable placement requests for this boot. A notification only shortens the next scan.</summary>
internal sealed class PlacementMaintenance(PgDatabase database, string boot, TenantReplicaOptions options,
    TenantActivations activations, Action draining, Action<string> log)
{
    private readonly Channel<bool> signals = Channel.CreateBounded<bool>(1);
    private readonly RebalancePreference preferred = new(options.RebalanceCooldown);
    private sealed record Resident(int TenantId, long Epoch, TenantProfile Profile, string? Pin, int Floor, string? Action);
    private sealed record Retirement(TenantGeneration Generation, bool IdleOnly);

    internal void Signal() => signals.Writer.TryWrite(true);

    internal async Task RunAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var work = await PlanAsync(token).ConfigureAwait(false);
                // Every retirement latches synchronously before awaiting the grace/stop of any tenant.
                await Task.WhenAll(work.Select(item => RetireAsync(item, token))).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error) { log("[hosted] Placement scan failed: " + error.Message); }
            using var next = CancellationTokenSource.CreateLinkedTokenSource(token);
            next.CancelAfter(options.Timings.RenewInterval);
            try { await signals.Reader.ReadAsync(next.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
    }

    private async Task RetireAsync(Retirement item, CancellationToken token)
    {
        var id = item.Generation.Id;
        var retired = await activations.RetireForPlacementAsync(id, "Placement hand-back", options.MoveGrace, item.IdleOnly).ConfigureAwait(false);
        // A rebalance must still be idle at the atomic admission latch. If it wasn't, undo
        // this exact provisional barrier; an intervening lifecycle edit owns its own latch.
        if (!retired && item.IdleOnly && activations.Current(id.Tenant)?.Id == id)
            await database.ClusterAsync((tx, ct) => tx.ExecuteAsync("""
                UPDATE tenant_leases l SET requested_action=NULL,draining_since=NULL FROM tenants t
                WHERE l.tenant_id=$1 AND l.owner_replica=$2 AND l.epoch=$3 AND l.state='active'
                  AND l.requested_action='move' AND t.tenant_id=l.tenant_id AND t.state='active'
                """, ct, id.TenantId, boot, id.Epoch), token).ConfigureAwait(false);
    }

    private Task<List<Retirement>> PlanAsync(CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var live = await ReplicaRegistry.LiveAsync(tx, options.Timings.Ttl, ct).ConfigureAwait(false);
        var source = live.FirstOrDefault(row => row.Replica == boot);
        if (source?.Draining == true) draining();
        var published = activations.Published().ToDictionary(g => g.Id.TenantId);
        preferred.KeepResidents(published.Keys);
        List<Retirement> work = [];
        if (published.Count == 0) return work;
        List<Resident> residents = [];
        await using (var command = tx.Command("""
            SELECT l.tenant_id,l.epoch,t.profile,t.pinned_role,t.min_reader_version,l.requested_action
            FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE t.state='active' AND l.owner_replica=$1
              AND l.state='active' AND l.expires_at>clock_timestamp() AND l.tenant_id=ANY($2) ORDER BY l.tenant_id
            """, boot, published.Keys.ToArray()))
        await using (var rows = await command.ExecuteReaderAsync(ct).ConfigureAwait(false))
            while (await rows.ReadAsync(ct).ConfigureAwait(false))
                residents.Add(new(rows.GetInt32(0), rows.GetInt64(1), TenantProfiles.Parse(rows.GetString(2)), rows.IsDBNull(3) ? null : rows.GetString(3),
                    rows.GetInt32(4), rows.IsDBNull(5) ? null : rows.GetString(5)));
        foreach (var row in residents)
        {
            var generation = published[row.TenantId];
            if (generation.Id.Epoch != row.Epoch) continue;
            var candidates = Lease.Placement.Candidates(generation.Id.Tenant, row.Profile, row.Pin, live,
                peer => peer.ReaderVersion >= row.Floor && peer.MeshAddress != null);
            var alternative = candidates.FirstOrDefault(peer => !peer.Draining && peer.Replica != boot);
            var idleOnly = row.Action is null && source?.Draining != true;
            if (idleOnly)
            {
                if (alternative is null || candidates[0].Replica == boot || generation.Gate.InFlight != 0 || !generation.Runtime!.Idle)
                {
                    preferred.Forget(row.TenantId);
                    continue;
                }
                if (!preferred.IsStable(row.TenantId, row.Epoch, alternative.Name, Stopwatch.GetTimestamp())) continue;
            }
            if (row.Action != "release" && alternative is null)
            {
                if (row.Action == "move")
                    await tx.ExecuteAsync("UPDATE tenant_leases SET requested_action=NULL WHERE tenant_id=$1 AND epoch=$2 AND owner_replica=$3 AND requested_action='move' AND draining_since IS NULL", ct, row.TenantId, row.Epoch, boot);
                continue;
            }
            var count = await tx.ExecuteAsync("""
                WITH available AS (SELECT tenant_id FROM tenant_leases WHERE tenant_id=$1 FOR NO KEY UPDATE SKIP LOCKED)
                UPDATE tenant_leases l SET requested_action=coalesce(l.requested_action,'move'),draining_since=coalesce(l.draining_since,clock_timestamp())
                FROM tenants t JOIN available USING(tenant_id) WHERE l.tenant_id=$1 AND l.epoch=$2 AND l.owner_replica=$3 AND l.state='active'
                  AND l.expires_at>clock_timestamp() AND t.tenant_id=l.tenant_id AND t.state='active'
                  AND l.requested_action IS NOT DISTINCT FROM $4::text
                """, ct, row.TenantId, row.Epoch, boot, row.Action);
            if (count != 0) work.Add(new(generation, idleOnly));
        }
        return work;
    }, token);

    // SIGTERM always retires. Publish all barriers together, keeping CH's normal settled
    // hand-back for tenants with no eligible alternative. Local gates close independently of DB I/O.
    internal async Task<HashSet<(int TenantId, long Epoch)>> MarkStoppingAsync(CancellationToken token)
    {
        HashSet<(int TenantId, long Epoch)> moving = [];
        try
        {
            await database.ClusterAsync(async (tx, ct) =>
            {
                var live = await ReplicaRegistry.LiveAsync(tx, options.Timings.Ttl, ct);
                await using (var command = tx.Command("""
                    SELECT t.tenant_id,t.name,t.profile,t.pinned_role,t.min_reader_version,l.epoch FROM tenants t JOIN tenant_leases l USING(tenant_id)
                    WHERE l.owner_replica=$1 AND l.state='active' AND l.expires_at>clock_timestamp() AND t.state='active'
                    """, boot))
                await using (var rows = await command.ExecuteReaderAsync(ct).ConfigureAwait(false))
                    while (await rows.ReadAsync(ct).ConfigureAwait(false))
                    {
                        var floor = rows.GetInt32(4);
                        if (Lease.Placement.Candidates(rows.GetString(1), TenantProfiles.Parse(rows.GetString(2)), rows.IsDBNull(3) ? null : rows.GetString(3), live,
                            row => !row.Draining && row.Replica != boot && row.ReaderVersion >= floor && row.MeshAddress != null).Count > 0)
                            moving.Add((rows.GetInt32(0),rows.GetInt64(5)));
                    }
                await tx.ExecuteAsync("UPDATE replicas SET draining=true, capacity=capacity || jsonb_build_object('stopping',true) WHERE replica_id=$1", ct, boot);
                return await tx.ExecuteAsync("""
                    WITH writable AS (SELECT tenant_id FROM tenant_leases WHERE owner_replica=$1 AND state='active'
                                      ORDER BY tenant_id FOR NO KEY UPDATE SKIP LOCKED)
                    UPDATE tenant_leases l SET draining_since=coalesce(draining_since,clock_timestamp()),
                      requested_action=CASE WHEN l.tenant_id=ANY($2) THEN coalesce(requested_action,'move') ELSE requested_action END
                    FROM tenants t JOIN writable w USING(tenant_id) WHERE l.owner_replica=$1 AND l.state='active' AND l.expires_at>clock_timestamp() AND t.tenant_id=l.tenant_id AND t.state='active'
                    """, ct, boot, moving.Select(grant => grant.TenantId).ToArray());
            }, token).ConfigureAwait(false);
        }
        catch (Exception error) when (!token.IsCancellationRequested && error is (Npgsql.NpgsqlException or TimeoutException or OperationCanceledException))
        {
            // Local stop is already latched. The marker only helps other edges reroute;
            // each confirmed tenant can still hand back its own schedule on its control connection.
            log("[hosted] Could not publish the bulk stop marker: " + error.Message);
        }
        return moving;
    }
}

/// <summary>A preference must remain continuous across observations of the same resident epoch.</summary>
internal sealed class RebalancePreference(TimeSpan cooldown)
{
    private readonly Dictionary<int, (long Epoch, string Target, long Since)> tenants = [];

    internal bool IsStable(int tenant, long epoch, string target, long now)
    {
        if (!tenants.TryGetValue(tenant, out var previous) || previous.Epoch != epoch || previous.Target != target)
            tenants[tenant] = previous = (epoch, target, now);
        return Stopwatch.GetElapsedTime(previous.Since, now) >= cooldown;
    }

    internal void Forget(int tenant) => tenants.Remove(tenant);
    internal void KeepResidents(ICollection<int> residents)
    {
        foreach (var id in tenants.Keys.Where(id => !residents.Contains(id)).ToArray()) tenants.Remove(id);
    }
}
