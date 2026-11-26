using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Hosted.Lease;

/// <summary>Lease timing (design U17: TTL 30 s, renew every 5 s, self-fence after 20 s).</summary>
/// <param name="Ttl">How long one acquisition or renewal keeps the lease.</param>
/// <param name="RenewInterval">How often the owner renews, and how often a standby retries.</param>
/// <param name="FenceAfter">
/// The owner fences itself when no renewal has succeeded for this long, measured from the start
/// of the last successful renewal on the local monotonic clock. It is below <paramref name="Ttl"/>,
/// so the owner stops before any other replica can acquire.
/// </param>
internal sealed record LeaseTimings(TimeSpan Ttl, TimeSpan RenewInterval, TimeSpan FenceAfter)
{
    internal static readonly LeaseTimings Default = new(
        TimeSpan.FromSeconds(30),
        TimeSpan.FromSeconds(5),
        TimeSpan.FromSeconds(20)
    );

    internal void Validate()
    {
        if (RenewInterval <= TimeSpan.Zero || FenceAfter <= RenewInterval || Ttl <= FenceAfter)
            throw new ArgumentException(
                "Lease timings need 0 < renew interval < fence deadline < TTL."
            );
    }
}

/// <summary>The lease this replica holds: its tenant and the epoch of its writes.</summary>
internal sealed record LeaseGrant(int TenantId, string Tenant, string Replica, long Epoch);

/// <summary>Why a replica may not take a tenant at all (as opposed to "held by another").</summary>
internal sealed class LeaseRefusedException(string message) : Exception(message);

/// <summary>
/// The lease rows of one tenant. An acquisition raises the epoch; every write transaction of
/// the owner carries that epoch and fails once it is no longer current (see
/// <see cref="TenantDb"/>). All times are database times.
/// </summary>
internal sealed class TenantLease
{
    internal const string Channel = "foxwarm_lease";

    private readonly PgDatabase database;

    internal TenantLease(PgDatabase database, string tenant, int readerVersion)
    {
        this.database = database;
        Tenant = tenant;
        ReaderVersion = readerVersion;
    }

    internal string Tenant { get; }

    /// <summary>The installation reader level of this binary.</summary>
    internal int ReaderVersion { get; }

    /// <summary>The tenant's ID; throws when the tenant doesn't exist.</summary>
    internal async Task<int> TenantIdAsync(CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "SELECT tenant_id FROM tenants WHERE name = $1",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
        return await command.ExecuteScalarAsync(token).ConfigureAwait(false) is int id
            ? id
            : throw new LeaseRefusedException(
                $"Tenant {Tenant} doesn't exist; `foxwarm db migrate --tenant {Tenant}` creates it."
            );
    }

