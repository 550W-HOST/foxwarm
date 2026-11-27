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

internal sealed class OperatorStore(PgDatabase database, KeyEncryptionKey kek)
{
    internal static readonly TimeSpan SetupLifetime = TimeSpan.FromHours(24);
    internal const string Applied = "The owner applies limit and journal changes when notified or at its next lease renewal. New requests then use the new settings; running work gets time to finish.";
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
            ? true : throw new HostedBootstrapException("Operator service requires the database's operator role."), token);

    internal static Task<string> IssueAsync(PgDatabase owner, CancellationToken token) => owner.ClusterAsync(async (tx, ct) =>
    {
        if (await Scalar(tx, "SELECT current_user = pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'operator_credentials'::regclass", ct) is not true)
            throw new HostedBootstrapException("Token creation requires the migration database role.");
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
            var setup = RandomToken(SetupPrefix);
            var id = (int)(await Scalar(tx, """
                INSERT INTO tenants(name,profile,credential_version,setup_hash,setup_expires_at)
                VALUES ($1,$2,1,$3,now()+make_interval(secs => $4)) RETURNING tenant_id
                """, ct, slug, profile, Hash(setup), SetupLifetime.TotalSeconds))!;
            await tx.ExecuteAsync("UPDATE tenants SET object_identity = tenant_id::text || '-' || to_char(created_at AT TIME ZONE 'UTC','YYYYMMDD\"T\"HH24:MI:SS.US\"Z\"') WHERE tenant_id=$1", ct, id);
            await tx.ExecuteAsync("INSERT INTO tenant_leases(tenant_id,epoch,state,expires_at) VALUES ($1,1,'active',now()+interval '30 seconds')", ct, id);
            var keyId = InstanceKeys.NewKeyId();
            var key = RandomNumberGenerator.GetBytes(InstanceKeys.KeyBytes);
            try
            {
                var (nonce, wrapped) = kek.Wrap(id, keyId, key);
                await tx.ExecuteAsync("SELECT foxwarm_provision_key($1,$2,$3,$4,$5)", ct, id, keyId, kek.KeyId, nonce, wrapped);
            }
            finally { CryptographicOperations.ZeroMemory(key); }
            await tx.ExecuteAsync("UPDATE tenant_leases SET state='released', expires_at=now() WHERE tenant_id=$1", ct, id);
            await tx.ExecuteAsync("INSERT INTO tenant_hostnames(tenant_id,hostname,kind) VALUES ($1,$2,'primary')", ct, id, hostname);
            return new JsonObject { ["slug"] = slug, ["setupToken"] = setup };
        }, token);

    private const string TenantJson = """
        SELECT jsonb_build_object('slug',name,'profile',profile,'state',state,'limits',limits,'journal',settings->'journal',
            'primaryHostname',(SELECT hostname FROM tenant_hostnames h WHERE h.tenant_id=t.tenant_id AND kind='primary'),
            'ceiling',(SELECT text FROM operator_documents d WHERE d.tenant_id=t.tenant_id AND d.name='ceiling')) AS item FROM tenants t
        """;

    internal Task<JsonNode> ReadAsync(string? slug, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var text = slug is null
            ? await Scalar(tx, "SELECT coalesce(jsonb_agg(item ORDER BY item->>'slug'), '[]')::text FROM (" + TenantJson + ") rows", ct)
            : await Scalar(tx, "SELECT item::text FROM (" + TenantJson + " WHERE name=$1) rows", ct, slug);
        return JsonNode.Parse(text as string ?? throw Missing())!;
    }, token);

    private static OperatorProblem Missing() => new(404, "Tenant not found.");

    internal Task<JsonObject> RotateAsync(string slug, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var setup = RandomToken(SetupPrefix);
        if (await tx.ExecuteAsync("""
            UPDATE tenants SET credential_version=credential_version+1, setup_hash=$2, setup_expires_at=now()+make_interval(secs => $3),
                setup_redeemed_at=NULL WHERE name=$1 AND state='active'
            """, ct, slug, Hash(setup), SetupLifetime.TotalSeconds) != 1) throw Missing();
        return new JsonObject { ["setupToken"] = setup };
    }, token);

    internal Task<JsonObject> UpdateAsync(string slug, JsonObject edits, CancellationToken token) => database.ClusterAsync(async (tx, ct) =>
    {
        var id = (int?)await Scalar(tx, "SELECT tenant_id FROM tenants WHERE name=$1 FOR UPDATE", ct, slug) ?? throw Missing();
        foreach (var (field, value) in edits)
        {
            switch (field)
            {
                case "primaryHostname":
                    await tx.ExecuteAsync("DELETE FROM tenant_hostnames WHERE tenant_id=$1 AND kind='primary'", ct, id);
                    await tx.ExecuteAsync("INSERT INTO tenant_hostnames(tenant_id,hostname,kind) VALUES ($1,$2,'primary')", ct, id, (string?)value);
                    break;
                case "profile": await tx.ExecuteAsync("UPDATE tenants SET profile=$2 WHERE tenant_id=$1", ct, id, (string?)value); break;
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
            SELECT jsonb_build_object('tenants', (SELECT coalesce(jsonb_agg(jsonb_build_object('slug',t.name,'epoch',l.epoch,
                'owner',CASE WHEN live THEN l.owner_replica END,'leaseAgeSeconds',CASE WHEN live THEN extract(epoch FROM now()-l.acquired_at) END,
                'hot',CASE WHEN live AND sample->'epoch'=to_jsonb(l.epoch) THEN sample->'hot' END,
                'busy',CASE WHEN live AND sample->'epoch'=to_jsonb(l.epoch) THEN sample->'busy' END) ORDER BY t.name),'[]')
                FROM tenants t JOIN tenant_leases l USING(tenant_id) LEFT JOIN replicas r ON r.replica_id=l.owner_replica,
                LATERAL (SELECT l.state='active' AND l.expires_at>now() AS live, r.capacity->'tenants'->t.name AS sample) stats),
                'replicas',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',replica_id,'name',name,'role',role,'version',capacity->>'version','binaryLevel',binary_level,
                    'readerVersion',reader_version,'capacity',capacity-'tenants','draining',draining,'heartbeatAt',heartbeat_at) ORDER BY replica_id),'[]') FROM replicas))::text
            """, ct))!)!, token);
}
