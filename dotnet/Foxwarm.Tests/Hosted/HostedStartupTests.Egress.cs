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
            // The connect callback names the host as the handler resolves it (IPv6 unbracketed).
            var denial = Foxwarm.Net.EgressDeniedException.Copy(new Uri(baseUrl).DnsSafeHost);
            Assert.Equal(HttpStatusCode.BadGateway, listed.StatusCode);
            Assert.Equal(
                "Provider model list request failed. " + denial,
                (await listed.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.GetValue<string>()
            );
            // The Setup model test, over HTTP and over a Responses WebSocket.
            foreach (var providerType in new[] { "openai-responses", "openai-ws" })
            {
                var tested = await client.PostAsJsonAsync(
                    "api/setup/models/test",
                    new { providerType, baseUrl, models = "wire" }
                );
                var body = await tested.Content.ReadAsStringAsync();
                Assert.False(tested.IsSuccessStatusCode, body);
                Assert.Contains(denial, (string?)JsonNode.Parse(body)!["error"]);
            }
        }
        Assert.Equal(0, peer.Requests);

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }

    [Fact]
    public async Task AHostedTurnAgainstADeniedModelEndsQuicklyNamingTheDenial()
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
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(30),
        };
        client.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            storage!.Credentials.Read(InstanceCredentialName.HttpToken)
        );
        var models =
            $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:{peer.Port}/v1\n    models: [wire]\n";
        var saved = await client.PostAsJsonAsync("api/setup/models", new { yaml = models });
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
        var created = await client.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId = "denied" });
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        var started = System.Diagnostics.Stopwatch.StartNew();
        var sent = await client.PostAsJsonAsync("api/sessions/denied/message", new { text = "Hello." });
        Assert.Equal(HttpStatusCode.Accepted, sent.StatusCode);
        var denial = "its address is blocked by this deployment's network policy";
        string history = "";
        await WaitUntilAsync(
            () =>
            {
                history = client.GetStringAsync("api/sessions/denied/history").GetAwaiter().GetResult();
                return history.Contains(denial, StringComparison.Ordinal);
            },
            TimeSpan.FromSeconds(30),
            "the turn fails naming the denial"
        );
        // No retries: the default schedule alone would wait over a minute.
        Assert.True(started.Elapsed < TimeSpan.FromSeconds(10), started.Elapsed.ToString());
        Assert.Equal(0, peer.Requests);

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }
}
