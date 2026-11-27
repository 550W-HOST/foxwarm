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
internal sealed record LeaseGrant(int TenantId, string Tenant, string Replica, long Epoch)
{
    /// <summary>
    /// A <see cref="System.Diagnostics.Stopwatch"/> timestamp taken before the acquiring
    /// transaction began, so no later than the database time its expiry counts from; 0 when
    /// unknown. The lease monitor's fence clock starts here.
    /// </summary>
    internal long AcquisitionStart { get; init; }
}

/// <summary>
/// When a released tenant must run again without traffic, and the occurrence it is due for
/// (carried through the activation that the wake-up causes).
/// </summary>
internal sealed record WakeupDue(DateTimeOffset DueAt, System.Text.Json.Nodes.JsonObject? Occurrence = null);

/// <summary>A tenant's wake-up row as stored.</summary>
internal sealed record WakeupRow(
    DateTimeOffset DueAt,
    System.Text.Json.Nodes.JsonObject? Occurrence,
    DateTimeOffset? NextAttemptAt,
    int Attempts
);

/// <summary>What one row's renewal established.</summary>
internal enum RenewalOutcome
{
    /// <summary>Extended under the predicate.</summary>
    Renewed,

    /// <summary>Still this grant's, but locked by another transaction and skipped: proves nothing.</summary>
    Unproved,

