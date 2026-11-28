using System.Diagnostics;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Runtimes;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed partial class HostedStartupTests
{
    private sealed record Replica(TenantReplica Inner, Task<int> Run, CancellationTokenSource Stop,
        Task<TenantGeneration> Activation, List<IHostedRuntime> Runtimes)
    {
        internal int PublicPort => Inner.FrontPort!.Value;
    }

    [Theory]
    [InlineData("127.0.0.1:3004", true)]
    [InlineData("[::1]:3004", true)]
    [InlineData("[::1]", false)]
    [InlineData("example.test:", false)]
    [InlineData("example.test:3004/path", false)]
    public void MeshAddressRequiresAnExplicitHostAndPort(string address, bool valid)
    {
        if (valid) Assert.Equal(3004, Foxwarm.Hosted.Forwarding.MeshSettings.ParseAddress(address).Port);
        else Assert.Throws<HostedBootstrapException>(() => Foxwarm.Hosted.Forwarding.MeshSettings.ParseAddress(address));
    }

    [Fact]
    public async Task RefusedCredentialsAreAConfigurationExitAndAnUnreachableDatabaseIsRetryable()
    {
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        var local = new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, 0);
        async Task<int> RunAsync(Npgsql.NpgsqlConnectionStringBuilder settings)
        {
            var replica = new TenantReplica(new("test", null, null, local, _ => "http://default.test", Foxwarm.Hosted.Lease.LeaseTimings.Default,
                TimeSpan.FromSeconds(8), 2) { Mesh = new(local, "127.0.0.1", System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)) },
                database.OpenApp(settings.ConnectionString), settings.ConnectionString, (_,_) => throw new InvalidOperationException(), _ => { }, _ => { });
            return await replica.RunAsync(default).WaitAsync(TimeSpan.FromSeconds(10));
        }
        Assert.Equal(HostedExit.Configuration, await RunAsync(new(database.AppConnectionString) { Username = "foxwarm_missing_role" }));
        using var port = new System.Net.Sockets.TcpListener(local);
        port.Start();
        var closedPort = ((System.Net.IPEndPoint)port.LocalEndpoint).Port;
        port.Stop();
        Assert.Equal(HostedExit.Failed, await RunAsync(new(database.AppConnectionString) { Host = "127.0.0.1", Port = closedPort, Timeout = 2 }));
    }

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout, string what)
    {
        var deadline = Stopwatch.StartNew();
        while (!condition())
        {
            if (deadline.Elapsed > timeout)
                throw new TimeoutException("Timed out waiting until " + what + ".");
            await Task.Delay(50);
        }
    }

}
