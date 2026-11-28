using System.Text.Json.Nodes;
using Foxwarm.Hosted.Runtimes;
using Foxwarm.Timers;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantActivationsTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AColdStartFailureCancelsAndDrainsAnOverdueTimerBeforeReleasing(bool failDuringBuild)
    {
        await using var f = await CreateAsync();
        using var temp = new TempDirectory();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        var entered = Fixture.Closed();
        var cancelled = Fixture.Closed();
        var drained = Fixture.Closed();
        int effects = 0;
        await using var timers = new MainTimers(temp.Path, _ => { Interlocked.Increment(ref effects); return Task.CompletedTask; });
        var error = new IOException("Startup refused");
        AdmissionGate? gate = null;
        f.DuringBuild = async context =>
        {
            gate = context.Gate;
            timers.EnableWakeups(null, gate);
            timers.BeforeDelivery = async _ =>
            {
                using var registration = gate.StartupAborted.Register(() => cancelled.TrySetResult());
                entered.SetResult();
                await drained.Task.WaitAsync(deadline.Token);
            };
            await timers.LoadAsync();
            await timers.CreateAsync(new JsonObject { ["sessionId"] = "main", ["at"] = 1, ["message"] = "tick" }, default);
            timers.Start();
            await entered.Task.WaitAsync(deadline.Token);
            Assert.Equal(1, gate.InFlight);
            Assert.Null(gate.TryEnter()); // Requests cannot enter before publication.
        };
        if (failDuringBuild) f.BuildFailure = error;
        else f.For(Tenant).StartFailure = error;
        var activating = f.Activations.ActivateAsync(Tenant, ActivationCause.Recovery);
        try
        {
            await cancelled.Task.WaitAsync(deadline.Token);
            Assert.NotNull(gate);
            Assert.Null(gate.TryEnterProducer());
            Assert.Equal("active", await f.LeaseStateAsync());
            Assert.False(activating.IsCompleted);
        }
        finally { drained.TrySetResult(); }
        Assert.Same(error, await Assert.ThrowsAsync<IOException>(() => activating));
        Assert.Equal("released", await f.LeaseStateAsync());
        Assert.Equal(0, effects);
        Assert.Single(timers.List("main")); // Undelivered one-shot remains durable.
    }
}
