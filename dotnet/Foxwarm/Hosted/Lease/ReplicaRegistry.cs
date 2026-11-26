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
        CancellationToken token
    )
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "INSERT INTO replicas (replica_id, advertise_address, binary_level, reader_version, name)"
                + " VALUES ($1, $2, $3, $4, $5) ON CONFLICT (replica_id) DO UPDATE SET"
                + " advertise_address = excluded.advertise_address, binary_level = excluded.binary_level,"
                + " reader_version = excluded.reader_version, heartbeat_at = now()",
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
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
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

    internal async Task HeartbeatAsync(string replica, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "UPDATE replicas SET heartbeat_at = now() WHERE replica_id = $1",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
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
