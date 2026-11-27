using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Hosted.Lease;

internal enum ImportKind { Full, Agents, AbandonAgents }

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

    /// <summary>
    /// The tenant's capability profile (<c>hosted</c> or <c>operator</c>) read by the acquiring
    /// transaction, so the runtime is built for the profile the acquisition checked.
    /// </summary>
    internal TenantProfile Profile { get; init; } = TenantProfile.Hosted;

    /// <summary>
    /// The placement role it was acquired under; renewal proves the tenant still has
    /// <see cref="Profile"/> and a pin that allows this role. Null for an import, which serves
    /// nothing and is renewed on the lease alone.
    /// </summary>
    internal string? Role { get; init; }
}

/// <summary>The slug rule of tenant names (migration 0003's DNS label check).</summary>
internal static partial class TenantSlugs
{
    internal const string Rule = "a DNS label: lowercase letters, digits and inner hyphens, at most 63 characters";

    internal static bool IsValid(string name) => Pattern().IsMatch(name);

    [System.Text.RegularExpressions.GeneratedRegex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\z")]
    private static partial System.Text.RegularExpressions.Regex Pattern();
}

/// <summary>A replica's placement role, as <c>replicas.role</c> stores it.</summary>
internal static class ReplicaRoles
{
    internal const string General = "general";

    /// <summary>The pinned master host: it serves the operator tenant and nothing else.</summary>
    internal const string MasterHost = "master-host";

    /// <summary>The operator surface's process; it never serves a tenant.</summary>
    internal const string Operator = "operator";

    /// <summary>
    /// Whether a replica of <paramref name="role"/> may take a tenant with this profile and pin
    /// (plan §3.3, Q8): the master host takes only operator-profile tenants (a pin alone isn't
    /// enough), a general replica only unpinned hosted tenants, and the operator surface none.
    /// </summary>
    internal static bool MayServe(string role, TenantProfile profile, string? pinnedRole) =>
        role switch
        {
            MasterHost => profile == TenantProfile.Operator && pinnedRole == MasterHost,
            General => profile == TenantProfile.Hosted && pinnedRole is null,
            _ => false,
        };
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

    /// <summary>
    /// Taken over, released, expired, its tenant isn't active, or its placement no longer
    /// matches the grant (profile changed, or a pin its role doesn't allow): the grant is lost.
    /// </summary>
    Lost,
}

/// <summary>Why a replica may not take a tenant at all (as opposed to "held by another").</summary>
internal sealed class LeaseRefusedException(string message) : Exception(message);

/// <summary>
/// This replica's role may not serve the tenant (its profile or pin requires another role).
/// A definite decline: another replica may take it.
/// </summary>
internal sealed class TenantNotEligibleException(string message) : Exception(message);

/// <summary>
/// The lease rows of one tenant. An acquisition raises the epoch; every write transaction of
/// the owner carries that epoch and fails once it is no longer current (see
/// <see cref="TenantDb"/>). All times are database times.
/// </summary>
internal sealed class TenantLease
{
    internal const string Channel = "foxwarm_lease";

    private readonly PgDatabase database;

    internal TenantLease(PgDatabase database, string tenant, int readerVersion, string role = ReplicaRoles.General)
    {
        this.database = database;
        Tenant = tenant;
        ReaderVersion = readerVersion;
        Role = role;
    }

    /// <summary>The placement role of the replica acquiring through this lease.</summary>
    internal string Role { get; }

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
        if (await EligibleAsync(connection, null, replica, token).ConfigureAwait(false) is null)
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
        if (await EligibleAsync(connection, transaction, replica, token).ConfigureAwait(false) is not { } profile)
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
        return new(tenantId, Tenant, replica, epoch) { AcquisitionStart = acquisitionStart, Profile = profile, Role = Role };
    }

