using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;

namespace Foxwarm.Hosted.Operator;

internal sealed class OperatorProblem(int status, string message) : Exception(message)
{
    internal int Status { get; } = status;
}

internal sealed partial class OperatorStore(PgDatabase database, KeyEncryptionKey kek, Blobs.S3BlobSettings? deletionS3 = null)
{
    internal static readonly TimeSpan SetupLifetime = TimeSpan.FromHours(24);
    internal const string Applied = "Applies within one lease renewal, usually at once. New requests use the new settings, and running work is allowed to finish.";
    internal const string SetupPrefix = "fwsetup_";
    internal static byte[] Hash(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
    private static string RandomToken(string prefix) => prefix + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static async Task<object?> Scalar(PgTx tx, string sql, CancellationToken token, params object?[] parameters)
    {
        await using var command = tx.Command(sql, parameters);
        return await command.ExecuteScalarAsync(token);
    }

    internal Task CheckRoleAsync(CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
        await Scalar(tx, "SELECT current_user = operator_role FROM schema_info", ct) is true
            ? true : throw new HostedBootstrapException("The operator service must connect as the database's operator role."), token);

    internal Task RequireOperatorHostnameAsync(string host, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
        await Scalar(tx, "SELECT 1 FROM tenant_hostnames WHERE hostname=$1", ct, OperatorListener.CanonicalHost(host)) is int
            ? throw new HostedBootstrapException("The operator hostname is already assigned to a tenant.") : true, token);

    internal static Task<string> IssueAsync(PgDatabase owner, CancellationToken token) => owner.ClusterAsync(async (tx, ct) =>
    {
        if (await Scalar(tx, "SELECT current_user = pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'operator_credentials'::regclass", ct) is not true)
            throw new HostedBootstrapException("Creating an operator token requires the migration database role.");
        var value = RandomToken("fwop_");
        var hash = Convert.ToHexStringLower(Hash(value));
        await tx.ExecuteAsync("INSERT INTO operator_credentials (id, hash) VALUES ($1, $2)", ct, hash[..24], hash);
        return value;
    }, token);

    internal Task<bool> AuthorizedAsync(string value, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var hash = Convert.ToHexStringLower(Hash(value));
        return await Scalar(tx, "SELECT 1 FROM operator_credentials WHERE id=$1 AND hash=$2 AND revoked_at IS NULL", ct, hash[..24], hash) is int;
    }, token);

    internal Task<JsonObject> CreateAsync(string slug, string profile, string hostname, CancellationToken token) =>
        database.ClusterAsync(async (tx, ct) =>
        {
            await RequireCurrentReplicas(tx, ct);
            var id = (int)(await Scalar(tx, "INSERT INTO tenants(name,profile,pinned_role,credential_version) VALUES ($1,$2,$3,1) RETURNING tenant_id", ct, slug, profile, Pin(profile)))!;
            var setup = await IssueSetupAsync(tx, id, 1, ct);
            await tx.ExecuteAsync("INSERT INTO tenant_leases(tenant_id,epoch,state) VALUES ($1,1,'active')", ct, id);
            var keyId = InstanceKeys.NewKeyId();
            var key = RandomNumberGenerator.GetBytes(InstanceKeys.KeyBytes);
            try
            {
                var (nonce, wrapped) = kek.Wrap(id, keyId, key);
                await tx.ExecuteAsync("SELECT foxwarm_provision_key($1,$2,$3,$4,$5)", ct, id, keyId, kek.KeyId, nonce, wrapped);
            }
            finally { CryptographicOperations.ZeroMemory(key); }
            await tx.ExecuteAsync("INSERT INTO tenant_hostnames(tenant_id,hostname,kind) VALUES ($1,$2,'primary')", ct, id, hostname);
            return new JsonObject { ["slug"] = slug, ["setupToken"] = setup };
        }, token);

    private const string TenantJson = """
        SELECT jsonb_build_object('slug',name,'profile',profile,'state',state,'limits',limits,'journal',settings->'journal',
            'primaryHostname',(SELECT hostname FROM tenant_hostnames h WHERE h.tenant_id=t.tenant_id AND kind='primary'),
            'ceiling',(SELECT text FROM operator_documents d WHERE d.tenant_id=t.tenant_id AND d.name='ceiling')) || CASE WHEN t.state='deleting' AND coalesce((SELECT d.objects_pending FROM operator_deletions d WHERE d.tenant_id=t.tenant_id), $1) THEN '{"objectsPending":true}'::jsonb ELSE '{}'::jsonb END AS item FROM tenants t
        """;

