using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Tests.Hosted;

// The hosted runtime's journal and text-redaction wiring (HostedEntry.BuildRuntimeAsync).
public sealed partial class HostedStartupTests
{
    [Fact]
    public async Task TheHostedRuntimeUsesTheTenantsJournalAndRedactionCache()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        var replica = StartHosted(database.OpenApp(), files);
        await WaitUntilAsync(
            () => replica.Inner.Health.Role == ReplicaRole.Owner && replica.Inner.Health.RuntimeStarted,
            TimeSpan.FromSeconds(60),
            "the hosted runtime serves"
        );
        var sessions = ((MainHostRuntime)replica.Runtimes.Single()).Host.Sessions;
        Assert.IsType<PgLlmJournalStore>(sessions.Journal);
        // A known value reaches the tenant's encrypted cache, not a file on the replica.
        var redactor = sessions.Secrets!.TextRedactor();
        // Email is enrolled as a known label by default.
        Assert.True(redactor.TryRegister(redactor.Placeholder("alice@example.test"u8), "alice@example.test", ["private_email"]));
        await WaitUntilAsync(
            () => (long)database.ScalarAsync("SELECT count(*) FROM text_redaction_known").GetAwaiter().GetResult()! == 1,
            TimeSpan.FromSeconds(10),
            "the known value is stored"
        );
        Assert.False(File.Exists(Path.Combine(files.Scratch, "state", Foxwarm.Models.TextRedactionStore.FileName)));

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }

    [Theory]
    [InlineData("journal: {retentionDays: 0}\n", "journal.retentionDays")]
    [InlineData("journal: {retentionDays: '30'}\n", "journal.retentionDays")]
    public async Task AnInvalidJournalRetentionRefusesStartupNamingTheKey(string journal, string key)
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        var tenant = new PostgresStorageContext(new TenantDb(database.OpenApp(), tenantId, epoch), files.Scratch);
        var deployment = DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\n" + journal);
        var error = await Assert.ThrowsAsync<HostedStartupException>(() =>
            HostedEntry.BuildRuntimeAsync(tenant, HostedTestBackend.Compose(tenant, files.Scratch), files.Bootstrap, deployment)
        );
        Assert.StartsWith(key + " ", error.Message);
        // Refused before the key ring: nothing was created.
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM tenant_keys"));
    }

    [Fact]
    public void JournalRetentionReadsTheDeploymentDocument()
    {
        var deployment = DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\njournal: {retentionDays: 30}\n");
        Assert.Equal(30, JournalRetentionOptions.FromDeployment(deployment.Root["journal"]).RetentionDays);
        var unset = DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\n");
        Assert.Null(JournalRetentionOptions.FromDeployment(unset.Root["journal"]).RetentionDays);
    }
}
