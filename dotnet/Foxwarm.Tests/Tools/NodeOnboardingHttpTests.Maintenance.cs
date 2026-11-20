using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class NodeOnboardingHttpTests
{
    private static async Task<ClientWebSocket> Register(Fixture fixture, string auth, JsonObject? launch = null)
    {
        var socket = new ClientWebSocket();
        try
        {
            await socket.ConnectAsync(new Uri(fixture.Admin.BaseAddress!.ToString().Replace("http", "ws")
                + "node_ws?id=restart&auth=" + auth), CancellationToken.None);
            await socket.SendAsync(Encoding.UTF8.GetBytes(new JsonObject
            {
                ["type"] = "node_register", ["nodeType"] = "cli-node",
                ["capabilities"] = new JsonObject { ["tools"] = new JsonArray() },
                ["launchInfo"] = launch?.DeepClone(),
            }.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);
            var buffer = new byte[4096];
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var message = await socket.ReceiveAsync(buffer, timeout.Token);
            Assert.Equal("registered", JsonNode.Parse(Encoding.UTF8.GetString(buffer, 0, message.Count))!["type"]!.GetValue<string>());
            return socket;
        }
        catch { socket.Dispose(); throw; }
    }

    [Fact]
    public async Task Reissue_API_replaces_hash_disconnects_live_socket_and_preserves_launch_facts()
    {
        await using var fixture = await Fixture.Start();
        var auth = fixture.Hub.Registry.Create("restart")["authToken"]!.GetValue<string>();
        using var old = await Register(fixture, auth, new JsonObject
        {
            ["method"] = "bareMetalBackground", ["installDir"] = "/srv/node's path",
            ["platform"] = "darwin", ["authToken"] = "must-not-persist",
        });
        var body = new { baseUrl = "https://example.invalid/prefix" };
        using var response = await fixture.Admin.PostAsJsonAsync("api/nodes/restart/reissue-token", body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        var result = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        var replacement = result["authToken"]!.GetValue<string>();
        Assert.NotEqual(auth, replacement);
        Assert.False(fixture.Hub.Connected("restart"));
        Assert.False(fixture.Hub.Registry.Authenticate("restart", auth));
        Assert.True(new ApprovedNodeRegistry(fixture.Data).Authenticate("restart", replacement));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        Assert.Equal(WebSocketMessageType.Close, (await old.ReceiveAsync(new byte[4096], timeout.Token)).MessageType);
        using var rejected = new ClientWebSocket();
        await rejected.ConnectAsync(new Uri(fixture.Admin.BaseAddress!.ToString().Replace("http", "ws") + "node_ws?id=restart&auth=" + auth), timeout.Token);
        Assert.Equal(WebSocketMessageType.Close, (await rejected.ReceiveAsync(new byte[4096], timeout.Token)).MessageType);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, rejected.CloseStatus);
        rejected.Abort();
        using var successor = await Register(fixture, replacement);
        Assert.True(fixture.Hub.Connected("restart"));
        Assert.Contains(replacement, result["command"]!.GetValue<string>());
        Assert.EndsWith(" -d", result["command"]!.GetValue<string>());
        using var restart = await fixture.Admin.PostAsJsonAsync("api/nodes/restart/restart-command", body);
        var restartBody = (await restart.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.DoesNotContain(replacement, restartBody.ToJsonString());
        Assert.DoesNotContain("--auth-token", restartBody["command"]!.GetValue<string>());
        Assert.DoesNotContain("--pairing", restartBody["command"]!.GetValue<string>());
        Assert.Equal("/srv/node's path", restartBody["launchInfo"]!["installDir"]!.GetValue<string>());
        var persisted = await File.ReadAllTextAsync(fixture.RegistryPath);
        Assert.DoesNotContain(replacement, persisted);
        Assert.DoesNotContain("must-not-persist", persisted);
        var directory = await fixture.Admin.GetStringAsync("api/nodes");
        Assert.DoesNotContain(replacement, directory);
        Assert.DoesNotContain("tokenHash", directory);
        successor.Abort();
    }

    [Theory]
    [InlineData("bareMetal", "run.sh")]
    [InlineData("bareMetalBackground", " -d")]
    [InlineData("bareMetalInstall", "systemctl --user restart")]
    [InlineData("windows", " -StateDir ")]
    [InlineData("interactive", "run-interactive.sh")]
    [InlineData("docker", "docker compose --env-file")]
    [InlineData("shell", "run-shell.sh")]
    [InlineData("windowsShell", "run-shell.ps1")]
    public async Task Existing_commands_cover_launcher_methods_without_recovering_credentials(string method, string expected)
    {
        await using var fixture = await Fixture.Start();
        var registry = fixture.Hub.Registry;
        var auth = registry.Create("restart")["authToken"]!.GetValue<string>();
        var body = new { baseUrl = "https://example.invalid/deploy", method, installDir = method == "windows" ? @"C:\Node's files" : "/srv/node's files" };
        using var response = await fixture.Admin.PostAsJsonAsync("api/nodes/restart/restart-command", body);
        response.EnsureSuccessStatusCode();
        var result = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.DoesNotContain(auth, result.ToJsonString());
        Assert.DoesNotContain(registry.PairingToken, result.ToJsonString());
        if (method is "shell" or "windowsShell")
        {
            Assert.True(result["requiresToken"]!.GetValue<bool>());
            Assert.Null(result["command"]);
            using var reissue = await fixture.Admin.PostAsJsonAsync("api/nodes/restart/reissue-token", body);
            result = (await reissue.Content.ReadFromJsonAsync<JsonObject>())!;
            Assert.Contains(result["authToken"]!.GetValue<string>(), result["command"]!.GetValue<string>());
        }
        Assert.Contains(expected, result["command"]!.GetValue<string>());
    }

    [Fact]
    public async Task Delete_API_requires_explicit_cascade_and_rejects_provider_members_without_effects()
    {
        await using var fixture = await Fixture.Start();
        var registry = fixture.Hub.Registry;
        var root = registry.Create("root")["authToken"]!.GetValue<string>();
        var child = registry.Create("child", "root")["authToken"]!.GetValue<string>();
        var removal = await fixture.Admin.GetFromJsonAsync<JsonObject>("api/nodes/root/removal");
        Assert.Equal(new[] { "root", "child" }, removal!["nodes"]!.AsArray().Select(node => node!.GetValue<string>()));
        Assert.Equal(HttpStatusCode.BadRequest, (await fixture.Admin.DeleteAsync("api/nodes/root")).StatusCode);
        Assert.True(registry.Authenticate("root", root));
        Assert.True(registry.Authenticate("child", child));
        Assert.Equal(HttpStatusCode.OK, (await fixture.Admin.DeleteAsync("api/nodes/root?cascade=true")).StatusCode);
        Assert.Empty(registry.ListApproved());
        registry.Create("single");
        Assert.Equal(HttpStatusCode.OK, (await fixture.Admin.DeleteAsync("api/nodes/single")).StatusCode);
        registry.Create("native");
        registry.ConfigureProviders(new JsonObject { ["fixture"] = new JsonObject { ["parentNode"] = "native" } });
        using (var mutation = registry.BeginMutation())
            registry.RecordProviderNode("fixture", new JsonObject { ["id"] = "fixture/target" }, mutation);
        var blocked = await fixture.Admin.GetFromJsonAsync<JsonObject>("api/nodes/native/removal");
        Assert.False(blocked!["canDelete"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.BadRequest, (await fixture.Admin.DeleteAsync("api/nodes/native?cascade=true")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await fixture.Admin.DeleteAsync("api/nodes/fixture%2Ftarget?cascade=true")).StatusCode);
        Assert.Single(registry.ListApproved());
        Assert.Single(registry.ProviderRecords());
        Assert.Equal(HttpStatusCode.BadRequest, (await fixture.Admin.DeleteAsync("api/nodes/master?cascade=true")).StatusCode);
    }

    [Fact]
    public async Task Maintenance_routes_are_administrator_only_and_validate_before_reissue()
    {
        await using var fixture = await Fixture.Start();
        var auth = fixture.Hub.Registry.Create("restart")["authToken"]!.GetValue<string>();
        using var scoped = new HttpClient { BaseAddress = fixture.Admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-onboarding-reader");
        using var anonymous = new HttpClient { BaseAddress = fixture.Admin.BaseAddress };
        foreach (var (client, status) in new[] { (scoped, HttpStatusCode.Forbidden), (anonymous, HttpStatusCode.Unauthorized) })
        {
            foreach (var route in new[] { "restart-command", "reissue-token" })
                Assert.Equal(status, (await client.PostAsJsonAsync("api/nodes/restart/" + route, new { baseUrl = "https://example.invalid" })).StatusCode);
            Assert.Equal(status, (await client.DeleteAsync("api/nodes/restart?cascade=true")).StatusCode);
            Assert.Equal(status, (await client.GetAsync("api/nodes/restart/removal")).StatusCode);
        }
        foreach (var body in new object[]
        {
            new { baseUrl = "not a URL" }, new { baseUrl = "https://example.invalid", method = "unknown" },
            new { baseUrl = "https://example.invalid", installDir = "bad\npath" },
            new { baseUrl = "https://example.invalid", installDir = "" },
        })
            Assert.Equal(HttpStatusCode.BadRequest, (await fixture.Admin.PostAsJsonAsync("api/nodes/restart/reissue-token", body)).StatusCode);
        Assert.True(fixture.Hub.Registry.Authenticate("restart", auth));
    }

    [Fact]
    public async Task Reissue_removes_unclaimed_pairing_and_precommit_failure_retains_credentials()
    {
        await using var fixture = await Fixture.Start();
        var registry = fixture.Hub.Registry;
        var request = registry.Request(new JsonObject
        {
            ["nodeType"] = "cli-node", ["requestedName"] = "restart",
            ["capabilities"] = new JsonObject { ["tools"] = new JsonArray() },
        }, NodeConnectionHub.Protocol(new JsonObject()));
        var pending = request["id"]!.GetValue<string>();
        var auth = registry.Approve(pending, "restart")["authToken"]!.GetValue<string>();
        fixture.ObserveWrite(stage => { if (stage == AtomicJsonWriteStage.BeforeRename) throw new IOException("synthetic failure"); });
        using var failed = await fixture.Admin.PostAsJsonAsync("api/nodes/restart/reissue-token", new { baseUrl = "https://example.invalid" });
        Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
        Assert.True(registry.Authenticate("restart", auth));
        fixture.ObserveWrite(null);
        using var success = await fixture.Admin.PostAsJsonAsync("api/nodes/restart/reissue-token", new { baseUrl = "https://example.invalid" });
        success.EnsureSuccessStatusCode();
        Assert.Null(registry.ClaimId(pending));
        Assert.Empty(registry.ListPending());
    }
}
