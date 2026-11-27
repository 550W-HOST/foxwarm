using System.Security.Cryptography;
using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Hosted.Lease;

/// <summary>
/// The replicas rows: which processes exist, how to reach them, and which binary they run.
/// Rows are diagnostic and routing data; ownership is decided only by the tenant lease.
/// </summary>
internal sealed class ReplicaRegistry
{
    private readonly PgDatabase database;

    internal ReplicaRegistry(PgDatabase database) => this.database = database;

    /// <summary>
    /// A replica ID unique to this process start: the configured name (the pod or host name
    /// by default) plus a random suffix, so a restarted process never resumes an older grant.
    /// </summary>
    internal static string NewReplicaId(string? configured)
    {
        var name = string.IsNullOrWhiteSpace(configured) ? Environment.MachineName : configured.Trim();
        return name + "/" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4));
    }

    internal async Task RegisterAsync(
        string replica,
        string? advertiseAddress,
        int binaryLevel,
        int readerVersion,
        CancellationToken token,
        string role = ReplicaRoles.General,
        string? meshAddress = null
    )
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "INSERT INTO replicas (replica_id, advertise_address, binary_level, reader_version, name, role, mesh_address)"
                + " VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (replica_id) DO UPDATE SET"
                + " advertise_address = excluded.advertise_address, binary_level = excluded.binary_level,"
                + " reader_version = excluded.reader_version, role = excluded.role, mesh_address = excluded.mesh_address, heartbeat_at = now()",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        command.Parameters.Add(
            advertiseAddress is null
                ? new NpgsqlParameter { Value = DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text }
                : new NpgsqlParameter<string> { TypedValue = advertiseAddress }
        );
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = binaryLevel });
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = readerVersion });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = LogicalName(replica) });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = role });
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = (object?)meshAddress ?? DBNull.Value });
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    /// <summary>
    /// Replicas whose heartbeat is younger than <paramref name="liveFor"/>, for placement: per
    /// boot, with its logical name, role, drain flag, capacity and start time.
    /// </summary>
    internal async Task<IReadOnlyList<ReplicaRow>> LiveAsync(TimeSpan liveFor, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "SELECT replica_id, coalesce(name, replica_id), role, draining, (capacity - 'tenants' - 'version')::text, started_at, mesh_address FROM replicas"
                + " WHERE heartbeat_at > now() - make_interval(secs => $1)",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<double> { TypedValue = liveFor.TotalSeconds });
        var rows = new List<ReplicaRow>();
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        while (await reader.ReadAsync(token).ConfigureAwait(false))
            rows.Add(new(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetBoolean(3),
                System.Text.Json.Nodes.JsonNode.Parse(reader.GetString(4)) as System.Text.Json.Nodes.JsonObject ?? [],
                reader.GetFieldValue<DateTimeOffset>(5),
                reader.IsDBNull(6) ? null : reader.GetString(6)
            ));
        return rows;
    }

    /// <summary>
    /// The stable name a replica ID was made from (<see cref="NewReplicaId"/>): the same for
    /// every boot of one logical replica. Placement ranks by it; the lease owner stays the ID.
    /// </summary>
    internal static string LogicalName(string replica)
    {
        var separator = replica.LastIndexOf('/');
        return separator > 0 ? replica[..separator] : replica;
    }

    internal async Task HeartbeatAsync(string replica, CancellationToken token, string? tenantCounts = null)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "UPDATE replicas SET heartbeat_at = now(), capacity = CASE WHEN $2::text IS NULL THEN capacity"
                + " ELSE capacity || jsonb_build_object('tenants',$2::jsonb,'version',$3::text) END WHERE replica_id = $1",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        command.Parameters.Add(PgTx.Parameter(tenantCounts));
        command.Parameters.Add(PgTx.Parameter(ProductVersion.Value));
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    internal async Task RemoveAsync(string replica, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "DELETE FROM replicas WHERE replica_id = $1",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    /// <summary>The advertised address of the tenant's current owner, or null when there is none.</summary>
    internal async Task<string?> OwnerAddressAsync(string tenant, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "SELECT r.advertise_address FROM tenant_leases l"
                + " JOIN tenants t USING (tenant_id) JOIN replicas r ON r.replica_id = l.owner_replica"
                + " WHERE t.name = $1 AND l.state = 'active' AND l.expires_at > now()",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = tenant });
        return await command.ExecuteScalarAsync(token).ConfigureAwait(false) as string;
    }
}
