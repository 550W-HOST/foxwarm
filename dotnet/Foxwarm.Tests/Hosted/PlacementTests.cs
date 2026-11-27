using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// Rendezvous rank and the hard constraints at acquisition (plan §3.3).
public sealed class PlacementRankTests
{
    private static ReplicaRow Row(string replica, string role = ReplicaRoles.General, bool draining = false, int startedSecond = 0) =>
        new(replica, ReplicaRegistry.LogicalName(replica), role, draining, [], DateTimeOffset.UnixEpoch.AddSeconds(startedSecond));

    [Fact]
    public void TheScoreIsAFixedFunctionOfSlugAndName()
    {
        // SHA-256("alpha\0replica-a")[0..8], big-endian: fixed, so every process agrees.
        var expected = Convert.ToUInt64(
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData("alpha\0replica-a"u8.ToArray()))[..16],
            16
        );
        Assert.Equal(expected, Placement.Score("alpha", "replica-a"));
        Assert.NotEqual(Placement.Score("alpha", "replica-a"), Placement.Score("alphar", "eplica-a"));
    }

    [Fact]
    public void RankIsStableAndRemovingAReplicaMovesOnlyItsTenants()
    {
        var names = Enumerable.Range(0, 5).Select(index => $"replica-{index}").ToArray();
        var slugs = Enumerable.Range(0, 200).Select(index => $"tenant-{index}").ToArray();
        var before = slugs.ToDictionary(slug => slug, slug => Placement.Rank(slug, names)[0]);
        Assert.Equal(before, slugs.ToDictionary(slug => slug, slug => Placement.Rank(slug, names.Reverse())[0]));
        // Every replica gets some tenants.
        Assert.Equal(names.Length, before.Values.Distinct().Count());
        var remaining = names.Where(name => name != "replica-2").ToArray();
        foreach (var slug in slugs)
        {
            var after = Placement.Rank(slug, remaining)[0];
            if (before[slug] != "replica-2")
                Assert.Equal(before[slug], after);
            else
                Assert.Equal(Placement.Rank(slug, names)[1], after);
        }
    }

    [Fact]
    public void CandidatesHonourRoleDrainingAndOneBootPerLogicalName()
    {
        var live = new[]
        {
            Row("replica-a/0001", startedSecond: 10),
            // A restarted boot of replica-a: ineligible while the older one is live.
            Row("replica-a/0002", startedSecond: 20),
            Row("replica-b/0001", draining: true),
            Row("replica-c/0001"),
            Row("master/0001", ReplicaRoles.MasterHost),
            Row("operator/0001", ReplicaRoles.Operator),
        };
        var hosted = Placement.Candidates("alpha", TenantProfiles.Hosted, null, live);
        Assert.Equal(
            Placement.Rank("alpha", ["replica-a", "replica-c"]),
            hosted.Select(row => row.Name).ToArray()
        );
        Assert.Contains(hosted, row => row.Replica == "replica-a/0001");
        Assert.DoesNotContain(hosted, row => row.Replica == "replica-a/0002");
        Assert.Equal(["master"], Placement.Candidates("ops", TenantProfiles.Operator, null, live).Select(row => row.Name));
        Assert.Equal(["master"], Placement.Candidates("pinned", TenantProfiles.Hosted, ReplicaRoles.MasterHost, live).Select(row => row.Name));
        // The capacity filter narrows new placement only.
        Assert.Equal(["replica-c"], Placement.Candidates("alpha", TenantProfiles.Hosted, null, live, row => row.Name == "replica-c").Select(row => row.Name));
    }

    [Theory]
    [InlineData(ReplicaRoles.General, TenantProfiles.Hosted, null, true)]
    [InlineData(ReplicaRoles.General, TenantProfiles.Operator, null, false)]
    [InlineData(ReplicaRoles.General, TenantProfiles.Hosted, ReplicaRoles.MasterHost, false)]
    [InlineData(ReplicaRoles.MasterHost, TenantProfiles.Operator, null, true)]
    [InlineData(ReplicaRoles.MasterHost, TenantProfiles.Hosted, ReplicaRoles.MasterHost, true)]
    [InlineData(ReplicaRoles.MasterHost, TenantProfiles.Hosted, null, false)]
    [InlineData(ReplicaRoles.Operator, TenantProfiles.Hosted, null, false)]
    [InlineData(ReplicaRoles.Operator, TenantProfiles.Operator, null, false)]
    public void WhoMayServeWhat(string role, string profile, string? pinned, bool allowed) =>
        Assert.Equal(allowed, ReplicaRoles.MayServe(role, profile, pinned));
}

