using System.Security.Cryptography;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The hosted key ring and instance credentials: the DEK is created once and wrapped by the
/// current KEK, opened only with the KEK that wrapped it (or rewrapped from the previous one),
/// never generated over existing encrypted data, and adopted from a file-mode key on import.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class TenantKeysTests
{
    private static KeyEncryptionKey NewKek(string id) =>
        KeyEncryptionKey.From(InstanceKeys.FromKey(id, RandomNumberGenerator.GetBytes(32), "test"));

    private static async Task<(HostedTestDatabase Database, TenantDb Tenant)> OpenAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    // Read as the superuser, which row-level security doesn't restrict; each test database has
    // one tenant.
    private static async Task<(string? KeyId, string? KekId)> RowAsync(HostedTestDatabase database, TenantDb tenant)
    {
        Assert.True((long)(await database.ScalarAsync("SELECT count(*) FROM tenant_keys"))! <= 1);
        var key = await database.ScalarAsync("SELECT key_id FROM tenant_keys WHERE tenant_id = $1", tenant.TenantId) as string;
        var kek = await database.ScalarAsync("SELECT kek_id FROM tenant_keys WHERE tenant_id = $1", tenant.TenantId) as string;
        return (key, kek);
    }

    private static byte[] Derived(InstanceKeys keys) => keys.Derive(InstanceKeys.SecretStorePurpose);

    [Fact]
    public async Task The_data_key_is_created_once_and_every_open_derives_the_same_keys()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var kek = NewKek("kek-a");
        var ring = new HostedKeyRing(tenant, kek);
        Assert.False(ring.Exists);
        var first = ring.OpenOrCreate();
        Assert.True(ring.Exists);
        Assert.Equal("kek-a", ring.WrappedBy);
        Assert.Matches("^[0-9a-f]{16}$", first.KeyId);
        var again = new HostedKeyRing(tenant, kek).OpenOrCreate();
        Assert.Equal(first.KeyId, again.KeyId);
        Assert.Equal(Derived(first), Derived(again));
        Assert.Equal((first.KeyId, "kek-a"), await RowAsync(database, tenant));
    }

    [Fact]
    public async Task A_wrong_or_missing_key_encryption_key_is_locked_and_changes_nothing()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var keyId = new HostedKeyRing(tenant, NewKek("kek-a")).OpenOrCreate().KeyId;
        var other = Assert.Throws<TenantKeysLockedException>(() =>
            new HostedKeyRing(tenant, NewKek("kek-b")).OpenOrCreate()
        );
        Assert.Contains("kek-a", other.Message);
        Assert.Contains("kek-b", other.Message);
        // The same key ID with other key bytes doesn't authenticate.
        var forged = Assert.Throws<TenantKeysLockedException>(() =>
            new HostedKeyRing(tenant, NewKek("kek-a")).OpenOrCreate()
        );
        Assert.Contains("different key with the same ID", forged.Message);
        Assert.Equal((keyId, "kek-a"), await RowAsync(database, tenant));
        // Without the KEK file, hosted mode doesn't start at all.
        Assert.Throws<HostedBootstrapException>(() =>
            HostedBootstrap.FromEnvironment(new System.Collections.Hashtable()).RequireKeks()
        );
        using var temp = new TempDirectory();
        Assert.Contains(
            "FOXWARM_KEK_FILE",
            Assert.Throws<HostedBootstrapException>(() =>
                HostedBootstrap
                    .FromEnvironment(
                        new System.Collections.Hashtable
                        {
                            ["FOXWARM_KEK_FILE"] = Path.Combine(temp.Path, "missing.key"),
                        }
                    )
                    .RequireKeks()
            ).Message
        );
    }

    [Fact]
    public async Task Encrypted_data_without_a_data_key_is_locked_and_no_key_is_generated()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        new PgStateDocuments(tenant).Open(StateDocumentName.Secrets).ReplaceText("{\"version\":1}");
        var error = Assert.Throws<TenantKeysLockedException>(() =>
            new HostedKeyRing(tenant, NewKek("kek-a")).OpenOrCreate()
        );
        Assert.Contains("no data key", error.Message);
        Assert.Equal(((string?)null, (string?)null), await RowAsync(database, tenant));

        var (other, otherTenant) = await OpenAsync();
        await using var __ = other;
        // A credential row alone counts as well.
        await other.ExecuteOwnerAsync(
            $"SET foxwarm.tenant = '{otherTenant.TenantId}'; SET foxwarm.epoch = '{otherTenant.Epoch}';"
                + " INSERT INTO instance_credentials (name, nonce, value)"
                + " VALUES ('http-token', '\\x000000000000000000000000', '\\x00')"
        );
        Assert.Throws<TenantKeysLockedException>(() =>
            new HostedKeyRing(otherTenant, NewKek("kek-a")).OpenOrCreate()
        );
        Assert.Equal(((string?)null, (string?)null), await RowAsync(other, otherTenant));
    }

    [Fact]
    public async Task An_owner_rewraps_a_data_key_still_wrapped_by_the_previous_key_encryption_key()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var old = NewKek("kek-old");
        var next = NewKek("kek-new");
        var created = new HostedKeyRing(tenant, old).OpenOrCreate();
        var rotated = new HostedKeyRing(tenant, next, old);
        var opened = rotated.OpenOrCreate();
        Assert.Equal(created.KeyId, opened.KeyId);
        Assert.Equal(Derived(created), Derived(opened));
        Assert.Equal("kek-new", rotated.WrappedBy);
        Assert.Equal((created.KeyId, "kek-new"), await RowAsync(database, tenant));
        // The previous KEK can now be removed; it no longer opens the tenant.
        Assert.Equal(Derived(created), Derived(new HostedKeyRing(tenant, next).OpenOrCreate()));
        Assert.Throws<TenantKeysLockedException>(() => new HostedKeyRing(tenant, old).OpenOrCreate());
    }

    [Fact]
    public async Task Db_status_names_the_key_encryption_key_that_wraps_each_tenant_key()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var environment = new System.Collections.Hashtable
        {
            ["FOXWARM_MIGRATE_DATABASE_URL"] = database.OwnerConnectionString,
        };
        async Task<string> StatusAsync()
        {
            using var output = new StringWriter();
            using var error = new StringWriter();
            Assert.Equal(0, await HostedCli.RunAsync(["db", "status"], output, error, environment));
            return output.ToString();
        }
        Assert.Contains($"tenant  {PostgresServer.Tenant}: no data key yet", await StatusAsync());
        var old = NewKek("kek-old");
        var keyId = new HostedKeyRing(tenant, old).OpenOrCreate().KeyId;
        Assert.Contains($"data key {keyId} wrapped by key-encryption key kek-old", await StatusAsync());
        new HostedKeyRing(tenant, NewKek("kek-new"), old).OpenOrCreate();
        Assert.Contains($"data key {keyId} wrapped by key-encryption key kek-new", await StatusAsync());
    }

    [Fact]
    public void The_bootstrap_reads_the_key_deployment_and_agent_paths_and_no_health_port()
    {
        using var temp = new TempDirectory();
        var current = Path.Combine(temp.Path, "current.key");
        var previous = Path.Combine(temp.Path, "previous.key");
        var currentKeys = InstanceKeys.OpenOrCreate(current);
        var previousKeys = InstanceKeys.OpenOrCreate(previous);
        var deployment = Path.Combine(temp.Path, "deployment.yaml");
        File.WriteAllText(deployment, "bot: {httpPort: 4100}\nhealth: {port: 4181}\n");
        var bootstrap = HostedBootstrap.FromEnvironment(
            new System.Collections.Hashtable
            {
                ["FOXWARM_KEK_FILE"] = current,
                ["FOXWARM_KEK_PREVIOUS_FILE"] = previous,
                ["FOXWARM_DEPLOYMENT_CONFIG"] = deployment,
                ["FOXWARM_AGENTS_DIR"] = Path.Combine(temp.Path, "agents"),
                ["FOXWARM_HEALTH_PORT"] = "1",
            }
        );
        var (kek, prior) = bootstrap.RequireKeks();
        Assert.Equal(currentKeys.KeyId, kek.KeyId);
        Assert.Equal(previousKeys.KeyId, prior!.KeyId);
        Assert.Equal(4100, bootstrap.RequireDeployment().PublicEndpoint.Port);
        Assert.Equal(4181, bootstrap.RequireDeployment().HealthPort);
        Assert.Equal(Path.Combine(temp.Path, "agents"), bootstrap.RequireAgentsRoot());
        var empty = HostedBootstrap.FromEnvironment(new System.Collections.Hashtable());
        Assert.Contains("FOXWARM_DEPLOYMENT_CONFIG", Assert.Throws<HostedBootstrapException>(empty.RequireDeployment).Message);
        Assert.Contains("FOXWARM_AGENTS_DIR", Assert.Throws<HostedBootstrapException>(empty.RequireAgentsRoot).Message);
        File.WriteAllText(current, "{\"version\":1}");
        Assert.Contains("FOXWARM_KEK_FILE", Assert.Throws<HostedBootstrapException>(() => bootstrap.RequireKeks()).Message);
    }

    [Fact]
    public async Task Fenced_key_writes_leave_nothing_behind()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var old = NewKek("kek-old");
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        Assert.Throws<TenantFencedException>(() => new HostedKeyRing(tenant, old).OpenOrCreate());
        var epoch = await database.TakeLeaseAsync(tenant.TenantId, "owner");
        var current = new TenantDb(database.OpenApp(), tenant.TenantId, epoch);
        var keyId = new HostedKeyRing(current, old).OpenOrCreate().KeyId;
        await database.TakeLeaseAsync(tenant.TenantId, "next");
        // The rewrap of a fenced owner keeps the previous wrapping.
        Assert.Throws<TenantFencedException>(() =>
            new HostedKeyRing(current, NewKek("kek-new"), old).OpenOrCreate()
        );
        Assert.Equal((keyId, "kek-old"), await RowAsync(database, current));
    }

    [Fact]
    public async Task Import_adopts_the_file_mode_instance_key_as_the_data_key()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        using var temp = new TempDirectory();
        var file = InstanceKeys.OpenOrCreate(InstanceKeys.DefaultPath(temp.Path));
        var kek = NewKek("kek-a");
        HostedKeyRing.Adopt(tenant, file, kek);
        HostedKeyRing.Adopt(tenant, file, kek);
        var opened = new HostedKeyRing(tenant, kek).OpenOrCreate();
        Assert.Equal(file.KeyId, opened.KeyId);
        foreach (
            var purpose in new[]
            {
                InstanceKeys.SecretStorePurpose,
                InstanceKeys.TextRedactionPlaceholderPurpose,
                PgInstanceCredentials.Purpose,
            }
        )
            Assert.Equal(file.Derive(purpose), opened.Derive(purpose));
        Assert.Equal(
            file.Derive(InstanceKeys.TextRedactionStorePurpose, 64),
            opened.Derive(InstanceKeys.TextRedactionStorePurpose, 64)
        );
        using var otherTemp = new TempDirectory();
        var other = InstanceKeys.OpenOrCreate(InstanceKeys.DefaultPath(otherTemp.Path));
        Assert.Throws<InvalidOperationException>(() => HostedKeyRing.Adopt(tenant, other, kek));
        Assert.Equal((file.KeyId, "kek-a"), await RowAsync(database, tenant));
    }

    [Fact]
    public async Task Instance_credentials_are_created_once_encrypted_under_the_data_key()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var ring = new HostedKeyRing(tenant, NewKek("kek-a"));
        var credentials = new PgInstanceCredentials(tenant, ring.OpenOrCreate);
        foreach (var name in Enum.GetValues<InstanceCredentialName>())
        {
            Assert.Null(credentials.Read(name));
            var generated = 0;
            var value = credentials.ReadOrCreate(name, () => "secret-" + name + "-" + ++generated);
            Assert.Equal("secret-" + name + "-1", value);
            Assert.Equal(value, new PgInstanceCredentials(tenant, ring.OpenOrCreate).ReadOrCreate(name, () => "other"));
            Assert.Equal(value, credentials.Read(name));
            Assert.Equal(1, generated);
        }
        // Stored values are ciphertext.
        Assert.Equal(
            0L,
            await database.ScalarAsync(
                "SELECT count(*) FROM instance_credentials WHERE position('secret-'::bytea in value) > 0"
            ) ?? 0L
        );
        // Another data key can't read them.
        var (other, otherTenant) = await OpenAsync();
        await using var __ = other;
        var foreign = InstanceKeys.FromKey("ffffffffffffffff", RandomNumberGenerator.GetBytes(32), "test");
        var copied = new PgInstanceCredentials(tenant, () => foreign);
        Assert.Throws<InvalidDataException>(() => copied.Read(InstanceCredentialName.HttpToken));
    }

    [Fact]
    public async Task A_fenced_credential_creation_leaves_nothing_behind()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var keys = new HostedKeyRing(tenant, NewKek("kek-a")).OpenOrCreate();
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        var credentials = new PgInstanceCredentials(tenant, () => keys);
        Assert.Throws<TenantFencedException>(() =>
            credentials.ReadOrCreate(InstanceCredentialName.HttpToken, () => "token")
        );
        Assert.Null(credentials.Read(InstanceCredentialName.HttpToken));
    }
}
