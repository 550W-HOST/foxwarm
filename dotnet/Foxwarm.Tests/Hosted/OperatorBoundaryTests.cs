using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Import;
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
                        "foxwarm_raise_reader_version",
                        "foxwarm_set_wakeup",
                        "foxwarm_clear_wakeup",
                        "foxwarm_wakeup_backoff",
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
                foreach (
                    var (function, target) in new[]
                    {
                        ("foxwarm_raise_reader_version", "tenants"),
                        ("foxwarm_set_wakeup", "tenant_wakeups"),
                        ("foxwarm_clear_wakeup", "tenant_wakeups"),
                        ("foxwarm_wakeup_backoff", "tenant_wakeups"),
                    }
                )
                    Assert.True(
                        await db.ScalarAsync(
                            "SELECT position(current_schema() || '.' || $2 in prosrc)>0 FROM pg_proc WHERE oid=$1::regproc",
                            function,
                            target
                        )
                            is true,
                        function
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
        await db.RegisterBootsAsync("single");
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
    public async Task AnUnexpiredIncompatibleOrUnknownGrantPostponesCredentialOperations(
        bool rotate
    )
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
            preOperator
        );
        await db.ExecuteOwnerAsync($"WITH t AS (INSERT INTO tenants(name) VALUES ('{PostgresServer.Tenant}') RETURNING tenant_id) INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM t");
        var registry = new ReplicaRegistry(db.OpenApp());
        await registry.RegisterAsync("old/boot", null, 1100, 1, default);
        var id = await db.TenantIdAsync();
        await db.TakeLeaseAsync(id, "old/boot");
        await Foxwarm.Hosted.Schema.SchemaMigrator.MigrateAsync(
            owner,
            PostgresServer.AppRole,
            PostgresServer.OperatorRole
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
        Assert.Equal(409, (await Assert.ThrowsAsync<OperatorProblem>(Issue)).Status);
        var legacy = new TenantLease(db.OpenApp(), PostgresServer.Tenant, 2);
        Assert.True(
            await legacy.RenewAsync(
                new LeaseGrant(id, PostgresServer.Tenant, "old/boot", 1),
                TimeSpan.FromSeconds(30),
                default
            )
        );
        await registry.RemoveAsync("old/boot", default);
        Assert.Equal(409, (await Assert.ThrowsAsync<OperatorProblem>(Issue)).Status);
        await db.ExecuteOwnerAsync("UPDATE tenant_leases SET expires_at=now()-interval '1 second'");
        Assert.NotNull((await Issue())["setupToken"]);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TheOperatorReservesItsCanonicalHostnameAgainstProvisionedTenants(bool collision)
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        using var root = new TempDirectory();
        var keyPath = Path.Combine(root.Path, "kek");
        var kek = KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(keyPath));
        var config = Path.Combine(root.Path, "deployment.yaml");
        var host = collision ? "DEFAULT.test." : "ops.test.";
        await File.WriteAllTextAsync(
            config,
            $"url: 'https://{{slug}}.test/app/'\nhealth: {{port: 3002}}\nblobs: {{backend: postgres}}\noperator: {{url: 'https://{host}', port: 3003}}\n"
        );
        if (collision)
        {
            await db.ExecuteOwnerAsync("INSERT INTO tenant_hostnames(tenant_id,hostname,kind) SELECT tenant_id,'default.test','primary' FROM tenants");
            var bootstrap = new HostedBootstrap(
                db.OperatorConnectionString,
                null,
                PostgresServer.Tenant,
                PostgresServer.AppRole,
                DeploymentConfigPath: config,
                KekFile: keyPath,
                Role: ReplicaRoles.Operator
            );
            using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            var refusal = await Assert.ThrowsAsync<HostedBootstrapException>(() =>
                OperatorServer.ServeAsync(bootstrap, bound.Token)
            );
            Assert.Contains("hostname", refusal.Message);
        }
        else
        {
            await using var op = new PgDatabase(db.OperatorConnectionString, "operator-test");
            var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
            context.Response.Body = new MemoryStream();
            context.Request.Method = "GET";
            context.Request.Path = OperatorServer.Path + "/tenants";
            context.Request.Headers.Origin = "https://ops.test";
            context.Request.Host = new Microsoft.AspNetCore.Http.HostString("Ops.Test");
            var listener = OperatorListener.From(DeploymentConfiguration.Load(config));
            await OperatorServer.Dispatch(context, new OperatorStore(op, kek), listener);
            Assert.Equal(401, context.Response.StatusCode);
        }
    }

    [Fact]
    public async Task StandbysNeedACompatibleRegistrationToAcquireNewStyleTenants()
    {
        var server = await PostgresServer.SharedAsync();
        await using var db = await server.CreateDatabaseAsync();
        Assert.True(
            await db.ScalarAsync(
                "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='tenant_leases'::regclass AND tgname='foxwarm_require_serving_version')"
            )
                is true
        );
        var app = db.OpenApp();
        var registry = new ReplicaRegistry(app);
        await registry.RegisterAsync("standby", null, 1100, 2, default);
        await db.ExecuteOwnerAsync("UPDATE replicas SET heartbeat_at=now()-interval '1 hour'");
        var lease = new TenantLease(app, PostgresServer.Tenant, 2);
        foreach (var replica in new[] { "standby", "unregistered" })
            Assert.Null(
                await lease.TryAcquireAsync(
                    replica,
                    TimeSpan.FromMinutes(1),
                    TimeSpan.FromSeconds(2),
                    default
                )
            );
        await db.ExecuteOwnerAsync("UPDATE tenants SET object_identity=NULL, credential_version=1");
        Assert.Null(
            await lease.TryAcquireAsync(
                "standby",
                TimeSpan.FromMinutes(1),
                TimeSpan.FromSeconds(2),
                default
            )
        );
        await registry.RegisterAsync("current", null, 1200, 2, default);
        Assert.NotNull(
            await lease.TryAcquireAsync(
                "current",
                TimeSpan.FromMinutes(1),
                TimeSpan.FromSeconds(2),
                default
            )
        );
    }

    [Theory]
    [InlineData("exchange")]
    [InlineData("reserved-path")]
    [InlineData("mounted-path")]
    [InlineData("dotted-host")]
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
            extraConfig: "url: 'https://{slug}.test/app/{slug}'\noperator: {url: 'https://ops.test.', port: 3003}\n"
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
            var prefix = action == "mounted-path" ? "/app/alpha" : "";
            using var request = new HttpRequestMessage(
                HttpMethod.Get,
                $"http://127.0.0.1:{replica.FrontPort}{prefix}/operator/v1/tenants"
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
                store.RequireOperatorHostnameAsync(
                    action == "dotted-host" ? "Ops.TeSt." : "ops.test",
                    default
                )
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
    public async Task DistinctImportedInstallationsRotateIndependentlyAndCannotBeCloned()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        var db = harness.Database;
        using var root = new TempDirectory();
        var file = Path.Combine(root.Path, "kek");
        var kek = KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(file));
        var sources = new Dictionary<string, string>();
        await using var op = new PgDatabase(db.OperatorConnectionString, "operator-test");
        var store = new OperatorStore(op, kek);
        var names = new[] { "first", "second" };
        foreach (var name in names)
        {
            sources[name] = (await ImportFixture.BuildAsync(Path.Combine(root.Path, name + "-source"))).DataRoot;
            var r = await HostedImportTests.RunAsync(
                db,
                sources[name],
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
        var issued = new List<string>();
        foreach (var name in names)
        {
            var original = (await File.ReadAllTextAsync(Path.Combine(sources[name], "state", "token"))).Trim();
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
        var duplicate = await HostedImportTests.RunAsync(db, sources["first"], "clone", root.Path, kek: kek);
        Assert.Equal(HostedImport.Refused, duplicate.Exit);
        Assert.Equal("This installation was already imported into tenant 'first'. Importing it again would share its Node and webhook credentials. Delete that tenant first.",
            Assert.Single(duplicate.Report["refusals"]!.AsArray())!.GetValue<string>());
        Assert.Null(await db.ScalarAsync("SELECT tenant_id FROM tenants WHERE name='clone'"));
        Assert.NotEqual(issued[0], issued[1]);
        using var cross1 = await Auth(names[0], issued[1]);
        using var cross2 = await Auth(names[1], issued[0]);
        Assert.Equal(HttpStatusCode.Unauthorized, cross1.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, cross2.StatusCode);
    }
}
