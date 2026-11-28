using System.Collections.Concurrent;
using Foxwarm.Hosted.Autonomous;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed partial class WakeupScanTests
{
    [Fact]
    public async Task EligibleWorkIsSelectedBeforeTheLimitAndWithoutClaimingIt()
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await db.RegisterBootsAsync("scanner/boot", "old/boot", "current/boot");
        await db.ExecuteOwnerAsync("""
            INSERT INTO tenants(name,profile,pinned_role) VALUES ('operator','operator','master-host');
            INSERT INTO tenants(name,min_reader_version) SELECT 'newer-' || n, 3 FROM generate_series(1,80) n;
            INSERT INTO tenants(name) VALUES ('due'),('recover'),('clean'),('backoff'),('live'),('future'),('soon'),('suspended'),('deleting');
            INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM tenants WHERE name LIKE 'newer-%' OR name='operator' OR name IN ('due','recover','clean','backoff','live','future','soon','suspended','deleting');
            INSERT INTO tenant_wakeups(tenant_id, due_at)
                SELECT tenant_id, CASE WHEN name LIKE 'newer-%' OR name='operator' THEN now() - interval '1 hour'
                                       WHEN name = 'soon' THEN now()+interval '5 seconds'
                                       WHEN name = 'future' THEN now()+interval '1 hour' ELSE now()-interval '20 seconds' END
                FROM tenants WHERE name LIKE 'newer-%' OR name='operator' OR name IN ('due','live','backoff','future','soon','suspended','deleting');
            UPDATE tenants SET state=name WHERE name IN ('suspended','deleting');
            UPDATE tenant_wakeups SET next_attempt_at=now()+interval '1 hour' WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name='backoff');
            UPDATE tenant_leases SET state='active',expires_at=now()-interval '20 seconds',owner_replica='old/boot' WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name='recover');
            UPDATE tenant_leases SET state='active',expires_at=now()+interval '20 seconds',owner_replica='current/boot' WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name='live');
            """);
        var attempted = new ConcurrentBag<(string, ActivationCause)>();
        var errors = new ConcurrentQueue<string>();
        var scan = new Wakeups(db.OpenApp(), TimeSpan.FromMinutes(1), "general", 2, (slug, grace, _) =>
        {
            Assert.Equal(slug != "soon", grace);
            return Task.FromResult(true);
        }, (slug, cause, _) => { attempted.Add((slug, cause)); return Task.CompletedTask; }, errors.Enqueue);
        await scan.DiscoverAsync(default);
        await scan.DrainAsync();
        Assert.Empty(errors);
        Assert.Equal(new[] { ("due", ActivationCause.Wakeup), ("recover", ActivationCause.Recovery), ("soon", ActivationCause.Wakeup) },
            attempted.OrderBy(item => item.Item1, StringComparer.Ordinal));
        Assert.Equal(1L, await db.ScalarAsync("SELECT count(*) FROM tenant_wakeups JOIN tenants USING(tenant_id) WHERE name='due'"));
    }
}
