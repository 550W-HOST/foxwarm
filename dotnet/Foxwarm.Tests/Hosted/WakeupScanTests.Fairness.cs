using Foxwarm.Hosted.Autonomous;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Tests.Hosted;

public sealed partial class WakeupScanTests
{
    [Fact]
    public async Task AFullGeneralPageDoesNotHideTheMasterHostsTimer()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.RegisterBootsAsync("general/live", "master/live");
        await db.ExecuteOwnerAsync("""
            UPDATE replicas SET role='master-host' WHERE replica_id='master/live';
            INSERT INTO tenants(name) SELECT 'general-' || n FROM generate_series(1,80) n;
            INSERT INTO tenants(name,profile) VALUES ('scheduled-operator','operator');
            INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM tenants WHERE name LIKE 'general-%' OR name='scheduled-operator';
            INSERT INTO tenant_wakeups(tenant_id,due_at) SELECT tenant_id, now()-CASE WHEN name LIKE 'general-%' THEN interval '2 hours' ELSE interval '1 hour' END FROM tenants;
            """);
        var scan = new Wakeups(db.OpenApp(), TimeSpan.FromMinutes(1), ReplicaRoles.MasterHost, 2,
            (_, _, _) => Task.FromResult(true), (_, _, _) => Task.CompletedTask, _ => {});
        var candidate = Assert.Single(await scan.ReadAsync(ActivationCause.Wakeup, default));
        Assert.Equal("scheduled-operator", candidate.Slug);
    }

    [Fact]
    public async Task AnUnsettledWakeupBuildDoesNotDelayALaterExpiredGrant()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.RegisterBootsAsync("general/live");
        await db.ExecuteOwnerAsync("INSERT INTO tenant_wakeups(tenant_id,due_at) SELECT tenant_id,now() FROM tenants;");
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var recovered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int builds = 0;
        var scan = new Wakeups(db.OpenApp(), TimeSpan.FromMinutes(1), ReplicaRoles.General, 2, (_, _, _) => Task.FromResult(true),
            async (slug,cause,ct) =>
            {
                if (cause == ActivationCause.Recovery) { recovered.TrySetResult(); return; }
                Interlocked.Increment(ref builds);
                started.TrySetResult();
                await release.Task.WaitAsync(ct);
            }, _ => {});
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        try
        {
            await scan.DiscoverAsync(deadline.Token);
            await started.Task.WaitAsync(deadline.Token);
            await db.ExecuteOwnerAsync("INSERT INTO tenants(name) VALUES ('crashed'); INSERT INTO tenant_leases(tenant_id,state,expires_at,owner_replica) SELECT tenant_id,'active',now()-interval '1 minute','general/live' FROM tenants WHERE name='crashed'");
            await scan.DiscoverAsync(deadline.Token);
            await recovered.Task.WaitAsync(deadline.Token);
            Assert.Equal(1, builds);
        }
        finally { release.TrySetResult(); await scan.DrainAsync(); }
    }

    [Fact]
    public async Task ASecondBootCannotAcquireAStaleScanDuringTheFirstBootsBackoff()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.RegisterBootsAsync("a/live", "b/live");
        await db.ExecuteOwnerAsync("INSERT INTO tenant_wakeups(tenant_id,due_at) SELECT tenant_id,now()-interval '1 minute' FROM tenants");
        var app = db.OpenApp();
        var a = new TenantLease(app, PostgresServer.Tenant, 2);
        var b = new TenantLease(app, PostgresServer.Tenant, 2);
        var permitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int starts = 0;
        var slow = new Wakeups(app, TimeSpan.FromMinutes(1), ReplicaRoles.General, 2, (_,_,_) => Task.FromResult(true),
            async (_,_,ct) =>
            {
                permitted.TrySetResult();
                await resume.Task.WaitAsync(ct);
                if (await b.TryAcquireAsync("b/live", TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(2), ct, Wakeups.Interval) is not null)
                    Interlocked.Increment(ref starts);
            }, _ => {});
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await slow.DiscoverAsync(bound.Token);
        await permitted.Task.WaitAsync(bound.Token);
        var first = await a.TryAcquireAsync("a/live", TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(2), bound.Token, Wakeups.Interval);
        Assert.NotNull(first);
        Assert.True(await a.ReleaseAfterFailedStartAsync(first, TimeSpan.FromMinutes(2), true, bound.Token));
        resume.SetResult();
        await slow.DrainAsync();
        Assert.Equal(0, starts);
        Assert.NotNull(await b.TryAcquireAsync("b/live", TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(2), bound.Token));
    }
}
