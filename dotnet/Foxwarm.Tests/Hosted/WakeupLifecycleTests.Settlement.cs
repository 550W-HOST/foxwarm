using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

public sealed partial class WakeupLifecycleTests
{
    private static async Task EventuallyAsync(Func<Task<bool>> condition, CancellationToken token)
    {
        while (!await condition()) await Task.Delay(25, token);
    }

    private static int SavedInputs(SessionOwner owner, string content)
    {
        var state = owner.Entry.Snapshot();
        return state.Queue.Select(SessionQueueJson.ToJson).Concat(state.History.Select(m => m.ToJson()))
            .Count(message => message.ToJsonString().Contains(content, StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFailedWaitReadCarriesTheArmedCronOverAnOlderFutureRow()
    {
        await using var live = await LiveReplica.StartAsync();
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(27));
        var ct = bound.Token;
        var db = live.Db;
        var g1 = await live.Generations.ActivateAsync(live.Slug);
        var sessions = live.Current.Host.Sessions;
        var owner = await sessions.CreateNamedAsync("main", "cron", null, null);
        await sessions.Timers.CreateAsync(new JsonObject { ["sessionId"] = owner.Id, ["message"] = "carried across failed read",
            ["cron"] = $"5 {(DateTime.Now.Hour + 4) % 24} * * *" }, ct);
        Assert.True(await live.Generations.RetireForPlacementAsync(g1.Id, "move"));
        // Arm a real nomination just ahead of the clock. Its recovery backoff crosses the tick.
        var at = DateTimeOffset.UtcNow.AddSeconds(3).ToUnixTimeMilliseconds();
        await db.ExecuteOwnerAsync($"UPDATE tenant_wakeups SET occurrence=jsonb_set(occurrence,'{{scheduledAt}}','{at}'), due_at=now()");
        var g2 = await live.Generations.ActivateAsync(live.Slug);
        var cron = live.Current.Host.Sessions.Timers.NextWakeup()!.Value.Cron!;
        Assert.Equal(at, cron.ScheduledAt);
        // An uncached catalog row fails the wait-deadline projection without affecting the
        // Session owner's final save or any lease operation. The existing row is deliberately stale.
        await db.ExecuteOwnerAsync($"SELECT set_config('foxwarm.tenant','{g2.Id.TenantId}',true),set_config('foxwarm.epoch','{g2.Id.Epoch}',true);" + """
            INSERT INTO session_catalog(tenant_id,session_id,agent,archived,pinned,last_message_time,message_count,busy,
              queue_length,managed_pending_count,current_node,cached_tokens,input_tokens,output_tokens,metadata_json,wait_present)
              SELECT tenant_id,'cold','main',0,0,0,0,0,0,0,'master',0,0,0,
                '{"meta":{"wait":{"id":"bad","startedAt":1,"timeoutSeconds":1e400}}}',true FROM tenants;
            INSERT INTO tenant_wakeups(tenant_id,due_at,occurrence) SELECT tenant_id,now()+interval '1 day','{"timerId":"older"}' FROM tenants
              ON CONFLICT(tenant_id) DO UPDATE SET due_at=excluded.due_at,occurrence=excluded.occurrence;
            """);
        Assert.True(await live.Generations.RetireForPlacementAsync(g2.Id, "settings"));
        Assert.Equal(cron.TimerId, await db.ScalarAsync("SELECT occurrence->>'timerId' FROM tenant_wakeups"));
        Assert.Equal(at, await db.ScalarAsync("SELECT (occurrence->>'scheduledAt')::bigint FROM tenant_wakeups"));
        Assert.Equal(true, await db.ScalarAsync("SELECT due_at<=now() AND next_attempt_at>to_timestamp($1/1000.0) FROM tenant_wakeups", at));
        Assert.Contains(live.Logs, line => line.Contains(g2.Id.ToString()) && line.Contains("deadline"));
        live.BeforeBuild = context =>
        {
            live.BeforeBuild = null;
            return context.Database.WriteAsync(tx => tx.Execute("DELETE FROM session_catalog WHERE session_id='cold'"));
        };
        await EventuallyAsync(async () => await db.ScalarAsync("SELECT jsonb_array_length(text::jsonb#>'{timers,0,recentRuns}')=1 FROM state_documents WHERE name='timers'") is true, ct);
        Assert.Equal(1, SavedInputs((await live.Current.Host.Sessions.GetExistingAsync(owner.Id))!, "carried across failed read"));
    }

    [Fact]
    public async Task AStaleUnpublishedCrashRecoveryRecreatesDemandForTheOneShot()
    {
        await using var live = await LiveReplica.StartAsync();
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(32));
        var ct = bound.Token;
        var g1 = await live.Generations.ActivateAsync(live.Slug);
        var sessions = live.Current.Host.Sessions;
        var owner = await sessions.CreateNamedAsync("main", "recover", null, null);
        await sessions.Timers.CreateAsync(new JsonObject { ["sessionId"] = owner.Id, ["message"] = "after stale recovery",
            ["at"] = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds() }, ct);
        Assert.True(await live.Generations.RetireForPlacementAsync(g1.Id, "prepare"));
        var db = live.Db;
        var id = await db.TenantIdAsync();
        var epoch = await db.TakeLeaseAsync(id, "gone/boot");
        var doc = new PgStateDocuments(new TenantDb(db.OpenApp(), id, epoch)).Open(StateDocumentName.Timers);
        var saved = JsonNode.Parse((await doc.ReadTextAsync())!)!;
        saved["timers"]![0]!["at"] = DateTimeOffset.UtcNow.AddSeconds(-5).ToUnixTimeMilliseconds();
        doc.ReplaceText(saved.ToJsonString());
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        live.BeforeBuild = async context =>
        {
            live.BeforeBuild = null;
            Assert.Null(context.Activation.Wakeup);
            await db.ExecuteOwnerAsync("UPDATE tenants SET settings_revision=settings_revision+1; SELECT pg_notify('foxwarm_tenants',tenant_id::text) FROM tenants");
            await EventuallyAsync(() => Task.FromResult(context.Activation.Gate.Latched == AdmissionLatch.Stop), ct);
            first.SetResult();
        };
        await db.ExecuteOwnerAsync("DELETE FROM tenant_wakeups; UPDATE tenant_leases SET expires_at=now()-interval '1 minute'");
        await first.Task.WaitAsync(ct);
        await EventuallyAsync(async () => await db.ScalarAsync("SELECT state FROM tenant_leases") is "released", ct);
        Assert.Equal(true, await db.ScalarAsync("SELECT due_at<=now() FROM tenant_wakeups"));
        await EventuallyAsync(async () => await db.ScalarAsync("SELECT jsonb_array_length(text::jsonb->'timers') FROM state_documents WHERE name='timers'") is 0, ct);
        Assert.Equal(1, SavedInputs((await live.Current.Host.Sessions.GetExistingAsync(owner.Id))!, "after stale recovery"));
    }

    [Fact]
    public async Task AWaitSaveAcceptedBeforeBusyRetirementSetsTheFinalWakeup()
    {
        await using var live = await LiveReplica.StartAsync();
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(24));
        var ct = bound.Token;
        var db = live.Db;
        var generation = await live.Generations.ActivateAsync(live.Slug);
        var sessions = live.Current.Host.Sessions;
        var owner = await sessions.CreateNamedAsync("main", "waiting", null, null);
        await using var connection = new NpgsqlConnection(db.OwnerConnectionString);
        await connection.OpenAsync(ct);
        await using var held = await connection.BeginTransactionAsync(ct);
        await using (var block = new NpgsqlCommand("LOCK TABLE session_catalog IN SHARE MODE", connection, held))
            await block.ExecuteNonQueryAsync(ct);
        var saving = Task.Run(() => sessions.DeclareWaitAsync(owner, new JsonObject { ["wakeIfNoActivityAfterSeconds"] = 3 }));
        await EventuallyAsync(async () => await db.ScalarAsync("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%session_catalog%')") is true, ct);
        var retiring = live.Generations.RetireForPlacementAsync(generation.Id, "settings");
        await EventuallyAsync(() => Task.FromResult(!sessions.Accepting), ct);
        Assert.False(retiring.IsCompleted);
        await held.RollbackAsync(ct);
        Assert.NotNull(await saving.WaitAsync(ct));
        Assert.True(await retiring.WaitAsync(ct));
        Assert.Equal(true, await db.ScalarAsync("""
            SELECT w.due_at=to_timestamp(((c.metadata_json::jsonb#>>'{meta,wait,startedAt}')::bigint + 3000)/1000.0)
              FROM tenant_wakeups w JOIN session_catalog c USING(tenant_id) WHERE c.session_id='waiting'
            """));
        await EventuallyAsync(async () => live.Generations.Current(live.Slug) is {Published:true} next && next.Id.Epoch>generation.Id.Epoch
            && await db.ScalarAsync("SELECT wait_present FROM session_catalog WHERE session_id='waiting'") is false, ct);
        Assert.Equal(1, SavedInputs((await live.Current.Host.Sessions.GetExistingAsync(owner.Id))!, "wait timeout reached"));
    }
}
