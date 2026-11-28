using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Foxwarm.Timers;
using Microsoft.AspNetCore.Http;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class ChannelHandoffTests
{
    private sealed record Generation(MainHostRuntime Runtime, AdmissionGate Gate) : IAsyncDisposable
    {
        internal SessionManager Sessions => Runtime.Host.Sessions;
        public async ValueTask DisposeAsync()
        {
            Gate.Latch(AdmissionLatch.Stop);
            await Sessions.StopWakeupProducersAsync();
            await Sessions.SettleWakeupProducersAsync();
            await Runtime.DisposeAsync();
            await Gate.DrainedAsync();
        }
    }

    private static async Task<Generation> Start(HostedTestDatabase db, string root, JsonObject config, ChannelTransportDependencies peer)
    {
        var id = await db.TenantIdAsync();
        var epoch = await db.TakeLeaseAsync(id);
        var tenant = new PostgresStorageContext(new TenantDb(db.OpenApp(), id, epoch), root);
        tenant.KeyRing = new HostedKeyRing(tenant.Database, HostedTestBackend.Kek);
        Directory.CreateDirectory(Path.Combine(root, "state"));
        var paths = HostPaths.ForDataRoot(root);
        await File.WriteAllTextAsync(Path.Combine(root, "state", "config.yaml"), new JsonObject { ["channels"] = config.DeepClone() }.ToJsonString());
        var configuration = new ModelConfiguration(paths);
        var settings = (await HttpServerSettings.CaptureDesktopAsync(root)) with { HttpEnabled = false };
        var gate = new AdmissionGate();
        var main = await MainHost.CreateAsync([], root, paths.AgentsRoot, configuration, settings, null, paths,
            channelDependencies: peer, storage: tenant, schedule: new RuntimeSchedule(null, gate));
        var runtime = new MainHostRuntime(main,tenant);
        await runtime.StartAsync();
        gate.Open();
        return new(runtime,gate);
    }

    private static async Task Until(Func<Task<bool>> predicate, CancellationToken stop)
    {
        while (!await predicate()) await Task.Delay(20, stop);
    }

    [Theory]
    [InlineData(true,false)]
    [InlineData(false,false)]
    [InlineData(true,true)]
    public async Task PolledInputCrossingTheHandoffUsesItsLastDurableCursor(bool telegram, bool exhaustSettle)
    {
        await using var db = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await using var bot = await TelegramPeer.StartAsync();
        await using var matrix = await ExternalProtocolPeer.StartAsync();
        using var temp = new TempDirectory();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        var ct = deadline.Token;
        var config = new JsonObject { ["poller"] = telegram ? ExternalChannelFixture.Channel() : matrix.Matrix() };
        var root = Path.Combine(temp.Path,"main");
        var old = await Start(db,root,config,bot.Dependencies);
        var cursorKey = telegram ? "offset" : "next_batch";
        async Task<string?> Cursor() => await db.ScalarAsync("SELECT text::jsonb->'poller'->>$1 FROM state_documents WHERE name='channel-cursors'",cursorKey) as string;
        async Task Attach(Generation gen)
        {
            var owner = await gen.Sessions.CreateNamedAsync("main","target",null,null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            gen.Sessions.AttachChannel(telegram ? "poller:-100" : "poller:!room:fixture", owner);
        }
        await Attach(old);
        if (!telegram) await Until(async () => await Cursor() == "initial", ct);
        await using var barrier = new NpgsqlConnection(db.OwnerConnectionString);
        await barrier.OpenAsync(ct);
        await using var holding = await barrier.BeginTransactionAsync(ct);
        await using (var block = new NpgsqlCommand("LOCK TABLE session_catalog IN SHARE MODE", barrier, holding))
            await block.ExecuteNonQueryAsync(ct);
        var pending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        JsonObject TelegramEvent(int number, string text)
        {
            var message = TelegramPeer.Text("-100", "11", text);
            message["message_id"] = number;
            return new JsonObject { ["update_id"] = number, ["message"] = message };
        }
        // Unlike the FIFO helper, a Bot API peer retains an update until a later request
        // acknowledges it with a greater offset. A retry after a bounded stop has the same ID.
        if (telegram)
        {
            bot.Respond = call => Task.FromResult<IResult?>(call.Method == "getUpdates" && call.Body["timeout"]?.ToString() != "0"
                && long.Parse(call.Body["offset"]!.ToString()) < 2 && pending.Task.IsCompleted
                    ? Results.Json(new { ok=true, result=new[] { TelegramEvent(1,"handoff-first") } }) : null);
            pending.SetResult();
            bot.Push("a", TelegramPeer.Text("-100","11","handoff-first"));
        }
        else matrix.MatrixEvents("matrix-a","!room:fixture",ExternalProtocolPeer.MatrixText("$first","handoff-first"));
        await Until(async () => old.Gate.InFlight > 0 && (bool)(await db.ScalarAsync(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%session_catalog%')"))!,ct);
        var ending = old.DisposeAsync().AsTask();
        try
        {
            if (exhaustSettle)
            {
                using var settleBound = CancellationTokenSource.CreateLinkedTokenSource(ct);
                settleBound.CancelAfter(TimeSpan.FromSeconds(5));
                await Until(() => Task.FromResult(!old.Sessions.Accepting), settleBound.Token);
                Assert.Null(await Cursor());
            }
            else
            {
                Assert.True(old.Sessions.Accepting);
                Assert.False(ending.IsCompleted);
            }
        }
        finally { await holding.RollbackAsync(ct); await ending.WaitAsync(ct); }
        var committed = await Cursor();
        Assert.Equal(exhaustSettle ? null : telegram ? "2" : "cursor-1", committed);
        var queries = telegram ? bot.Calls.Count : matrix.Calls.Count;
        await using var next = await Start(db,root,config,bot.Dependencies);
        var target = Assert.IsType<SessionOwner>(await next.Sessions.GetExistingAsync("target"));
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Until(() => Task.FromResult(telegram
            ? bot.Calls.Skip(queries).Any(c => c.Method == "getUpdates" && c.Body["offset"]?.ToString()==(committed ?? "0"))
            : matrix.Calls.Skip(queries).Any(c => c.Path.EndsWith("/sync",StringComparison.Ordinal) && c.Query.GetValueOrDefault("since")==committed)),ct);
        if (telegram)
        {
            // The predecessor never acknowledged this update if its settle deadline expired.
            bot.Push("a",TelegramPeer.Text("-100","11","handoff-second"));
        }
        else
        {
            var second = ExternalProtocolPeer.MatrixText("$second","handoff-second");
            second["origin_server_ts"] = 1; // Received since the cursor while the runtime was down.
            matrix.MatrixEvents("matrix-a","!room:fixture",ExternalProtocolPeer.MatrixText("$first","handoff-first"),second);
        }
        await Until(async () => await Cursor() == (telegram ? "3" : "cursor-2"),ct);
        var snapshot = target.Entry.Snapshot();
        var messages = snapshot.Queue.Select(SessionQueueJson.ToJson).Concat(snapshot.History.Select(m => m.ToJson())).ToArray();
        Assert.Single(messages,m => m.ToJsonString().Contains("handoff-first",StringComparison.Ordinal));
        Assert.Single(messages,m => m.ToJsonString().Contains("handoff-second",StringComparison.Ordinal));
    }
}