[Trait("Backend", "postgres")]
public sealed class PlacementAcquisitionTests
{
    private const string Replica = "replica-a/0001";

    [Fact]
    public async Task AcquisitionEnforcesRoleAndProfileAndCarriesTheProfileInTheGrant()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await database.ExecuteOwnerAsync(
            "INSERT INTO tenants (name, profile) VALUES ('ops', 'operator');"
                + " INSERT INTO tenants (name, pinned_role) VALUES ('pinned', 'master-host');"
                + " INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name IN ('ops', 'pinned')"
        );
        var app = database.OpenApp();
        Task<LeaseGrant?> Acquire(string tenant, string role) =>
            new TenantLease(app, tenant, 2, role).TryAcquireAsync(Replica, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(1), CancellationToken.None);

        // Refused before any lock or epoch change, by every role that may not serve it.
        await Assert.ThrowsAsync<TenantNotEligibleException>(() => Acquire("ops", ReplicaRoles.General));
        await Assert.ThrowsAsync<TenantNotEligibleException>(() => Acquire("pinned", ReplicaRoles.General));
        await Assert.ThrowsAsync<TenantNotEligibleException>(() => Acquire(PostgresServer.Tenant, ReplicaRoles.MasterHost));
        await Assert.ThrowsAsync<TenantNotEligibleException>(() => Acquire(PostgresServer.Tenant, ReplicaRoles.Operator));
        Assert.Equal(0L, await database.ScalarAsync("SELECT max(epoch) FROM tenant_leases"));

        var operatorGrant = (await Acquire("ops", ReplicaRoles.MasterHost))!;
        Assert.Equal(TenantProfiles.Operator, operatorGrant.Profile);
        Assert.Equal(TenantProfiles.Hosted, (await Acquire("pinned", ReplicaRoles.MasterHost))!.Profile);
        Assert.Equal(TenantProfiles.Hosted, (await Acquire(PostgresServer.Tenant, ReplicaRoles.General))!.Profile);

        // A tenant that isn't active is skipped (null), as in P1, not refused.
        await database.ScalarAsync("UPDATE tenants SET state = 'suspended' WHERE name = 'ops'");
        await database.ScalarAsync("UPDATE tenant_leases SET state = 'released' WHERE tenant_id = $1", operatorGrant.TenantId);
        Assert.Null(await Acquire("ops", ReplicaRoles.MasterHost));
    }

    [Fact]
    public async Task TheRegistryListsLiveBootsWithTheirRoleAndLogicalName()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        var registry = new ReplicaRegistry(database.OpenApp());
        await registry.RegisterAsync("replica-a/0001", null, 1, 2, CancellationToken.None);
        await registry.RegisterAsync("master/0001", null, 1, 2, CancellationToken.None, ReplicaRoles.MasterHost);
        await database.ScalarAsync("UPDATE replicas SET heartbeat_at = now() - interval '1 hour' WHERE replica_id = 'master/0001'");
        var live = await registry.LiveAsync(TimeSpan.FromMinutes(1), CancellationToken.None);
        var row = Assert.Single(live);
        Assert.Equal(("replica-a/0001", "replica-a", ReplicaRoles.General, false), (row.Replica, row.Name, row.Role, row.Draining));
        Assert.IsType<JsonObject>(row.Capacity);
    }
}
