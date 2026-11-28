using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;
using Microsoft.AspNetCore.Builder;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantRuntimeConstructionTests
{
    [Fact]
    public async Task HostedLogIgnoresTheStoredDisplayName()
    {
        await using var harness = await CreateAsync();
        var lease = await harness.AddTenantAsync("alpha");
        var config = new PgConfigDocuments(new TenantDb(harness.App, lease.Id, lease.Epoch));
        await config.ReplaceAsync(ConfigDocumentName.Config, "bot: {name: Display}\n"u8.ToArray(), default);
        await using var runtime = await harness.BuildAsync("alpha", lease, Deployment(null));
        var logs = Path.Combine(harness.Scratch, "t", lease.Id.ToString(), "state", "logs");
        Assert.Equal("foxwarm.log", Path.GetFileName(Assert.Single(Directory.GetFiles(logs))));
    }

    [Fact]
    public async Task TenantRequestsLogToTheirOwnGenerationAndUnscopedLinesStayInTheProcess()
    {
        await using var harness = await CreateAsync();
        await using var front = await TenantFront.StartAsync();
        var leases = new[] { await harness.AddTenantAsync("alpha"), await harness.AddTenantAsync("beta") };
        var tenants = new List<IHostedRuntime>();
        try
        {
            foreach (var (index, slug) in new[] { "alpha", "beta" }.Index())
            {
                var runtime = await harness.BuildAsync(slug, leases[index], Deployment(null), server: front.Server(slug + ".test"));
                tenants.Add(runtime);
                ((MainHostRuntime)runtime).Host.App.MapGet("/test-log", () =>
                {
                    MainLog.Diagnostic("request diagnostic " + slug);
                    return "ok";
                });
                await runtime.StartAsync();
            }
            MainLog.Diagnostic("unscoped process diagnostic");
            foreach (var (index, slug) in new[] { "alpha", "beta" }.Index())
            {
                var sessions = ((MainHostRuntime)tenants[index]).Host.Sessions;
                using var client = front.Client(slug + ".test", sessions.Storage.Credentials.Read(InstanceCredentialName.HttpToken));
                Assert.Equal("ok", await client.GetStringAsync("test-log"));
            }
            foreach (var (index, slug) in new[] { "alpha", "beta" }.Index())
            {
                var logs = Path.Combine(harness.Scratch, "t", leases[index].Id.ToString(), "state", "logs", "foxwarm.log");
                var lines = File.ReadAllText(logs);
                Assert.Contains("request diagnostic " + slug, lines);
                Assert.DoesNotContain("request diagnostic " + (index == 0 ? "beta" : "alpha"), lines);
                Assert.DoesNotContain("unscoped process diagnostic", lines);
            }
        }
        finally
        {
            foreach (var runtime in tenants)
                await runtime.DisposeAsync();
        }
    }
}
