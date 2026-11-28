using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted.Lease;

internal enum PlacementAction { Move, Release }
internal enum PlacementRequestResult { Accepted, AlreadyRequested, Conflict, Stale, NoTarget }

/// <summary>The exact-boot/epoch mutations behind operator placement actions.</summary>
internal sealed class ReplicaPlacementRequests(PgDatabase database, LeaseTimings timings)
{
    internal Task<bool> RequestReplicaDrainAsync(string boot, CancellationToken token) =>
        database.ClusterAsync(async (tx, ct) =>
        {
            var changed = await tx.ExecuteAsync("UPDATE replicas SET draining=true WHERE replica_id=$1 AND heartbeat_at > clock_timestamp()-make_interval(secs=>$2)", ct, boot, timings.Ttl.TotalSeconds);
            if (changed != 0) await NotifyAsync(tx, ct);
            return changed != 0;
        }, token);

    internal Task<PlacementRequestResult> RequestTenantAsync(string slug, int expectedTenantId, string expectedBoot,
        long expectedEpoch, PlacementAction action, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        // Same tenant-then-lease lock order as lifecycle changes; compare the immutable ID too:
        // a recreated slug may return to the same boot at its first epoch.
        await using var tenant = tx.Command("SELECT profile,pinned_role,min_reader_version FROM tenants WHERE tenant_id=$1 AND name=$2 AND state='active' FOR UPDATE", expectedTenantId, slug);
        TenantProfile profile;
        string? pin;
        int floor;
        await using (var reader = await tenant.ExecuteReaderAsync(ct))
        {
            if (!await reader.ReadAsync(ct)) return PlacementRequestResult.Stale;
            profile = TenantProfiles.Parse(reader.GetString(0));
            pin = reader.IsDBNull(1) ? null : reader.GetString(1);
            floor = reader.GetInt32(2);
        }
        var value = action == PlacementAction.Move ? "move" : "release";
        // An Installation-document writer holds KEY SHARE on this lease while raising
        // the tenant's reader floor. NO KEY UPDATE serializes placement operations without
        // blocking that writer after we've already locked the tenant.
        await using var lease = tx.Command("SELECT 1 FROM tenant_leases WHERE tenant_id=$1 FOR NO KEY UPDATE", expectedTenantId);
        if (await lease.ExecuteScalarAsync(ct) is null) return PlacementRequestResult.Stale;
        // Evaluate expiry *after* the row lock was granted, including for an idempotent retry.
        await using var current = tx.Command("SELECT requested_action FROM tenant_leases WHERE tenant_id=$1 AND owner_replica=$2 AND epoch=$3 AND state='active' AND expires_at>clock_timestamp()", expectedTenantId, expectedBoot, expectedEpoch);
        var pending = await current.ExecuteScalarAsync(ct);
        if (pending is null) return PlacementRequestResult.Stale;
        if (pending is string existing) return existing == value ? PlacementRequestResult.AlreadyRequested : PlacementRequestResult.Conflict;
        if (action == PlacementAction.Move)
        {
            var peers = await ReplicaRegistry.LiveAsync(tx, timings.Ttl, ct);
            if (!Placement.Candidates(slug, profile, pin, peers, r => r.ReaderVersion >= floor && r.MeshAddress != null).Any(r => !r.Draining && r.Replica != expectedBoot))
                return PlacementRequestResult.NoTarget;
        }
        var changed = await tx.ExecuteAsync("UPDATE tenant_leases SET requested_action=$2 WHERE tenant_id=$1 AND expires_at>clock_timestamp()", ct, expectedTenantId, value);
        if (changed == 0) return PlacementRequestResult.Stale;
        await NotifyAsync(tx, ct);
        return PlacementRequestResult.Accepted;
    }, token);

    private static Task<int> NotifyAsync(PgTx tx, CancellationToken token) =>
        tx.ExecuteAsync("SELECT pg_notify('foxwarm_tenants','placement')", token);
}