    /// <summary>Taken over, released, expired, or its tenant isn't active: the grant is lost.</summary>
    Lost,
}

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

    /// <summary>
    /// How long a release waits for row locks before it gives up (the grant then expires);
    /// null waits for the statement timeout. Set on control data sources, whose connections
    /// other control traffic needs.
    /// </summary>
    internal TimeSpan? LockTimeout { get; init; }

    private string? LockTimeoutSetting =>
        LockTimeout is { } timeout
            ? Math.Max(1, (long)timeout.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture) + "ms"
            : null;

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
        var acquisitionStart = System.Diagnostics.Stopwatch.GetTimestamp();
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
                + " acquired_at = now(), expires_at = now() + make_interval(secs => $3), draining_since = NULL"
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
        return new(tenantId, Tenant, replica, epoch) { AcquisitionStart = acquisitionStart };
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
    /// Takes the lease for an import (<c>foxwarm hosted import</c>) and marks the tenant
    /// <c>importing</c>, which no replica acquires (<see cref="EligibleAsync"/>). Creates the
    /// tenant when <paramref name="expectedEpoch"/> is null; otherwise the tenant must still be
    /// at that epoch, the one the caller saw when it found the tenant empty, so no owner can have
    /// written since. Returns null when the tenant changed meanwhile or its lease is held. The
    /// lease must be free (released or expired), and the tenant <c>active</c> or
    /// <c>importing</c>. Changing the tenant's state needs the migrating role: this lease must
    /// be built over the migration connection.
    /// </summary>
    internal async Task<LeaseGrant?> TryAcquireForImportAsync(
        string replica,
        long? expectedEpoch,
        TimeSpan ttl,
        TimeSpan lockTimeout,
        CancellationToken token
    )
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        var acquisitionStart = System.Diagnostics.Stopwatch.GetTimestamp();
        await using var transaction = await connection.BeginTransactionAsync(token).ConfigureAwait(false);
        await using (var timeout = new NpgsqlCommand("SELECT set_config('lock_timeout', $1, true)", connection, transaction))
        {
            timeout.Parameters.Add(new NpgsqlParameter<string>
            {
                TypedValue = ((long)lockTimeout.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture) + "ms",
            });
            await timeout.ExecuteScalarAsync(token).ConfigureAwait(false);
        }
        if (expectedEpoch is null)
        {
            await using var create = new NpgsqlCommand(
                "WITH created AS (INSERT INTO tenants (name, state) VALUES ($1, 'importing')"
                    + " ON CONFLICT (name) DO NOTHING RETURNING tenant_id)"
                    + " INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM created RETURNING tenant_id",
                connection,
                transaction
            );
            create.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
            if (await create.ExecuteScalarAsync(token).ConfigureAwait(false) is null)
                return null;
        }
        long epoch;
        try
        {
            await using var current = new NpgsqlCommand(
                "SELECT l.epoch, (l.state = 'released' OR l.expires_at <= now()), t.state"
                    + " FROM tenants t JOIN tenant_leases l USING (tenant_id) WHERE t.name = $1 FOR UPDATE OF l, t",
                connection,
                transaction
            );
            current.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
            await using var reader = await current.ExecuteReaderAsync(token).ConfigureAwait(false);
            if (!await reader.ReadAsync(token).ConfigureAwait(false))
                return null;
            epoch = reader.GetInt64(0);
            var free = reader.GetBoolean(1);
            var state = reader.GetString(2);
            if (epoch != (expectedEpoch ?? 0) || !free || state is not ("active" or "importing"))
                return null;
        }
        catch (PostgresException error) when (error.SqlState == "55P03")
        {
            return null;
        }
        await using var update = new NpgsqlCommand(
            "WITH marked AS (UPDATE tenants SET state = 'importing' WHERE name = $1 RETURNING tenant_id)"
                + " UPDATE tenant_leases l SET owner_replica = $2, epoch = l.epoch + 1, state = 'active',"
                + " acquired_at = now(), expires_at = now() + make_interval(secs => $3)"
                + " FROM marked WHERE l.tenant_id = marked.tenant_id RETURNING l.tenant_id, l.epoch",
            connection,
            transaction
        );
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        update.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        int tenantId;
        await using (var reader = await update.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(token).ConfigureAwait(false))
                return null;
            tenantId = reader.GetInt32(0);
            epoch = reader.GetInt64(1);
        }
        await transaction.CommitAsync(token).ConfigureAwait(false);
        return new(tenantId, Tenant, replica, epoch) { AcquisitionStart = acquisitionStart };
    }

    /// <summary>
    /// Ends an import: marks the tenant <c>active</c> and releases the lease in one transaction,
    /// waking standbys. Throws <see cref="TenantFencedException"/> when <paramref name="grant"/>
    /// no longer holds the lease, so an import that lost it never activates the tenant. Needs
    /// the migrating role, like <see cref="TryAcquireForImportAsync"/>.
    /// </summary>
    internal async Task ActivateImportAsync(LeaseGrant grant, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var transaction = await connection.BeginTransactionAsync(token).ConfigureAwait(false);
        await using (var held = new NpgsqlCommand(
            "SELECT 1 FROM tenant_leases WHERE tenant_id = $1 AND owner_replica = $2 AND epoch = $3"
                + " AND state = 'active' AND expires_at > now() FOR UPDATE",
            connection,
            transaction
        ))
        {
            held.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
            held.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Replica });
            held.Parameters.Add(new NpgsqlParameter<long> { TypedValue = grant.Epoch });
            if (await held.ExecuteScalarAsync(token).ConfigureAwait(false) is null)
                throw new TenantFencedException("The import no longer holds the tenant lease.");
        }
        await using var activate = new NpgsqlCommand(
            "WITH activated AS (UPDATE tenants SET state = 'active' WHERE tenant_id = $1 AND state = 'importing'),"
                + " released AS (UPDATE tenant_leases SET state = 'released', expires_at = now()"
                + " WHERE tenant_id = $1 RETURNING tenant_id)"
                + " SELECT pg_notify($2, tenant_id::text) FROM released",
            connection,
            transaction
        );
        activate.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        activate.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Channel });
        await activate.ExecuteNonQueryAsync(token).ConfigureAwait(false);
        await transaction.CommitAsync(token).ConfigureAwait(false);
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
    /// The batch renewal statement: $1 tenant IDs, $2 epochs, $3 the replica, $4 the TTL in
    /// seconds. One row per input, in input order: renewed, and whether the row still matched.
    /// Every time check uses <c>clock_timestamp()</c>, the actual time when the check runs, not
    /// the transaction's start, and the expiry is checked again on the row the update locked,
    /// so a row that expired while the statement waited (to be sent, or for the lock) is never
    /// renewed. A renewal never moves the expiry back, so an older renewal that commits after
    /// a newer one can't undo it.
    /// </summary>
    internal static string RenewBatchSql(bool skipLocked) =>
        "WITH batch AS (SELECT * FROM unnest($1::integer[], $2::bigint[]) WITH ORDINALITY AS b (tenant_id, epoch, ord)),"
            + " candidates AS (SELECT l.tenant_id FROM tenant_leases l"
            + " JOIN batch b ON b.tenant_id = l.tenant_id AND b.epoch = l.epoch"
            + " JOIN tenants t ON t.tenant_id = l.tenant_id"
            + " WHERE l.owner_replica = $3 AND l.state = 'active' AND l.expires_at > clock_timestamp() AND t.state = 'active'"
            + (skipLocked ? " FOR NO KEY UPDATE OF l SKIP LOCKED)," : " FOR NO KEY UPDATE OF l),")
            // The expiry is checked again in the target list, which runs for the locked row
            // after any lock wait (a WHERE clause may be evaluated before the wait).
            + " renewed AS (UPDATE tenant_leases l"
            + " SET expires_at = CASE WHEN l.expires_at > clock_timestamp()"
            + " THEN greatest(l.expires_at, clock_timestamp() + make_interval(secs => $4)) ELSE l.expires_at END"
            + " FROM candidates c, batch b, tenants t"
            + " WHERE l.tenant_id = c.tenant_id AND b.tenant_id = l.tenant_id AND t.tenant_id = l.tenant_id"
            + " AND l.owner_replica = $3 AND l.epoch = b.epoch AND l.state = 'active' AND t.state = 'active'"
            + " RETURNING l.tenant_id, l.epoch, l.expires_at > clock_timestamp() AS extended)"
            + " SELECT coalesce(r.extended, false),"
            + " coalesce(l.owner_replica = $3 AND l.epoch = b.epoch AND l.state = 'active'"
            + " AND l.expires_at > clock_timestamp() AND t.state = 'active', false)"
            + " FROM batch b LEFT JOIN renewed r ON r.tenant_id = b.tenant_id AND r.epoch = b.epoch"
            + " LEFT JOIN tenant_leases l ON l.tenant_id = b.tenant_id"
            + " LEFT JOIN tenants t ON t.tenant_id = b.tenant_id ORDER BY b.ord";

    /// <summary>
    /// Renews a batch of this replica's grants: one network round trip, the lock timeout and
    /// the statement in one implicit transaction (<see cref="RenewBatchSql"/>). With
    /// <paramref name="skipLocked"/>, rows another transaction holds locked (a takeover's
    /// <c>FOR UPDATE</c>) are skipped instead of waited for; <c>FOR NO KEY UPDATE</c> doesn't
    /// conflict with writers' <c>FOR KEY SHARE</c>. Returns one outcome per row, in input order,
    /// once the transaction committed. Throws on a lock timeout (55P03), a connection failure
    /// or an unconfirmed commit, when nothing is known.
    /// </summary>
    internal static async Task<RenewalOutcome[]> RenewBatchAsync(
        PgDatabase control,
        string replica,
        IReadOnlyList<(int TenantId, long Epoch)> rows,
        TimeSpan ttl,
        TimeSpan lockTimeout,
        bool skipLocked,
        CancellationToken token
    )
    {
        await using var connection = await control.OpenAsync(token).ConfigureAwait(false);
        // No explicit transaction: a batch up to its Sync is one implicit transaction, which
        // commits when the server finishes it. The setting is local to that transaction.
        await using var batch = new NpgsqlBatch(connection);
        var timeout = new NpgsqlBatchCommand("SELECT set_config('lock_timeout', $1, true)");
        timeout.Parameters.Add(new NpgsqlParameter<string>
        {
            TypedValue = Math.Max(1, (long)lockTimeout.TotalMilliseconds).ToString(System.Globalization.CultureInfo.InvariantCulture) + "ms",
        });
        batch.BatchCommands.Add(timeout);
        var renew = new NpgsqlBatchCommand(RenewBatchSql(skipLocked));
        renew.Parameters.Add(new NpgsqlParameter<int[]> { TypedValue = [.. rows.Select(row => row.TenantId)] });
        renew.Parameters.Add(new NpgsqlParameter<long[]> { TypedValue = [.. rows.Select(row => row.Epoch)] });
        renew.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        renew.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        batch.BatchCommands.Add(renew);
        var outcomes = new RenewalOutcome[rows.Count];
        await using (var reader = await batch.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            // The timeout's result first, then the renewal's rows.
            if (!await reader.NextResultAsync(token).ConfigureAwait(false))
                throw new InvalidOperationException("The renewal returned no result.");
            var index = 0;
            while (await reader.ReadAsync(token).ConfigureAwait(false))
                outcomes[index++] = reader.GetBoolean(0)
                    ? RenewalOutcome.Renewed
                    : reader.GetBoolean(1) ? RenewalOutcome.Unproved : RenewalOutcome.Lost;
            if (index != rows.Count)
                throw new InvalidOperationException("The renewal returned a row count that doesn't match the batch.");
            // Consumes the batch to its end: a failed commit surfaces here, before anything is
            // published.
            while (await reader.NextResultAsync(token).ConfigureAwait(false)) { }
        }
        return outcomes;
    }

    /// <summary>
    /// Gives the lease up at once and wakes waiting standbys. A grant that is no longer
    /// current changes nothing.
    /// </summary>
    internal async Task ReleaseAsync(LeaseGrant grant, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var batch = new NpgsqlBatch(connection);
        if (LockTimeoutSetting is { } timeout)
        {
            var setting = new NpgsqlBatchCommand("SELECT set_config('lock_timeout', $1, true)");
            setting.Parameters.Add(new NpgsqlParameter<string> { TypedValue = timeout });
            batch.BatchCommands.Add(setting);
        }
        var command = new NpgsqlBatchCommand(
            "WITH released AS (UPDATE tenant_leases SET state = 'released', expires_at = now(), draining_since = NULL"
                + " WHERE tenant_id = $1 AND owner_replica = $2 AND epoch = $3 AND state = 'active'"
                + " RETURNING tenant_id)"
                + " SELECT pg_notify($4, tenant_id::text) FROM released"
        );
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Replica });
        command.Parameters.Add(new NpgsqlParameter<long> { TypedValue = grant.Epoch });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Channel });
        batch.BatchCommands.Add(command);
        await batch.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    /// <summary>
    /// Releases the lease at <paramref name="grant"/>'s epoch and, in the same transaction,
    /// writes the tenant's wake-up row: <paramref name="wakeup"/>, or no row when null (nothing
    /// due). False, with nothing written, when the grant is no longer current.
    /// </summary>
    internal Task<bool> ReleaseWithWakeupAsync(
        LeaseGrant grant,
        WakeupDue? wakeup,
        CancellationToken token
    ) =>
        ReleaseUnderLeaseAsync(
            grant,
            wakeup is null
                ? ("SELECT foxwarm_clear_wakeup()", [])
                : (
                    "SELECT foxwarm_set_wakeup($1, $2)",
                    [
                        new NpgsqlParameter<DateTime> { TypedValue = wakeup.DueAt.UtcDateTime },
                        Json(wakeup.Occurrence),
                    ]
                ),
            token
        );

    /// <summary>
    /// Releases the lease after a start that failed, recording that no replica should try
    /// for <paramref name="backoff"/> (from database time). An existing wake-up row keeps its due time and
    /// occurrence; with <paramref name="create"/>, a tenant without one gets a row due now, so
    /// a scan retries it. False when the grant is no longer current.
    /// </summary>
    internal Task<bool> ReleaseAfterFailedStartAsync(
        LeaseGrant grant,
        TimeSpan backoff,
        bool create,
        CancellationToken token
    ) =>
        ReleaseUnderLeaseAsync(
            grant,
            (
                "SELECT foxwarm_wakeup_backoff(now() + make_interval(secs => $1), $2)",
                [
                    new NpgsqlParameter<double> { TypedValue = backoff.TotalSeconds },
                    new NpgsqlParameter<bool> { TypedValue = create },
                ]
            ),
            token
        );

    private async Task<bool> ReleaseUnderLeaseAsync(
        LeaseGrant grant,
        (string Sql, NpgsqlParameter[] Parameters) wakeup,
        CancellationToken token
    )
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var transaction = await connection.BeginTransactionAsync(token).ConfigureAwait(false);
        try
        {
            await using (var context = new NpgsqlCommand(
                "SELECT set_config('foxwarm.tenant', $1, true), set_config('foxwarm.epoch', $2, true),"
                    + " set_config('lock_timeout', coalesce($3, current_setting('lock_timeout')), true)",
                connection,
                transaction
            ))
            {
                context.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.TenantId.ToString(System.Globalization.CultureInfo.InvariantCulture) });
                context.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Epoch.ToString(System.Globalization.CultureInfo.InvariantCulture) });
                context.Parameters.Add(
                    LockTimeoutSetting is { } timeout
                        ? new NpgsqlParameter<string> { TypedValue = timeout }
                        : new NpgsqlParameter { Value = DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text }
                );
                await context.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }
            await using (var write = new NpgsqlCommand(wakeup.Sql, connection, transaction))
            {
                write.Parameters.AddRange(wakeup.Parameters);
                await write.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }
        }
        catch (PostgresException error) when (error.SqlState is TenantDb.FenceSqlState or "55P03")
        {
            return false;
        }
        await using var release = new NpgsqlCommand(
            "WITH released AS (UPDATE tenant_leases SET state = 'released', expires_at = now(), draining_since = NULL"
                + " WHERE tenant_id = $1 AND owner_replica = $2 AND epoch = $3 AND state = 'active'"
                + " AND expires_at > now() RETURNING tenant_id)"
                + " SELECT pg_notify($4, tenant_id::text) FROM released",
            connection,
            transaction
        );
        release.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        release.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Replica });
        release.Parameters.Add(new NpgsqlParameter<long> { TypedValue = grant.Epoch });
        release.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Channel });
        var released = false;
        try
        {
            await using var reader = await release.ExecuteReaderAsync(token).ConfigureAwait(false);
            released = await reader.ReadAsync(token).ConfigureAwait(false);
        }
        catch (PostgresException error) when (error.SqlState == "55P03")
        {
            return false;
        }
        if (!released)
            return false;
        await transaction.CommitAsync(token).ConfigureAwait(false);
        return true;
    }

    /// <summary>The tenant's wake-up row, or null.</summary>
    internal async Task<WakeupRow?> ReadWakeupAsync(int tenantId, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "SELECT due_at, occurrence::text, next_attempt_at, attempts FROM tenant_wakeups WHERE tenant_id = $1",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = tenantId });
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        if (!await reader.ReadAsync(token).ConfigureAwait(false))
            return null;
        return new(
            new DateTimeOffset(reader.GetFieldValue<DateTime>(0)),
            reader.IsDBNull(1) ? null : System.Text.Json.Nodes.JsonNode.Parse(reader.GetString(1))!.AsObject(),
            reader.IsDBNull(2) ? null : new DateTimeOffset(reader.GetFieldValue<DateTime>(2)),
            reader.GetInt32(3)
        );
    }

    private static NpgsqlParameter Json(System.Text.Json.Nodes.JsonObject? value) =>
        new()
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Jsonb,
            Value = value is null ? DBNull.Value : value.ToJsonString(),
        };

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
