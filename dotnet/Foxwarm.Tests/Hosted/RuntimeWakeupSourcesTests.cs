using Foxwarm.Storage;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Autonomous;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class RuntimeWakeupSourcesTests
{
    [Fact]
    public async Task ReleasedDeadlineUsesTheCanonicalWaitRetentionAndConfiguredPoller()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var runtime = await harness.StartAsync("clock-sources");
        var sessions = runtime.Main.Sessions;
        var db = harness.Database;
        var tenant = await db.TenantIdAsync(runtime.Tenant);
        var epoch = (long)(await db.ScalarAsync("SELECT epoch FROM tenant_leases WHERE tenant_id=$1", tenant))!;
        var tenantDb = new TenantDb(db.OpenApp(), tenant, epoch);
        var sources = new RuntimeWakeups(sessions, tenantDb);
        Assert.Null(await sources.NextDueAsync(default));

        var owner = await sessions.CreateNamedAsync("main", "waiting", null, null);
        var declared = await sessions.DeclareWaitAsync(owner, new JsonObject { ["wakeIfNoActivityAfterSeconds"] = 3600 });
        Assert.NotNull(declared);
        var wait = owner.WaitSnapshot()!;
        var deadline = DateTimeOffset.FromUnixTimeMilliseconds(wait["startedAt"]!.GetValue<long>() + 3600_000);
        Assert.Equal(deadline, (await sources.NextDueAsync(default))!.DueAt);
        Assert.True(sources.Idle);

        var journal = Assert.IsType<PgLlmJournalStore>(sessions.Journal);
        journal.StartRetention(new(1), firstDelay: TimeSpan.FromMinutes(15));
        Assert.Equal(journal.NextRetention, (await sources.NextDueAsync(default))!.DueAt);
        Assert.InRange(journal.NextRetention!.Value - DateTimeOffset.UtcNow, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(15));

        // Install the configuration after stopping ingress, so the adapter cannot initiate a
        // poll. A configured poller still needs the next owner to start immediately.
        await sources.StopProducersAsync();
        await sources.SettleAsync();
        await new PgConfigDocuments(tenantDb).ReplaceAsync(ConfigDocumentName.Config,
            "channels: {telegram: {botToken: test-token}}\n"u8.ToArray(), default);
        var before = DateTimeOffset.UtcNow;
        Assert.InRange((await sources.NextDueAsync(default))!.DueAt, before, DateTimeOffset.UtcNow);
    }
}
