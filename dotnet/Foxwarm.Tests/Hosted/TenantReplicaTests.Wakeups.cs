using Foxwarm.Hosted.Autonomous;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantReplicaTests
{
    [Fact]
    public async Task TwoWakeupScannersAndAnHttpRequestShareTheSameGeneration()
    {
        await using var f = await StartAsync("scheduled");
        await f.Database.ExecuteOwnerAsync("INSERT INTO tenant_wakeups(tenant_id,due_at) SELECT tenant_id,now()-interval '1 minute' FROM tenants WHERE name='scheduled'");
        var both = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var proceed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var errors = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var joining = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int scans = 0;
        int joins = 0;
        async Task<bool> Permit(string slug, bool grace, CancellationToken token)
        {
            Assert.Equal("scheduled", slug);
            Assert.True(grace);
            if (Interlocked.Increment(ref scans) == 2) both.TrySetResult();
            await proceed.Task.WaitAsync(token);
            return true;
        }
        var scan = new Wakeups(f.Database.OpenApp(), TimeSpan.FromMinutes(1), Permit,
            (slug, cause, ct) =>
            {
                var activation = f.Replica.Activations!.ActivateAsync(slug, cause, ct);
                if (Interlocked.Increment(ref joins) == 2) joining.TrySetResult();
                return activation;
            }, errors.Enqueue);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        f.StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var a = scan.ScanAsync(deadline.Token);
        var b = scan.ScanAsync(deadline.Token);
        try
        {
            await both.Task.WaitAsync(deadline.Token);
            var request = f.GetAsync("scheduled");
            await UntilAsync(() => f.EventList().Contains("scheduled:start-waits"), "the HTTP activation reached start");
            proceed.TrySetResult();
            await joining.Task.WaitAsync(deadline.Token);
            f.StartGate.TrySetResult();
            using var response = await request;
            response.EnsureSuccessStatusCode();
            await Task.WhenAll(a,b);
            Assert.Empty(errors);
            Assert.Equal(1, f.Builds);
            Assert.Single(f.Runtimes);
        }
        finally { proceed.TrySetResult(); f.StartGate.TrySetResult(); }
    }
}
