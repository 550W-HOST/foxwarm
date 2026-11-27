using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class OperatorBoundaryTests
{
    [Theory]
    [InlineData("verifiers")]
    [InlineData("fence")]
    [InlineData("authority")]
    public async Task TheMigratedCatalogEnforcesOperatorBoundaries(string boundary)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        switch (boundary)
        {
            case "verifiers":
                Assert.Null(
                    await db.ScalarAsync(
                        "SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='setup_hash'"
                    )
                );
                Assert.True(
                    await db.ScalarAsync(
                        "SELECT NOT has_table_privilege(app_role,'tenant_auth','SELECT') FROM schema_info"
                    )
                        is true
                );
                Assert.True(
                    await db.ScalarAsync(
                        "SELECT proisstrict FROM pg_proc WHERE oid='foxwarm_redeem_setup'::regproc"
                    )
                        is true
                );
                break;
            case "fence":
                foreach (
                    var name in new[]
                    {
                        "foxwarm_fence",
                        "foxwarm_require_lease",
                        "foxwarm_provision_key",
                        "foxwarm_redeem_setup",
                    }
                )
                    Assert.True(
                        await db.ScalarAsync(
                            "SELECT ('search_path=pg_catalog, ' || current_schema() || ', pg_temp')=ANY(proconfig) FROM pg_proc WHERE oid=$1::regproc",
                            name
                        )
                            is true,
                        name
                    );
                Assert.True(
                    await db.ScalarAsync(
                        "SELECT position(current_schema() || '.tenant_leases' in prosrc)>0 FROM pg_proc WHERE oid='foxwarm_require_lease'::regproc"
                    )
                        is true
                );
                // A positive write under a real grant must find its installation's active lease.
                var tenantId = await db.TenantIdAsync();
                var epoch = await db.TakeLeaseAsync(tenantId);
                await new TenantDb(db.OpenApp(), tenantId, epoch).WriteAsync(
                    async (tx, ct) =>
                    {
                        await tx.ExecuteAsync(
                            "CREATE TEMP TABLE tenant_leases (LIKE tenant_leases) ON COMMIT DROP",
                            ct
                        );
                        return await tx.ExecuteAsync(
                            "INSERT INTO state_documents(name,text) VALUES ('test','{}')",
                            ct
                        );
                    }
                );
                // The operator enters the same fence indirectly through provisioning's
                // tenant_keys trigger. Only an empty temporary relation is present.
                await using (var op = new PgDatabase(db.OperatorConnectionString, "operator-test"))
                    await op.ClusterAsync(
                        async (tx, ct) =>
                        {
                            var provisioned = (int)
                                tx.Scalar(
                                    "INSERT INTO tenants(name) VALUES ('shadowcheck') RETURNING tenant_id"
                                )!;
                            await tx.ExecuteAsync(
                                "INSERT INTO tenant_leases(tenant_id,epoch,state,expires_at) VALUES ($1,1,'active',now()+interval '1 minute')",
                                ct,
                                provisioned
                            );
                            await tx.ExecuteAsync(
                                "CREATE TEMP TABLE tenant_leases (LIKE tenant_leases) ON COMMIT DROP",
                                ct
                            );
                            return await tx.ExecuteAsync(
                                "SELECT foxwarm_provision_key($1,'key','kek',$2,$3)",
                                ct,
                                provisioned,
                                new byte[12],
                                new byte[48]
                            );
                        },
                        default
                    );
                break;
            case "authority":
                foreach (var privilege in new[] { "INSERT", "UPDATE", "DELETE" })
                    Assert.False(
                        (bool)
                            (
                                await db.ScalarAsync(
                                    "SELECT has_table_privilege(operator_role,'operator_credentials',$1) FROM schema_info",
                                    privilege
                                )
                            )!
                    );
                break;
        }
    }

    [Fact]
    public async Task InvalidSqlExchangeInputsLeaveTheSetupTokenUnspent()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        using var root = new TempDirectory();
        var kek = KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek")));
        await using var op = new PgDatabase(db.OperatorConnectionString, "operator-test");
        var store = new OperatorStore(op, kek);
        var setup = (string)
            (await store.CreateAsync("alpha", "hosted", "alpha.test", default))["setupToken"]!;
        Assert.True(
            await db.ScalarAsync(
                "SELECT proisstrict FROM pg_proc WHERE oid='foxwarm_redeem_setup'::regproc"
            )
                is true
        );
        var id = await db.TenantIdAsync("alpha");
        var epoch = await db.TakeLeaseAsync(id);
        var owner = new TenantDb(db.OpenApp(), id, epoch);
        await owner.WriteAsync(
            async (tx, ct) =>
            {
                await using var cmd = tx.Command(
                    "SELECT foxwarm_redeem_setup(NULL,1,$1) IS NULL, foxwarm_redeem_setup($1,0,$1), foxwarm_redeem_setup($1,1,$2)",
                    OperatorStore.Hash(setup),
                    new byte[1]
                );
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                Assert.True(await reader.ReadAsync(ct));
                Assert.True(reader.GetBoolean(0));
                Assert.Equal("invalid", reader.GetString(1));
                Assert.Equal("invalid", reader.GetString(2));
                return true;
            }
        );
        var credentials = new PgInstanceCredentials(
            owner,
            () => new HostedKeyRing(owner, kek).OpenOrCreate()
        );
        Assert.True(credentials.CaptureVersionedHttp());
        var (status, access) = await credentials.RedeemAsync(setup, default);
        Assert.Equal("redeemed", status);
        Assert.True(credentials.Matches(access!));
        Assert.Null(credentials.Read(Foxwarm.Storage.InstanceCredentialName.HttpToken));
        Assert.Equal(
            OperatorStore.Hash(access!),
            (byte[])
                (
                    await db.ScalarAsync(
                        "SELECT credential_hash FROM tenant_auth WHERE tenant_id=$1",
                        id
                    )
                )!
        );
        var next = new PgInstanceCredentials(
            owner,
            () => new HostedKeyRing(owner, kek).OpenOrCreate()
        );
        Assert.True(next.CaptureVersionedHttp());
        Assert.True(next.Matches(access!));
    }

    [Fact]
    public async Task SingleTenantSettingsWaitForRestartWithoutLosingTheLease()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        var lease = new TenantLease(db.OpenApp(), PostgresServer.Tenant, 2, ReplicaRoles.General);
        var grant = (
            await lease.TryAcquireAsync(
                "single",
                TimeSpan.FromMinutes(1),
                TimeSpan.FromSeconds(3),
                default
            )
        )!;
        await db.ExecuteOwnerAsync(
            "UPDATE tenants SET settings='{\"journal\":{\"enabled\":false}}'"
        );
        Assert.True(await lease.RenewAsync(grant, TimeSpan.FromMinutes(1), default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task APre1200HeartbeatPostponesCredentialOperations(bool rotate)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync(migrated: false);
        var owner = db.OpenOwner();
        var preOperator = Foxwarm
            .Hosted.Schema.SchemaMigrator.Embedded.Where(m => m.Version < 1200 && m.Version != 5)
            .ToArray();
        await Foxwarm.Hosted.Schema.SchemaMigrator.MigrateAsync(
            owner,
            PostgresServer.AppRole,
            PostgresServer.OperatorRole,
            PostgresServer.Tenant,
            preOperator
        );
        var registry = new ReplicaRegistry(db.OpenApp());
        await registry.RegisterAsync("old/boot", null, 1100, 1, default);
        var id = await db.TenantIdAsync();
        await db.TakeLeaseAsync(id, "old/boot");
        await Foxwarm.Hosted.Schema.SchemaMigrator.MigrateAsync(
            owner,
            PostgresServer.AppRole,
            PostgresServer.OperatorRole,
            null
        );
        await registry.HeartbeatAsync("old/boot", default);
        Assert.True(
            await db.ScalarAsync(
                "SELECT object_identity IS NULL FROM tenants WHERE tenant_id=$1",
                id
            )
                is true
        );
        using var root = new TempDirectory();
        await using var op = new PgDatabase(db.OperatorConnectionString, "operator-test");
        var store = new OperatorStore(
            op,
            KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek")))
        );
        Task<JsonObject> Issue() =>
            rotate
                ? store.RotateAsync(PostgresServer.Tenant, default)
                : store.CreateAsync("fresh", "hosted", "fresh.test", default);
        Assert.Equal(409, (await Assert.ThrowsAsync<OperatorProblem>(Issue)).Status);
        await db.ExecuteOwnerAsync("UPDATE replicas SET heartbeat_at=now()-interval '1 hour'");
        Assert.NotNull((await Issue())["setupToken"]);
    }

    [Theory]
    [InlineData("exchange")]
    [InlineData("reserved-path")]
    public async Task TheHeadlessFrontKeepsTenantAndOperatorRoutesSeparate(string action)
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        using var root = new TempDirectory();
        var file = Path.Combine(root.Path, "kek");
        await using var op = new PgDatabase(
            harness.Database.OperatorConnectionString,
            "operator-test"
        );
        var store = new OperatorStore(op, KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(file)));
        var setup = (string)
            (await store.CreateAsync("alpha", "hosted", "alpha.test", default))["setupToken"]!;
        var replica = await harness.StartAsync(
            "general",
            new Dictionary<string, string> { ["FOXWARM_KEK_FILE"] = file },
            webUi: false,
            extraConfig: "url: 'https://{slug}.test'\noperator: {url: 'https://ops.test', port: 3003}\n"
        );
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false });
        if (action == "exchange")
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"http://127.0.0.1:{replica.FrontPort}/api/auth"
            );
            request.Headers.Host = "alpha.test";
            request.Content = new StringContent(
                new JsonObject { ["token"] = setup }.ToJsonString(),
                Encoding.UTF8,
                "application/json"
            );
            using var result = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, result.StatusCode);
            Assert.NotNull(
                JsonNode.Parse(await result.Content.ReadAsStringAsync())?["instanceToken"]
            );
        }
        else
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"http://127.0.0.1:{replica.FrontPort}/operator/v1/tenants"
            );
            request.Headers.Host = "alpha.test";
            using var result = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.NotFound, result.StatusCode);
            Assert.Equal("", await result.Content.ReadAsStringAsync());
            Assert.Null(await harness.OwnerAsync("alpha"));
            var id = await harness.Database.TenantIdAsync("alpha");
            await harness.Database.ExecuteOwnerAsync(
                $"INSERT INTO tenant_hostnames(hostname,tenant_id,kind) VALUES ('ops.test',{id},'custom')"
            );
            await Assert.ThrowsAsync<HostedBootstrapException>(() =>
                store.RequireOperatorHostnameAsync("ops.test", default)
            );
            using var reservedHost = new HttpRequestMessage(
                HttpMethod.Get,
                $"http://127.0.0.1:{replica.FrontPort}/health"
            );
            reservedHost.Headers.Host = "ops.test";
            using var refused = await client.SendAsync(reservedHost);
            Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
            Assert.Equal("", await refused.Content.ReadAsStringAsync());
            Assert.Null(await harness.OwnerAsync("alpha"));
        }
    }

    [Fact]
    public async Task TwoImportsOfOneInstallationReceiveIndependentRotatedCredentials()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        var db = harness.Database;
        using var root = new TempDirectory();
        var file = Path.Combine(root.Path, "kek");
        var kek = KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(file));
        var fixture = await ImportFixture.BuildAsync(Path.Combine(root.Path, "source"));
        await using var op = new PgDatabase(db.OperatorConnectionString, "operator-test");
        var store = new OperatorStore(op, kek);
        var names = new[] { "first", "second" };
        foreach (var name in names)
        {
            var r = await HostedImportTests.RunAsync(
                db,
                fixture.DataRoot,
                name,
                Directory.CreateDirectory(Path.Combine(root.Path, name)).FullName,
                kek: kek
            );
            Assert.True(r.Exit == 0, r.Report.ToJsonString());
            await db.ExecuteOwnerAsync(
                $"INSERT INTO tenant_hostnames(hostname,tenant_id,kind) SELECT '{name}.test',tenant_id,'primary' FROM tenants WHERE name='{name}'"
            );
        }
        var replica = await harness.StartAsync(
            "general",
            new Dictionary<string, string> { ["FOXWARM_KEK_FILE"] = file }
        );
        using var client = new HttpClient(
            new HttpClientHandler { UseProxy = false, UseCookies = false }
        );
        async Task<HttpResponseMessage> Auth(string name, string token)
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"http://127.0.0.1:{replica.FrontPort}/api/auth"
            );
            request.Headers.Host = name + ".test";
            request.Content = new StringContent(
                new JsonObject { ["token"] = token }.ToJsonString(),
                Encoding.UTF8,
                "application/json"
            );
            return await client.SendAsync(request);
        }
        var original = (
            await File.ReadAllTextAsync(Path.Combine(fixture.DataRoot, "state", "token"))
        ).Trim();
        var issued = new List<string>();
        foreach (var name in names)
        {
            using (var preserved = await Auth(name, original))
                Assert.Equal(HttpStatusCode.OK, preserved.StatusCode);
            var setup = (string)(await store.RotateAsync(name, default))["setupToken"]!;
            string? access = null;
            for (int attempt = 0; attempt < 120 && access is null; attempt++)
            {
                using var result = await Auth(name, setup);
                if (result.IsSuccessStatusCode)
                    access = (string?)
                        JsonNode.Parse(await result.Content.ReadAsStringAsync())?["instanceToken"];
                if (access is null)
                    await Task.Delay(100);
            }
            Assert.NotNull(access);
            issued.Add(access);
        }
        Assert.NotEqual(issued[0], issued[1]);
        using var cross1 = await Auth(names[0], issued[1]);
        using var cross2 = await Auth(names[1], issued[0]);
        Assert.Equal(HttpStatusCode.Unauthorized, cross1.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, cross2.StatusCode);
    }
}