    internal Task<JsonNode> ReadAsync(string? slug, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var text = slug is null
            ? await Scalar(tx, "SELECT coalesce(jsonb_agg(item ORDER BY item->>'slug'), '[]')::text FROM (" + TenantJson + ") rows", ct, deletionS3 is not null)
            : await Scalar(tx, "SELECT item::text FROM (" + TenantJson + " WHERE name=$2) rows", ct, deletionS3 is not null, slug);
        return JsonNode.Parse(text as string ?? throw Missing())!;
    }, token);

    private static string? Pin(string profile) => profile == "operator" ? Lease.ReplicaRoles.MasterHost : null;

    private static OperatorProblem Missing() => new(404, "Tenant not found.");

    internal Task<JsonObject> RotateAsync(string slug, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        // Placement edits lock tenant then lease. The first rotation must be ordered with
        // an old boot acquiring this legacy tenant: it either sees that owner in the guard,
        // or the acquisition sees a versioned tenant after the rotation commits.
        if (await Scalar(tx, "SELECT tenant_id FROM tenants WHERE name=$1 AND state='active' FOR UPDATE", ct, slug) is not int target)
            throw Missing();
        await Scalar(tx, "SELECT 1 FROM tenant_leases WHERE tenant_id=$1 FOR UPDATE", ct, target);
        await RequireCurrentReplicas(tx, ct);
        int id;
        long version;
        await using (var command = tx.Command("UPDATE tenants SET credential_version=credential_version+1 WHERE name=$1 AND state='active' RETURNING tenant_id,credential_version", slug))
        await using (var reader = await command.ExecuteReaderAsync(ct))
        {
            if (!await reader.ReadAsync(ct)) throw Missing();
            id = reader.GetInt32(0);
            version = reader.GetInt64(1);
        }
        var setup = await IssueSetupAsync(tx, id, version, ct);
        return new JsonObject { ["setupToken"] = setup };
    }, token);

    private static async Task RequireCurrentReplicas(PgTx tx, CancellationToken ct)
    {
        if (await Scalar(tx, IncompatibleServingOwners + " LIMIT 1", ct, 1200) is int)
            throw new OperatorProblem(409, "Finish upgrading all live replicas before creating a tenant or rotating its access token.");
    }

    private static async Task RequireLifecycleReplicasAsync(PgTx tx, CancellationToken ct)
    {
        const string incompatible = """
            SELECT 1 FROM replicas WHERE binary_level<$1 AND heartbeat_at>clock_timestamp()-make_interval(secs=>$2)
            UNION ALL
            """ + "\n" + IncompatibleServingOwners + " LIMIT 1";
        if (await Scalar(tx, incompatible, ct, 1201, Lease.LeaseTimings.Default.Ttl.TotalSeconds) is int)
            throw new OperatorProblem(409, "Finish upgrading all live replicas before suspending or deleting a tenant.");
    }

    // Lease expiry is independent of heartbeat freshness. Imports use an unregistered
    // migration-role lease, but neither import state can serve tenant requests.
    private const string IncompatibleServingOwners = """
        SELECT 1 FROM tenant_leases l JOIN tenants t USING(tenant_id)
        LEFT JOIN replicas r ON r.replica_id=l.owner_replica
        WHERE l.state='active' AND l.expires_at>clock_timestamp() AND t.state NOT IN ('importing','importing-agents')
            AND (r.binary_level IS NULL OR r.binary_level<$1)
        """;

    private static async Task<string> IssueSetupAsync(PgTx tx, int id, long version, CancellationToken ct)
    {
        var setup = RandomToken(SetupPrefix);
        await tx.ExecuteAsync("""
            INSERT INTO tenant_auth(tenant_id,version,setup_hash,expires_at,download_key) VALUES ($1,$2,$3,now()+make_interval(secs=>$4),$5)
            ON CONFLICT(tenant_id) DO UPDATE SET version=$2,setup_hash=$3,expires_at=now()+make_interval(secs=>$4),
                credential_hash=NULL,download_key=$5
            """, ct, id, version, Hash(setup), SetupLifetime.TotalSeconds, RandomNumberGenerator.GetBytes(32));
        return setup;
    }

    internal Task<JsonObject> UpdateAsync(string slug, JsonObject edits, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        int id;
        await using (var command = tx.Command("SELECT tenant_id,profile,state FROM tenants WHERE name=$1 FOR UPDATE", slug))
        await using (var row = await command.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Missing();
            // Crossing this boundary would open different Agent folders on the next activation.
            if (edits["profile"] is { } requested && (row.GetString(1) == "operator") != ((string)requested == "operator"))
                throw new OperatorProblem(409, "A tenant can't move between the operator profile and a hosted profile, because its Agent folders would stay behind.");
            if (row.GetString(2) == "deleting") throw Missing();
            id = row.GetInt32(0);
        }
        foreach (var (field, value) in edits)
        {
            switch (field)
            {
                case "primaryHostname":
                    await tx.ExecuteAsync("DELETE FROM tenant_hostnames WHERE tenant_id=$1 AND kind='primary'", ct, id);
                    await tx.ExecuteAsync("INSERT INTO tenant_hostnames(tenant_id,hostname,kind) VALUES ($1,$2,'primary')", ct, id, (string?)value);
                    break;
                case "profile":
                    var profile = (string)value!;
                    await tx.ExecuteAsync("UPDATE tenants SET profile=$2,pinned_role=$3 WHERE tenant_id=$1", ct, id, profile, Pin(profile));
                    break;
                case "limits": await tx.ExecuteAsync("UPDATE tenants SET limits=$2::jsonb WHERE tenant_id=$1", ct, id, value!.ToJsonString()); break;
                case "journal": await tx.ExecuteAsync("UPDATE tenants SET settings=jsonb_set(settings,'{journal}',$2::jsonb) WHERE tenant_id=$1", ct, id, value!.ToJsonString()); break;
                case "ceiling": await SetCeiling(tx, id, "ceiling", (string?)value, ct); break;
            }
        }
        return new JsonObject { ["slug"] = slug, ["applied"] = Applied };
    }, token);

    private static async Task SetCeiling(PgTx tx, int? tenant, string name, string? text, CancellationToken ct)
    {
        var scope = tenant.HasValue ? "tenant" : "global";
        if (text is null)
            await tx.ExecuteAsync("DELETE FROM operator_documents WHERE scope=$1 AND tenant_id IS NOT DISTINCT FROM $2::int AND name=$3", ct, scope, tenant, name);
        else
            await tx.ExecuteAsync("""
                INSERT INTO operator_documents(scope,tenant_id,name,text) VALUES ($1,$2,$3,$4)
                ON CONFLICT (scope,coalesce(tenant_id,0),name) DO UPDATE SET text=excluded.text,generation=operator_documents.generation+1,updated_at=now()
                """, ct, scope, tenant, name, text);
    }

    internal Task<JsonObject> ProfileCeilingAsync(string profile, bool set, string? text, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var name = "ceiling." + profile;
        if (set) await SetCeiling(tx, null, name, text, ct);
        else text = await Scalar(tx, "SELECT text FROM operator_documents WHERE scope='global' AND name=$1", ct, name) as string;
        return new JsonObject { ["profile"] = profile, ["ceiling"] = text };
    }, token);

    internal Task<JsonNode> PlacementAsync(CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
        JsonNode.Parse((string)(await Scalar(tx, """
            SELECT jsonb_build_object('tenants', (SELECT coalesce(jsonb_agg(jsonb_build_object('slug',t.name,'tenantId',t.tenant_id,'epoch',l.epoch,
                'requestedAction',l.requested_action,'drainingSince',l.draining_since,
                'owner',CASE WHEN live THEN l.owner_replica END,'leaseAgeSeconds',CASE WHEN live THEN extract(epoch FROM now()-l.acquired_at) END,
                'hot',sample->'hot',
                'busy',sample->'busy',
                'providerProblems',sample->'providerProblems') ORDER BY t.name),'[]')
                FROM tenants t JOIN tenant_leases l USING(tenant_id) LEFT JOIN replicas r ON r.replica_id=l.owner_replica,
                LATERAL (SELECT l.state='active' AND l.expires_at>now() AS live, r.capacity->'tenants'->t.name AS heartbeat) stats,
                LATERAL (SELECT CASE WHEN live AND r.heartbeat_at>now()-make_interval(secs=>$1)
                    AND heartbeat->'tenantId'=to_jsonb(t.tenant_id) AND heartbeat->'epoch'=to_jsonb(l.epoch)
                    THEN heartbeat END AS sample) observation),
                'replicas',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',replica_id,'name',name,'role',role,'version',capacity->>'version','binaryLevel',binary_level,
                    'readerVersion',reader_version,'capacity',capacity-'tenants','draining',draining,'heartbeatAt',heartbeat_at,
                    'heldGrants',(SELECT count(*) FROM tenant_leases held WHERE held.owner_replica=replicas.replica_id AND held.state='active' AND held.expires_at>now())) ORDER BY replica_id),'[]') FROM replicas))::text
            """, ct, Lease.LeaseTimings.Default.Ttl.TotalSeconds))!)!, token);
}
