using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Autonomous;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Secrets;
using Foxwarm.Storage;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class WakeupLifecycleTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task NoTrafficTimerSurvivesAReleasedCronOrCrashedOneShot(bool cron)
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var slug = PostgresServer.Tenant;
        var app = db.OpenApp();
        using var temp = new TempDirectory();
        var kek = Path.Combine(temp.Path, "keys", "current.key");
        _ = InstanceKeys.OpenOrCreate(kek);
        var bootstrap = new HostedBootstrap(null, null, slug, PostgresServer.AppRole,
            ScratchRoot: Path.Combine(temp.Path, "scratch"), KekFile: kek);
        var deployment = DeploymentConfiguration.Parse("url: 'http://{slug}.test'\nblobs: {backend: postgres}\nhealth: {port: 3081}\n");
        MainHostRuntime? runtime = null;
        int starts = 0;
        int failStarts = 0;
        var failures = new List<string>();
        var replica = new TenantReplica(new TenantReplicaOptions("timer-host", null, null, new IPEndPoint(IPAddress.Loopback, 0),
            s => $"http://{s}.test", LeaseTimings.Default, TimeSpan.FromSeconds(8), 2)
            { Mesh = new(new(IPAddress.Loopback, 0), "127.0.0.1", System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)) }, app, db.AppConnectionString,
            async (context, ct) =>
            {
                if (Interlocked.Exchange(ref failStarts, 0) == 1)
                    throw new IOException("Cold builder unavailable");
                Interlocked.Increment(ref starts);
                return runtime = (MainHostRuntime)await HostedEntry.CreateTenantRuntimeAsync(context, bootstrap, deployment, ct);
            }, failures.Add, code => throw new InvalidOperationException("Unexpected exit " + code));
        using var stop = new CancellationTokenSource();
        var serving = replica.RunAsync(stop.Token);
        try
        {
            await replica.Serving.WaitAsync(TimeSpan.FromSeconds(15));
            var coordinator = replica.Activations!;
            var first = await coordinator.ActivateAsync(slug);
            var sessions = runtime!.Host.Sessions;
            var owner = await sessions.CreateNamedAsync("main", "owner", null, null);
            var timers = sessions.Timers;
            var row = new JsonObject { ["sessionId"] = owner.Id, ["message"] = "scheduled delivery" };
            if (cron) row["cron"] = $"21 {(DateTime.Now.Hour + 6) % 24} * * *";
            else row["at"] = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds();
            await timers.CreateAsync(row, default);
            Assert.Equal(IdleReleaseOutcome.Released, await coordinator.TryReleaseIdleAsync(first.Id, TimeSpan.Zero));
            Assert.Equal(1L, await db.ScalarAsync("SELECT count(*) FROM tenant_wakeups"));

            if (cron)
            {
                // The released clock nominated the daily instant. Advance the database's test
                // timeline past it: the real production factory must supply it before arming.
                await db.ExecuteOwnerAsync("UPDATE tenant_wakeups SET due_at=now()-interval '1 minute', occurrence=jsonb_set(occurrence,'{scheduledAt}',to_jsonb((extract(epoch from now())*1000)::bigint - 5000))");
            }
            else
            {
                // A previous owner dies with no wake-up row. Its overdue one-shot remains in
                // the fenced timer document after the grant expires.
                var tenantId = await db.TenantIdAsync();
                var epoch = await db.TakeLeaseAsync(tenantId, "gone/old", TimeSpan.FromMinutes(2));
                var crashed = new TenantDb(app, tenantId, epoch);
                var document = new PgStateDocuments(crashed).Open(StateDocumentName.Timers);
                var saved = JsonNode.Parse(await document.ReadTextAsync() ?? "{}")!.AsObject();
                saved["timers"]![0]!["at"] = DateTimeOffset.UtcNow.AddSeconds(-5).ToUnixTimeMilliseconds();
                document.ReplaceText(saved.ToJsonString());
                await db.ExecuteOwnerAsync("DELETE FROM tenant_wakeups; UPDATE tenant_leases SET expires_at=now()-interval '1 minute' WHERE state='active'");
            }
            // A periodic scan works even when nothing received the release notification.
            var errors = new List<string>();
            var scanner = new Wakeups(app, TimeSpan.FromMinutes(1), (_,_,_) => Task.FromResult(true),
                (name,cause,ct) => coordinator.ActivateAsync(name,cause,ct), errors.Add);
            if (cron)
            {
                // Losing the builder after acquisition but before arming must preserve both
                // the nominated occurrence and the retry backoff, even with no new request.
                failStarts = 1;
                await scanner.ScanAsync(default);
                Assert.Single(errors);
                Assert.Equal(true, await db.ScalarAsync("SELECT occurrence IS NOT NULL AND next_attempt_at > now() FROM tenant_wakeups"));
                await scanner.ScanAsync(default);
                Assert.Equal(1, starts);
                errors.Clear();
                await db.ExecuteOwnerAsync("UPDATE tenant_wakeups SET next_attempt_at=now()-interval '1 second'");
                await scanner.ScanAsync(default);
                Assert.Empty(errors);
            }
            // For the crashed owner only the production periodic loop drives recovery.
            using var deadline = new CancellationTokenSource(Wakeups.Interval + TimeSpan.FromSeconds(10));
            while (true)
            {
                var saved = JsonNode.Parse((string)(await db.ScalarAsync("SELECT text FROM state_documents WHERE name='timers'"))!);
                var timer = saved!["timers"]!.AsArray().SingleOrDefault();
                if (!cron && timer is null || cron && timer?["recentRuns"] is JsonArray { Count: 1 })
                {
                    if (cron) Assert.Equal("delivered",timer!["recentRuns"]![0]!["outcome"]!.GetValue<string>());
                    break;
                }
                await Task.Delay(30,deadline.Token);
            }
            Assert.Equal(2, starts);
            Assert.Null(await db.ScalarAsync("SELECT 1 FROM tenant_wakeups"));
            var delivered = (await runtime!.Host.Sessions.GetExistingAsync(owner.Id))!.Entry.Snapshot();
            Assert.Single(delivered.Queue.Select(Foxwarm.Sessions.SessionQueueJson.ToJson).Concat(delivered.History.Select(item => item.ToJson()))
                .Where(item => item.ToJsonString().Contains("scheduled delivery", StringComparison.Ordinal)));
            await scanner.ScanAsync(default);
            Assert.Equal(2, starts);
        }
        finally
        {
            stop.Cancel();
            await serving.WaitAsync(TimeSpan.FromSeconds(15));
        }
    }
}
