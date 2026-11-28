using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Operator;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class OperatorProjectionTests
{
    [Fact]
    public async Task GrantReadReturnsOnlyNumericQuotaFieldsAndDoesNotEchoMalformedValues()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        using var root = new TempDirectory();
        await using var op = new PgDatabase(db.OperatorConnectionString, "quota-projection");
        var store = new OperatorStore(
            op,
            KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek")))
        );
        await db.ExecuteOwnerAsync(
            """
            INSERT INTO provider_grants(tenant_id,provider_id,quotas) SELECT tenant_id,'pool','{"execs":0,"extra":{"note":"fixture-extra"}}' FROM tenants
            """
        );
        var quota = (await store.ReadGrantsAsync(PostgresServer.Tenant, default))[
            "pool"
        ]!.AsObject();
        Assert.Equal(3, quota.Count);
        Assert.Equal(10, (int)quota["nodes"]!);
        Assert.Equal(0, (int)quota["execs"]!);
        Assert.Equal(60, (int)quota["lifecycleActionsPerHour"]!);
        await db.ExecuteOwnerAsync(
            "UPDATE provider_grants SET quotas='{\"nodes\":\"fixture-invalid\"}'"
        );
        var problem = await Assert.ThrowsAsync<OperatorProblem>(() =>
            store.ReadGrantsAsync(PostgresServer.Tenant, default)
        );
        Assert.Equal(409, problem.Status);
        Assert.DoesNotContain("fixture-invalid", problem.Message);
    }

    [Fact]
    public async Task ARecreatedSlugAndAnOldHeartbeatKeepTheirLiveOwnerButHaveNoCurrentSample()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        using var root = new TempDirectory();
        await using var op = new PgDatabase(db.OperatorConnectionString, "placement-projection");
        var store = new OperatorStore(
            op,
            KeyEncryptionKey.From(InstanceKeys.OpenOrCreate(Path.Combine(root.Path, "kek")))
        );
        const string slug = "reused",
            boot = "same-boot";
        async Task<LeaseGrant> Create()
        {
            await store.CreateAsync(slug, "hosted", slug + ".test", default);
            var id = await db.TenantIdAsync(slug);
            return new LeaseGrant(id, slug, boot, await db.TakeLeaseAsync(id, boot));
        }
        var original = await Create();
        var registry = new ReplicaRegistry(db.OpenApp());
        Task Beat(int id) =>
            registry.HeartbeatAsync(
                boot,
                default,
                new JsonObject
                {
                    [slug] = new JsonObject
                    {
                        ["tenantId"] = id,
                        ["epoch"] = original.Epoch,
                        ["hot"] = 4,
                        ["busy"] = 1,
                        ["providerProblems"] = new JsonObject { ["pool"] = "describe-failed" },
                    },
                }.ToJsonString()
            );
        async Task<JsonNode> Sample() =>
            (await store.PlacementAsync(default))["tenants"]!
                .AsArray()
                .Single(t => (string?)t!["slug"] == slug)!;
        async Task Unknown()
        {
            var row = await Sample();
            Assert.Equal(boot, (string?)row["owner"]);
            Assert.Equal(original.Epoch, (long)row["epoch"]!);
            Assert.Null(row["hot"]);
            Assert.Null(row["busy"]);
            Assert.Null(row["providerProblems"]);
        }
        await Beat(original.TenantId);
        Assert.Equal("describe-failed", (string?)(await Sample())["providerProblems"]!["pool"]);
        var lease = new TenantLease(db.OpenApp(), slug, 2);
        await lease.ReleaseAsync(original, default);
        await store.SuspendAsync(slug, default);
        await store.DeleteAsync(slug, default);
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var worker = store.RunDeletionLoopAsync(stop.Token);
        try
        {
            while (await db.ScalarAsync("SELECT 1 FROM tenants WHERE name=$1", slug) is int)
                await Task.Delay(25, stop.Token);
        }
        finally
        {
            stop.Cancel();
            await worker;
        }
        var next = await Create();
        Assert.NotEqual(original.TenantId, next.TenantId);
        Assert.Equal(original.Epoch, next.Epoch);
        await Unknown();
        await Beat(next.TenantId);
        Assert.Equal(4, (int)(await Sample())["hot"]!);
        await db.ExecuteOwnerAsync("UPDATE replicas SET heartbeat_at=now()-interval '1 hour'");
        await Unknown();
    }
}
