using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Secrets;
using Foxwarm.Storage;
using Foxwarm.Tests.Net;

namespace Foxwarm.Tests.Hosted;

// The egress guard in the hosted runtime (HostedEntry.BuildRuntimeAsync): the tenant's model
// client and Setup probes can't reach an internal address unless the deployment allows it.
public sealed partial class HostedStartupTests
{
    [Fact]
    public async Task AHostedTenantCantMakeTheReplicaConnectToInternalDestinations()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        await using var peer = await EgressFixture.StartAsync();
        IStorageContext? storage = null;
        var replica = StartHosted(database.OpenApp(), files, built => storage = built);
        await WaitUntilAsync(
            () => replica.Inner.Health.Role == ReplicaRole.Owner && replica.Inner.Health.RuntimeStarted,
            TimeSpan.FromSeconds(60),
            "the hosted runtime serves"
        );
        // The test's own client reaches the replica on loopback; only the replica is guarded.
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(30),
        };
        client.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            storage!.Credentials.Read(InstanceCredentialName.HttpToken)
        );
        foreach (
            var baseUrl in new[]
            {
                $"http://127.0.0.1:{peer.Port}/v1",
                $"http://[::ffff:127.0.0.1]:{peer.Port}/v1",
                $"http://localhost:{peer.Port}/v1",
                "http://169.254.169.254/latest",
                "http://10.0.0.1/v1",
            }
        )
        {
            // The provider model list: refused with its existing error shape.
            var listed = await client.PostAsJsonAsync(
                "api/setup/models/list",
                new { providerType = "openai-responses", baseUrl }
            );
            Assert.Equal(HttpStatusCode.BadGateway, listed.StatusCode);
            Assert.Equal(
                "Provider model list request failed.",
                (await listed.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.GetValue<string>()
            );
            // The Setup model test, over HTTP and over a Responses WebSocket.
            foreach (var providerType in new[] { "openai-responses", "openai-ws" })
            {
                var tested = await client.PostAsJsonAsync(
                    "api/setup/models/test",
                    new { providerType, baseUrl, models = "wire" }
                );
                Assert.False(tested.IsSuccessStatusCode, await tested.Content.ReadAsStringAsync());
            }
        }
        Assert.Equal(0, peer.Requests);

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }
}