    // The tenant's profile when the lease can be taken: the tenant is active, readable by this
    // binary, servable by this replica's role, and its lease is released, expired or this
    // replica's; null otherwise. Throws when the tenant refuses this binary, and, under the
    // row lock only, when it refuses this role.
    private async Task<TenantProfile?> EligibleAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        string replica,
        CancellationToken token
    )
    {
        await using var command = new NpgsqlCommand(
            "SELECT t.state, t.min_reader_version,"
                + " (l.state = 'released' OR l.expires_at <= now() OR l.owner_replica = $2), t.profile, t.pinned_role"
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
        RequireReader(required);
        var profile = TenantProfiles.Parse(reader.GetString(3));
        var pinned = reader.IsDBNull(4) ? null : reader.GetString(4);
        // Without the lock a mismatch is provisional: an edit toward eligibility may be in
        // flight. A free lease goes on to the locked check, which decides; a held one is
        // retried at the next poll.
        if (!ReplicaRoles.MayServe(Role, profile, pinned) && transaction is null)
            return state == "active" && reader.GetBoolean(2) ? profile : null;
        if (!ReplicaRoles.MayServe(Role, profile, pinned))
            throw new TenantNotEligibleException(
                $"Tenant {Tenant} (profile {TenantProfiles.Name(profile)}{(pinned is null ? "" : ", pinned to " + pinned)}) isn't served by a {Role} replica."
            );
        if (state != "active")
            return null;
        return reader.GetBoolean(2) ? profile : null;
    }

    private void RequireReader(int required)
    {
        if (required > ReaderVersion)
            throw new LeaseRefusedException(
                $"Tenant {Tenant} requires a Foxwarm Main that reads installation level {required}; this binary reads level {ReaderVersion}. Upgrade Main instead of downgrading."
            );
    }

    /// <summary>
    /// Claims a released or expired lease and marks the tenant importing, which keeps replicas
    /// offline. A full import may create a tenant; an Agent-only import requires an existing
    /// hosted tenant. Under its row lock, check the reader floor and the plan of a retry before
    /// advancing the observed epoch. Abandon preserves the incomplete plan until activation.
    /// This operation needs the migrating role.
    /// </summary>
    internal async Task<LeaseGrant?> TryAcquireForImportAsync(
        string replica,
        long? expectedEpoch,
        TimeSpan ttl,
        TimeSpan lockTimeout,
        CancellationToken token,
        ImportKind kind = ImportKind.Full,
        string? agentPlan = null
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
            if (kind != ImportKind.Full)
                return null;
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
            // Tenant row first, then the lease: the order a placement edit takes them (its
            // trigger locks the lease under the tenant row), so the two never wait on each other
            // in a cycle.
            await using (var tenantRow = new NpgsqlCommand(
                "SELECT state, profile, min_reader_version, agent_import_plan = $2::jsonb FROM tenants WHERE name = $1 FOR UPDATE",
                connection,
                transaction
            ))
            {
                tenantRow.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
                tenantRow.Parameters.Add(new NpgsqlParameter<string> { TypedValue = agentPlan ?? "null" });
                await using var row = await tenantRow.ExecuteReaderAsync(token).ConfigureAwait(false);
                if (!await row.ReadAsync(token).ConfigureAwait(false))
                    return null;
                var state = row.GetString(0);
                var admitted = kind switch
                {
                    ImportKind.Full => state is "active" or "importing",
                    ImportKind.Agents => state is "active" or "importing-agents",
                    _ => state == "importing-agents",
                };
                if (!admitted)
                    return null;
                if (row.GetString(1) != "hosted")
                    throw new LeaseRefusedException("The tenant keeps its Agent files on master: " + Tenant);
                RequireReader(row.GetInt32(2));
                if (kind == ImportKind.Agents && state == "importing-agents" && (row.IsDBNull(3) || !row.GetBoolean(3)))
                    throw new LeaseRefusedException("The source plan differs from the incomplete Agent import. Retry with the original volume or abandon the incomplete import first.");
            }
            await using var current = new NpgsqlCommand(
                "SELECT l.epoch, (l.state = 'released' OR l.expires_at <= now())"
                    + " FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1 FOR UPDATE OF l",
                connection,
                transaction
            );
            current.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
            await using var reader = await current.ExecuteReaderAsync(token).ConfigureAwait(false);
            if (!await reader.ReadAsync(token).ConfigureAwait(false))
                return null;
            epoch = reader.GetInt64(0);
            var free = reader.GetBoolean(1);
            if (epoch != (expectedEpoch ?? 0) || !free)
                return null;
        }
        catch (PostgresException error) when (error.SqlState == "55P03")
        {
            return null;
        }
        await using var update = new NpgsqlCommand(
            "WITH marked AS (UPDATE tenants SET state = $4, agent_import_plan = COALESCE($5::jsonb, agent_import_plan) WHERE name = $1 RETURNING tenant_id)"
                + " UPDATE tenant_leases l SET owner_replica = $2, epoch = l.epoch + 1, state = 'active',"
                + " acquired_at = now(), expires_at = now() + make_interval(secs => $3)"
                + " FROM marked WHERE l.tenant_id = marked.tenant_id RETURNING l.tenant_id, l.epoch",
            connection,
            transaction
        );
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Tenant });
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = replica });
        update.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = kind == ImportKind.Full ? "importing" : "importing-agents" });
        update.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = (object?)agentPlan ?? DBNull.Value });
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
    internal async Task ActivateImportAsync(LeaseGrant grant, CancellationToken token, ImportKind kind = ImportKind.Full)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var transaction = await connection.BeginTransactionAsync(token).ConfigureAwait(false);
        // Tenant row first, then the lease, as in a placement edit (no lock cycle).
        await using (var tenantRow = new NpgsqlCommand(
            "SELECT profile FROM tenants WHERE tenant_id = $1 FOR NO KEY UPDATE",
            connection,
            transaction
        ))
        {
            tenantRow.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
            if (await tenantRow.ExecuteScalarAsync(token).ConfigureAwait(false) is not "hosted")
                throw new LeaseRefusedException("The tenant keeps its Agent files on master: " + Tenant);
        }
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
            "WITH activated AS (UPDATE tenants SET state = 'active', agent_import_plan = NULL WHERE tenant_id = $1 AND state = $3 RETURNING tenant_id),"
                + " released AS (UPDATE tenant_leases SET state = 'released', expires_at = now()"
                + " WHERE tenant_id IN (SELECT tenant_id FROM activated) RETURNING tenant_id)"
                + " SELECT tenant_id, pg_notify($2, tenant_id::text) FROM released",
            connection,
            transaction
        );
        activate.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        activate.Parameters.Add(new NpgsqlParameter<string> { TypedValue = Channel });
        activate.Parameters.Add(new NpgsqlParameter<string> { TypedValue = kind == ImportKind.Full ? "importing" : "importing-agents" });
        if (await activate.ExecuteScalarAsync(token).ConfigureAwait(false) is null)
            throw new TenantFencedException("The tenant is not in the expected import state.");
        await transaction.CommitAsync(token).ConfigureAwait(false);
    }

    /// <summary>
    /// Extends the lease. False when it is no longer this grant's: taken over, released or
    /// already expired, or its placement no longer matches it (<see cref="PlacementHolds"/>).
    /// Never waits for a lock longer than the token allows.
    /// </summary>
    internal async Task<bool> RenewAsync(LeaseGrant grant, TimeSpan ttl, CancellationToken token)
    {
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        await using var command = new NpgsqlCommand(
            "UPDATE tenant_leases l SET expires_at = now() + make_interval(secs => $4)"
                + " FROM tenants t"
                + " WHERE l.tenant_id = $1 AND l.owner_replica = $2 AND l.epoch = $3"
                + " AND l.state = 'active' AND l.expires_at > now() AND t.tenant_id = l.tenant_id"
                + " AND " + PlacementHolds("t", "$5", "$6"),
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = grant.TenantId });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = grant.Replica });
        command.Parameters.Add(new NpgsqlParameter<long> { TypedValue = grant.Epoch });
        command.Parameters.Add(new NpgsqlParameter<double> { TypedValue = ttl.TotalSeconds });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = TenantProfiles.Name(grant.Profile) });
        command.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = (object?)grant.Role ?? DBNull.Value,
        });
        return await command.ExecuteNonQueryAsync(token).ConfigureAwait(false) == 1;
    }

    /// <summary>
    /// The renewal's placement proof over tenant row <paramref name="tenant"/>: the stored
    /// profile is still the grant's (<paramref name="profile"/>) and the pin allows the grant's
    /// role (<paramref name="role"/>). With the profile the acquisition checked unchanged, this
    /// is <see cref="ReplicaRoles.MayServe"/> for the role.
    /// </summary>
    internal static string PlacementHolds(string tenant, string profile, string role) =>
        $"({role} IS NULL OR ({tenant}.profile = {profile}"
        + $" AND ({tenant}.pinned_role IS NULL OR {tenant}.pinned_role = {role})))";

    /// <summary>
    /// The batch renewal statement: $1 tenant IDs, $2 epochs, $3 the replica, $4 the TTL in
    /// seconds, $5 the grants' profiles, $6 their roles. One row per input, in input order:
    /// renewed, and whether the row still matched (its placement included).
    /// Every time check uses <c>clock_timestamp()</c>, the actual time when the check runs, not
    /// the transaction's start, and the expiry is checked again on the row the update locked,
    /// so a row that expired while the statement waited (to be sent, or for the lock) is never
    /// renewed. A renewal never moves the expiry back, so an older renewal that commits after
    /// a newer one can't undo it.
    /// </summary>
    internal static string RenewBatchSql(bool skipLocked) =>
        "WITH batch AS (SELECT * FROM unnest($1::integer[], $2::bigint[], $5::text[], $6::text[]) WITH ORDINALITY AS b (tenant_id, epoch, profile, role, ord)),"
            + " candidates AS (SELECT l.tenant_id FROM tenant_leases l"
            + " JOIN batch b ON b.tenant_id = l.tenant_id AND b.epoch = l.epoch"
            + " JOIN tenants t ON t.tenant_id = l.tenant_id"
            + " WHERE l.owner_replica = $3 AND l.state = 'active' AND l.expires_at > clock_timestamp() AND t.state = 'active'"
            + " AND " + PlacementHolds("t", "b.profile", "b.role")
            + (skipLocked ? " FOR NO KEY UPDATE OF l SKIP LOCKED)," : " FOR NO KEY UPDATE OF l),")
            // The expiry is checked again in the target list, which runs for the locked row
            // after any lock wait (a WHERE clause may be evaluated before the wait).
            + " renewed AS (UPDATE tenant_leases l"
            + " SET expires_at = CASE WHEN l.expires_at > clock_timestamp()"
            + " THEN greatest(l.expires_at, clock_timestamp() + make_interval(secs => $4)) ELSE l.expires_at END"
            + " FROM candidates c, batch b, tenants t"
            + " WHERE l.tenant_id = c.tenant_id AND b.tenant_id = l.tenant_id AND t.tenant_id = l.tenant_id"
            + " AND l.owner_replica = $3 AND l.epoch = b.epoch AND l.state = 'active' AND t.state = 'active'"
            + " AND " + PlacementHolds("t", "b.profile", "b.role")
            + " RETURNING l.tenant_id, l.epoch, l.expires_at > clock_timestamp() AS extended)"
            + " SELECT coalesce(r.extended, false),"
            + " coalesce(l.owner_replica = $3 AND l.epoch = b.epoch AND l.state = 'active'"
            + " AND l.expires_at > clock_timestamp() AND t.state = 'active'"
            + " AND " + PlacementHolds("t", "b.profile", "b.role") + ", false)"
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
        IReadOnlyList<LeaseGrant> rows,
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
        renew.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = [.. rows.Select(row => TenantProfiles.Name(row.Profile))] });
        renew.Parameters.Add(new NpgsqlParameter<string?[]> { TypedValue = [.. rows.Select(row => row.Role)] });
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
                    when (error is not (OperationCanceledException or LeaseRefusedException or TenantNotEligibleException))
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