    /// <summary>
    /// Takes the lease when it is released, expired or already this replica's, raising the
    /// epoch. Returns null while another replica holds it. Waits for in-flight writers of the
    /// previous epoch, at most <paramref name="lockTimeout"/>, and returns null when they
    /// haven't finished by then.
    /// </summary>
    internal async Task<LeaseGrant?> TryAcquireAsync(
        string replica,
        TimeSpan ttl,
        TimeSpan lockTimeout,
        CancellationToken token
    )
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        // Look first without a lock: a waiting FOR UPDATE would queue the owner's writers.
        if (!await EligibleAsync(connection, null, replica, token).ConfigureAwait(false))
            return null;
        await using var transaction = await connection.BeginTransactionAsync(token).ConfigureAwait(false);
        await using (var timeout = new NpgsqlCommand(
            "SELECT set_config('lock_timeout', $1, true)",
            connection,
            transaction
        ))
        {
            timeout.Parameters.Add(new NpgsqlParameter<string>
            {
                TypedValue = ((long)lockTimeout.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture) + "ms",
            });
            await timeout.ExecuteScalarAsync(token).ConfigureAwait(false);
        }
        try
        {
            await using (var locking = new NpgsqlCommand(
                "SELECT 1 FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1 FOR UPDATE OF l",
                connection,
                transaction
            ))
            {
                locking.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
                await locking.ExecuteScalarAsync(token).ConfigureAwait(false);
            }
        }
        catch (PostgresException error) when (error.SqlState == "55P03")
        {
            return null;
        }
        if (!await EligibleAsync(connection, transaction, replica, token).ConfigureAwait(false))
            return null;
        await using var update = new NpgsqlCommand(
            "UPDATE tenant_leases l SET owner_replica = $2, epoch = l.epoch + 1, state = 'active',"
                + " acquired_at = now(), expires_at = now() + make_interval(secs => $3)"
                + " FROM tenants t WHERE t.tenant_id = l.tenant_id AND t.name = $1"
                + " RETURNING l.tenant_id, l.epoch",
            connection,
            transaction
        );
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        update.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        int tenantId;
        long epoch;
        await using (var reader = await update.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(token).ConfigureAwait(false))
                return null;
            tenantId = reader.GetInt32(0);
            epoch = reader.GetInt64(1);
        }
        await transaction.CommitAsync(token).ConfigureAwait(false);
        return new(tenantId, Tenant, replica, epoch);
    }

    // The lease can be taken: the tenant is active, readable by this binary, and its lease is
    // released, expired or this replica's. Throws when the tenant refuses this binary.
    private async Task<bool> EligibleAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string replica,
        CancellationToken token
    )
    {
        await using var command = new NpgsqlCommand(
            "SELECT t.state, t.min_reader_version,"
                + " (l.state = 'released' OR l.expires_at <= now() OR l.owner_replica = $2)"
                + " FROM tenants t JOIN tenant_leases l USING (tenant_id) WHERE t.name = $1",
            connection,
            transaction
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        if (!await reader.ReadAsync(token).ConfigureAwait(false))
            throw new LeaseRefusedException(
                $"Tenant {Tenant} doesn't exist; `foxwarm db migrate --tenant {Tenant}` creates it."
            );
        var state = reader.GetString(0);
        var required = reader.GetInt32(1);
        if (required > ReaderVersion)
            throw new LeaseRefusedException(
                $"Tenant {Tenant} requires a Foxwarm Main that reads installation level {required}; this binary reads level {ReaderVersion}. Upgrade Main instead of downgrading."
            );
        if (state != "active")
            return false;
        return reader.GetBoolean(2);
    }

    /// <summary>
    /// Extends the lease. False when it is no longer this grant's: taken over, released or
    /// already expired. Never waits for a lock longer than the token allows.
    /// </summary>
    internal async Task<bool> RenewAsync(LeaseGrant grant, TimeSpan ttl, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "UPDATE tenant_leases SET expires_at = now() + make_interval(secs => $4)"
                + " WHERE tenant_id = $1 AND owner_replica = $2 AND epoch = $3"
                + " AND state = 'active' AND expires_at > now()",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Replica });
        command.Parameters.Add(new NpgsqlParameter<long> { TypedValue = grant.Epoch });
        command.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        return await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) == 1;
    }

    /// <summary>
    /// Gives the lease up at once and wakes waiting standbys. A grant that is no longer
    /// current changes nothing.
    /// </summary>
    internal async Task ReleaseAsync(LeaseGrant grant, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "WITH released AS (UPDATE tenant_leases SET state = 'released', expires_at = now()"
                + " WHERE tenant_id = $1 AND owner_replica = $2 AND epoch = $3 AND state = 'active'"
                + " RETURNING tenant_id)"
                + " SELECT pg_notify($4, tenant_id::text) FROM released",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Replica });
        command.Parameters.Add(new NpgsqlParameter<long> { TypedValue = grant.Epoch });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Channel });
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    /// <summary>
    /// Waits as a standby until this replica holds the lease: tries every
    /// <paramref name="poll"/> and immediately when an owner releases it.
    /// </summary>
    internal async Task<LeaseGrant> AcquireAsync(
        string replica,
        LeaseTimings timings,
        Action<Exception>? onError,
        CancellationToken token
    )
    {
        NpgsqlConnection? listener = null;
        try
        {
            while (true)
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    if (listener is null)
                    {
                        listener = await database.OpenAsync(token).ConfigureAwait(false);
                        await using var listen = new NpgsqlCommand("LISTEN " + Channel, listener);
                        await listen.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                    }
                    if (
                        await TryAcquireAsync(replica, timings.Ttl, timings.RenewInterval, token)
                            .ConfigureAwait(false)
                        is { } grant
                    )
                        return grant;
                    await listener.WaitAsync(timings.RenewInterval, token).ConfigureAwait(false);
                }
                catch (Exception error)
                    when (error is not OperationCanceledException and not LeaseRefusedException)
                {
                    onError?.Invoke(error);
                    if (listener is not null)
                        await listener.DisposeAsync().ConfigureAwait(false);
                    listener = null;
                    await Task.Delay(timings.RenewInterval, token).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            if (listener is not null)
                await listener.DisposeAsync().ConfigureAwait(false);
        }
    }
}
