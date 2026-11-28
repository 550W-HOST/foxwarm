using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Hosted.Forwarding;

internal sealed record DispatchRoute(string Boot, long Epoch, string? MeshAddress);
internal sealed record TenantRouteState(TenantProfile Profile, string? Pin, bool Available, bool Draining, DispatchRoute? Owner, int TenantId, long Epoch, int ReaderFloor, string? ExcludedBoot);

/// <summary>Routing evidence comes from the current lease; replica metadata only supplies an address.</summary>
internal sealed class RouteDirectory(PgDatabase database)
{
    internal async Task<TenantRouteState?> ReadAsync(string slug, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "SELECT t.profile,t.pinned_role,t.state = 'active',l.draining_since IS NOT NULL,"
            + "CASE WHEN l.state = 'active' AND l.expires_at > now() THEN l.owner_replica END,l.epoch,r.mesh_address,t.tenant_id,t.min_reader_version,CASE WHEN l.requested_action='move' THEN l.owner_replica END "
            + "FROM tenants t JOIN tenant_leases l USING (tenant_id) LEFT JOIN replicas r ON r.replica_id=l.owner_replica "
            + "WHERE t.name=$1", connection);
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = slug });
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        if (!await reader.ReadAsync(token).ConfigureAwait(false))
            return null;
        var owner = reader.IsDBNull(4) ? null : new DispatchRoute(reader.GetString(4), reader.GetInt64(5),
            reader.IsDBNull(6) ? null : reader.GetString(6));
        return new(TenantProfiles.Parse(reader.GetString(0)), reader.IsDBNull(1) ? null : reader.GetString(1),
            reader.GetBoolean(2), owner is not null && reader.GetBoolean(3), owner, reader.GetInt32(7), reader.GetInt64(5), reader.GetInt32(8), reader.IsDBNull(9) ? null : reader.GetString(9));
    }
    internal Task<bool> CancelUnavailableMoveAsync(TenantRouteState state, CancellationToken token) =>
        database.ClusterAsync(async (tx, ct) => await tx.ExecuteAsync("""
            UPDATE tenant_leases SET requested_action=NULL WHERE tenant_id=$1 AND epoch=$2 AND owner_replica=$3
               AND requested_action='move' AND (state='released' OR expires_at<=clock_timestamp())
            """, ct, state.TenantId, state.Epoch, state.ExcludedBoot) == 1, token);

}
