using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantReplicaTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ActivationCrossingStopCannotPublishOrAdmit(bool waitingForLease)
    {
        await using var source = await StartAsync("cold", "warm");
        await source.WhoAmIAsync("warm");
        var id = await source.Database.TenantIdAsync("cold");
        await using var op = new PgDatabase(source.Database.OperatorConnectionString, "placement-stop");
        Assert.True(await new ReplicaPlacementRequests(op, Fast).RequestReplicaDrainAsync(source.Replica.Replica, default));
        await using var connection = new NpgsqlConnection(source.Database.OwnerConnectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        if (waitingForLease)
        {
            await using var command = new NpgsqlCommand("SELECT tenant_id FROM tenant_leases WHERE tenant_id=$1 FOR UPDATE", connection, transaction);
            command.Parameters.Add(PgTx.Parameter(id));
            await command.ExecuteScalarAsync();
        }
        else source.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = source.GetAsync("cold");
        if (waitingForLease)
            await UntilAsync(async () => await source.Database.ScalarAsync("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datname=current_database() AND application_name='foxwarm-control' AND wait_event_type='Lock')") is true, "activation queued on the lease");
        else await UntilAsync(() => source.EventList().Contains("cold:start-waits"), "unpublished runtime starting");
        var signaled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var resume = new ManualResetEventSlim();
        using var callback = source.Stop.Token.Register(() => { signaled.TrySetResult(); resume.Wait(); });
        var cancel = Task.Run(source.Stop.Cancel);
        try
        {
            await signaled.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await transaction.CommitAsync();
            source.StartGate?.TrySetResult();
            using var ready = await source.Client.GetAsync($"http://127.0.0.1:{source.Replica.HealthPort}/readyz");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, ready.StatusCode);
            var results = await Task.WhenAll(pending, source.GetAsync("cold"), source.GetAsync("warm"));
            foreach (var result in results) { using (result) Assert.Equal(HttpStatusCode.ServiceUnavailable, result.StatusCode); }
            Assert.Null(source.Replica.Activations!.Current("cold"));
            Assert.Equal("released", await source.Database.ScalarAsync("SELECT state FROM tenant_leases WHERE tenant_id=$1", id));
            Assert.Equal(waitingForLease ? 0L : 1L, await source.Database.ScalarAsync("SELECT epoch FROM tenant_leases WHERE tenant_id=$1", id));
        }
        finally { resume.Set(); source.StartGate?.TrySetResult(); await cancel; }
    }

    [Fact]
    public async Task AdministrativeDrainCannotRestoreReadinessAfterTheStopSignal()
    {
        await using var source = await StartAsync("hot");
        await source.WhoAmIAsync("hot");
        await using var op = new PgDatabase(source.Database.OperatorConnectionString,"placement-health");
        // Hold the signal callbacks before the replica's stop continuation can run. A
        // concurrent placement scan can still observe the administrative drain meanwhile.
        var signaled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var resume = new ManualResetEventSlim();
        using var callback = source.Stop.Token.Register(() => { signaled.TrySetResult(); resume.Wait(); });
        var cancel = Task.Run(source.Stop.Cancel);
        try
        {
            await signaled.Task.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.True(await new ReplicaPlacementRequests(op,Fast).RequestReplicaDrainAsync(source.Replica.Replica,default));
            using var status = await source.Client.GetAsync($"http://127.0.0.1:{source.Replica.HealthPort}/readyz");
            Assert.Equal(HttpStatusCode.ServiceUnavailable,status.StatusCode);
        }
        finally
        {
            resume.Set();
            await cancel;
        }
    }

    [Fact]
    public async Task ShutdownJoinsAHandbackAlreadyStoppingBeforeTheSignal()
    {
        await using var a = await StartAsync("moving");
        await a.WhoAmIAsync("moving");
        var coordinator = a.Replica.Activations!;
        var generation = coordinator.Current("moving")!;
        a.DrainGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var permitRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        coordinator.BeforeReleaseWrite = () => { releaseStarted.TrySetResult(); return permitRelease.Task; };
        var letShutdownClaim = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var shutdownAtClaim = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        coordinator.BeforeShutdownGrantClaim = () => { shutdownAtClaim.TrySetResult(); return letShutdownClaim.Task; };
        var move = coordinator.RetireForPlacementAsync(generation.Id,"move",TimeSpan.FromMilliseconds(250));
        try
        {
            await UntilAsync(()=>a.EventList().Contains("moving:dispose"),"pending move");
            var marked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var shutdown = coordinator.ShutdownAsync(_=> { marked.TrySetResult(); return Task.FromResult(new HashSet<(int,long)>()); },TimeSpan.FromMilliseconds(250));
            await marked.Task;
            a.DrainGate.TrySetResult();
            await releaseStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
            await shutdownAtClaim.Task.WaitAsync(TimeSpan.FromSeconds(2));
            letShutdownClaim.TrySetResult();
            await Task.WhenAny(shutdown,Task.Delay(150));
            var premature = shutdown.IsCompleted;
            permitRelease.TrySetResult();
            Assert.True(await move);
            var confirmed = await shutdown;
            Assert.False(premature,$"Shutdown completed before hand-back acknowledgement, returning {confirmed}");
            Assert.True(confirmed);
        }
        finally
        {
            a.DrainGate.TrySetResult();
            permitRelease.TrySetResult();
            letShutdownClaim.TrySetResult();
        }
    }

    [Fact]
    public async Task SigtermHandsBackATransientlyLockedTenantWithoutPublicDemand()
    {
        await using var a = await StartAsync("hot", "sibling");
        foreach (var slug in new[]{"hot","sibling"}) await a.WhoAmIAsync(slug);
        await using var b = await StartReplicaAsync(a.Database,"replica-b",a.MeshKey);
        await using var db = new NpgsqlConnection(a.Database.OwnerConnectionString);
        await db.OpenAsync();
        await using var hold = await db.BeginTransactionAsync();
        await using(var cmd = new NpgsqlCommand("SELECT l.tenant_id FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE name='hot' FOR NO KEY UPDATE OF l",db,hold)) await cmd.ExecuteScalarAsync();
        a.DrainGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            a.Stop.Cancel();
            await UntilAsync(()=> a.EventList().Contains("hot:dispose"),"marker has finished");
            await hold.CommitAsync();
            a.DrainGate.TrySetResult();
            Assert.Equal(HostedExit.Stopped, await a.Run.WaitAsync(TimeSpan.FromSeconds(5)));
            await UntilAsync(async()=>Equals(await a.OwnerAsync("sibling"),b.Replica.Replica),"unlocked sibling handed back");
            await UntilAsync(async () => Equals(await a.OwnerAsync("hot"), b.Replica.Replica), "skipped marker followed by confirmed hand-back");
        }
        finally
        {
            a.DrainGate.TrySetResult();
        }
    }

    [Fact]
    public async Task LastTargetDrainingDuringAdministrativeMoveKeepsTheResidentReachable()
    {
        await using var a = await StartAsync("hot");
        await a.WhoAmIAsync("hot");
        await using var b = await StartReplicaAsync(a.Database,"replica-b",a.MeshKey);
        await using var op = new PgDatabase(a.Database.OperatorConnectionString,"placement-drain");
        var requests = new ReplicaPlacementRequests(op, Fast);
        a.DrainGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            Assert.True(await requests.RequestReplicaDrainAsync(a.Replica.Replica,default));
            await UntilAsync(()=>a.EventList().Contains("hot:dispose"),"source retirement");
            Assert.True(await requests.RequestReplicaDrainAsync(b.Replica.Replica,default));
            a.DrainGate.TrySetResult();

            using var result = await b.GetAsync("hot");
            Assert.Equal(HttpStatusCode.OK, result.StatusCode);
            Assert.Contains((string?)await a.OwnerAsync("hot"), new[]{ a.Replica.Replica, b.Replica.Replica });
            var epoch = await a.Database.ScalarAsync("SELECT epoch FROM tenant_leases JOIN tenants USING (tenant_id) WHERE name='hot'");
            await Task.Delay(Fast.RenewInterval * 3);
            Assert.Equal(epoch,await a.Database.ScalarAsync("SELECT epoch FROM tenant_leases JOIN tenants USING (tenant_id) WHERE name='hot'"));
            foreach (var front in new[] { a, b })
            {
                using var ready = await front.Client.GetAsync($"http://127.0.0.1:{front.Replica.HealthPort}/readyz");
                Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
            }
        }
        finally
        {
            a.DrainGate.TrySetResult();
        }
    }
}
