using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace Foxwarm.Tests;

public sealed class CanonicalHttpTests
{
    private static HostPaths Paths(string data) => HostPaths.ForDataRoot(data);

    private static async Task WriteConfig(string data, bool webui, bool trigger, bool mcp = false)
    {
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            $$"""
            bot:
              enableWebUI: {{webui.ToString().ToLowerInvariant()}}
              enableTrigger: {{trigger.ToString().ToLowerInvariant()}}
            access:
              identities:
                scoped:
                  token: synthetic-browser
                  surfaces:
                    webui: {sessions: [main]}
                {{(mcp ? "external: {token: synthetic-mcp, surfaces: {mcp: {}}}" : "")}}
            """
        );
    }

    private static HttpServerSettings Ephemeral(HttpServerSettings captured) =>
        captured with
        {
            Port = 0,
            BindAddress = "127.0.0.1",
            Address = new("http://127.0.0.1", "", "/", false),
        };

    private static HttpClient Client(MainHost host, string? token = null)
    {
        var client = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = new Uri(host.App.Urls.Single()),
            Timeout = TimeSpan.FromSeconds(15),
        };
        if (token is not null)
            client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    [Theory]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(false, false, true)]
    [InlineData(false, false, false)]
    public async Task Independent_HTTP_features_select_real_listener_routes_and_live_installation_outcomes(
        bool webui,
        bool trigger,
        bool mcp
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        await WriteConfig(data, webui, trigger, mcp);
        var config = new ModelConfiguration(Paths(data));
        var settings = await HttpServerSettings.CaptureAsync(config, data);
        Assert.Equal(webui || trigger || mcp, settings.HttpEnabled);
        Assert.Equal(webui, settings.WebUiEnabled);
        Assert.Equal(trigger, settings.TriggerEnabled);
        Assert.Equal("0.0.0.0", settings.BindAddress);
        Assert.Equal(3001, settings.Port);
        settings = Ephemeral(settings);
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        Assert.Equal(webui || trigger || mcp, host.HttpEnabled);
        if (!host.HttpEnabled)
        {
            Assert.Throws<InvalidOperationException>(() => host.App);
            Assert.False(File.Exists(Path.Combine(data, "state", "token")));
            Assert.False(config.Access.McpRuntimeAvailable);
            var installed = await config.SaveAppAsync(
                "bot: {enableWebUI: false, enableTrigger: false}\naccess: {identities: {external: {token: synthetic-mcp, surfaces: {mcp: {}}}}}\n"
            );
            Assert.Contains("access.surfaces.mcp", installed["notApplied"]!.ToString());
            Assert.Contains("access.surfaces.mcp", installed["restartRequired"]!.ToString());
            Assert.False(host.HttpEnabled);
        }
        else
        {
            Assert.True(config.Access.McpRuntimeAvailable);
            using var admin = Client(host, settings.Token);
            Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/health")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/api/nodes")).StatusCode);
            Assert.Equal(
                webui ? HttpStatusCode.OK : HttpStatusCode.NotFound,
                (await admin.GetAsync("/api/auth/session")).StatusCode
            );
            Assert.Equal(
                trigger ? HttpStatusCode.BadRequest : HttpStatusCode.NotFound,
                (
                    await admin.PostAsJsonAsync("/trigger", new { text = "missing target" })
                ).StatusCode
            );
            using var anonymous = Client(host);
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await anonymous.GetAsync("/health")).StatusCode
            );
            if (mcp)
            {
                await using var transport = new HttpClientTransport(
                    new HttpClientTransportOptions
                    {
                        Endpoint = new Uri(admin.BaseAddress!, "/mcp"),
                        TransportMode = HttpTransportMode.StreamableHttp,
                        AdditionalHeaders = new Dictionary<string, string>
                        {
                            ["Authorization"] = "Bearer synthetic-mcp",
                        },
                    }
                );
                await using var sdk = await ModelContextProtocol.Client.McpClient.CreateAsync(
                    transport,
                    new McpClientOptions { ProtocolVersion = "2025-11-25" }
                );
                Assert.Equal(
                    5,
                    (await sdk.ListToolsAsync(new ListToolsRequestParams())).Tools.Count
                );
                Assert.Equal(
                    HttpStatusCode.Unauthorized,
                    (
                        await admin.PostAsJsonAsync(
                            "/mcp",
                            new
                            {
                                jsonrpc = "2.0",
                                id = 1,
                                method = "initialize",
                            }
                        )
                    ).StatusCode
                );
            }
            var installed = await config.SaveAppAsync(
                "bot: {enableWebUI: false, enableTrigger: false}\naccess: {identities: {external: {token: synthetic-reconfigured, surfaces: {mcp: {}}}}}\n"
            );
            Assert.Contains("access.surfaces.mcp", installed["applied"]!.ToString());
            Assert.DoesNotContain("access.surfaces.mcp", installed["restartRequired"]!.ToString());
        }
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            Assert.Empty(catalog.List());
        }
        var stopped = host.WaitForShutdownAsync();
        host.Lifetime.StopApplication();
        await stopped.WaitAsync(TimeSpan.FromSeconds(5));
        await host.DisposeAsync();
        Assert.False(Directory.Exists(Path.Combine(data, "memory")));
        Assert.True(Directory.Exists(Path.Combine(data, "agents", "main", "memory")));
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json")));
    }

    [Fact]
    public async Task Trigger_matches_frozen_Source_uses_existing_targets_and_durable_event_owner_then_closes_admission()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            async (index, stream, _) =>
            {
                if (index == 0)
                    await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
                    )
                );
            }
        );
        await WriteConfig(data, false, true, true);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            $"""
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: '{provider.BaseUri}'
                models: [wire]
            """
        );
        var config = new ModelConfiguration(Paths(data));
        var paths = config.Paths;
        var options = new ResponsesClientOptions(
            provider.BaseUri,
            "wire",
            "local/wire",
            "",
            "",
            713
        );
        await using (
            var seed = new SessionManager(
                data,
                paths.AgentsRoot,
                options,
                config.Models,
                hostPaths: paths
            )
        )
        {
            await seed.LoadMainHostAsync();
            await seed.CreateNamedAsync("main", "main", null, null);
        }
        var settings = Ephemeral(await HttpServerSettings.CaptureAsync(config, data));
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var admin = Client(host, settings.Token);
        foreach (
            var credential in new[] { (string?)null, "wrong", "synthetic-browser", "synthetic-mcp" }
        )
        {
            using var unauthorized = Client(host, credential);
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (
                    await unauthorized.PostAsJsonAsync("/trigger", new { text = "not admitted" })
                ).StatusCode
            );
        }
        var bodies = new JsonArray(
            new JsonObject(),
            new JsonObject { ["text"] = "" },
            new JsonObject { ["text"] = 42 },
            new JsonObject { ["text"] = "x", ["sessionId"] = "absent" },
            new JsonObject { ["text"] = "default event" },
            new JsonObject { ["text"] = "explicit event", ["sessionId"] = "main" }
        );
        var expected = await CanonicalSourceFixture.RunAsync(
            new JsonObject
            {
                ["applicationRoot"] = temp.Path,
                ["operation"] = "trigger",
                ["sessions"] = new JsonArray("main"),
                ["bodies"] = bodies.DeepClone(),
            }
        );
        try
        {
            for (var index = 0; index < bodies.Count; index++)
            {
                var response = await admin.PostAsJsonAsync("/trigger", bodies[index]);
                Assert.Equal(
                    expected["responses"]![index]!["status"]!.GetValue<int>(),
                    (int)response.StatusCode
                );
                var actual = await response.Content.ReadFromJsonAsync<JsonObject>();
                Assert.True(
                    JsonNode.DeepEquals(expected["responses"]![index]!["body"], actual),
                    $"case {index}: expected {expected["responses"]![index]!["body"]}; actual {actual}"
                );
                if (index == 4)
                {
                    var request = await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
                    Assert.Contains("default event", request.Body);
                    Assert.Contains("trigger session event", request.Body);
                    var authority = await File.ReadAllTextAsync(
                        Path.Combine(data, "state", "sessions", "main.json")
                    );
                    Assert.Contains("default event", authority);
                    Assert.Contains("trigger", authority);
                }
            }
            // The real lifetime callback closes Main admission while HTTP remains alive
            // and the accepted provider owner is still held. No missing target is created.
            host.Lifetime.StopApplication();
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (await admin.PostAsJsonAsync("/trigger", new { text = "too late" })).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (
                    await admin.PostAsJsonAsync(
                        "/trigger",
                        new { text = "never create", sessionId = "absent" }
                    )
                ).StatusCode
            );
            release.TrySetResult();
            await host.DisposeAsync();
        }
        finally
        {
            release.TrySetResult();
        }
        Assert.Equal(1, provider.RequestCount);
        var retained = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", "main.json"))
        )!;
        Assert.Contains("explicit event", retained["queue"]!.ToJsonString());
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "absent.json")));
    }

    [Fact]
    public async Task Trigger_strict_failure_is_not_successful_or_hot_admitted_and_scoped_WebUI_cannot_use_admin_route()
    {
        using var temp = new TempDirectory();
        var paths = Paths(Path.Combine(temp.Path, "data"));
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local",
            "",
            "",
            713
        );
        var app = new JsonObject
        {
            ["access"] = new JsonObject
            {
                ["identities"] = new JsonObject
                {
                    ["scoped"] = new JsonObject
                    {
                        ["token"] = "synthetic-browser",
                        ["surfaces"] = new JsonObject
                        {
                            ["webui"] = new JsonObject { ["sessions"] = new JsonArray("main") },
                        },
                    },
                },
            },
        };
        Directory.CreateDirectory(Path.GetDirectoryName(paths.ConfigPath)!);
        await File.WriteAllTextAsync(paths.ConfigPath, app.ToJsonString());
        var config = new ModelConfiguration(paths);
        await using var manager = new SessionManager(
            paths.DataRoot,
            paths.AgentsRoot,
            options,
            config.Models,
            hostPaths: paths
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "main", null, null);
        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(
            paths.DataRoot,
            CancellationToken.None
        );
        var server = new HttpServer(
            [],
            0,
            "synthetic-admin",
            null,
            manager,
            terminals,
            webUiEnabled: true
        );
        await using var application = server.App;
        await application.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(application.Urls.Single()) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-browser");
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await client.PostAsJsonAsync("/trigger", new { text = "not administrator" })
            ).StatusCode
        );
        client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-admin");
        var file = owner.AuthorityStore.AuthorityPath;
        var original = await File.ReadAllBytesAsync(file);
        File.Delete(file);
        Directory.CreateDirectory(file);
        try
        {
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (
                    await client.PostAsJsonAsync("/trigger", new { text = "not committed" })
                ).StatusCode
            );
            Assert.Empty(owner.Entry.Snapshot().Queue);
            Assert.Empty(owner.Entry.Snapshot().History);
            Assert.False(owner.Metadata().Busy);
        }
        finally
        {
            Directory.Delete(file);
            await File.WriteAllBytesAsync(file, original);
            await server.InboundMcp.DisposeAsync();
            await application.StopAsync();
        }
    }

    [Fact]
    public async Task All_HTTP_off_keeps_the_real_persisted_timer_and_existing_Session_provider_lifecycle()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        await using var provider = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
                    )
                )
        );
        await WriteConfig(data, false, false);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            $"""
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: '{provider.BaseUri}'
                models: [wire]
            """
        );
        var config = new ModelConfiguration(Paths(data));
        var paths = config.Paths;
        var options = new ResponsesClientOptions(
            provider.BaseUri,
            "wire",
            "local/wire",
            "",
            "",
            713
        );
        await using (
            var seed = new SessionManager(
                data,
                paths.AgentsRoot,
                options,
                config.Models,
                hostPaths: paths
            )
        )
        {
            await seed.LoadMainHostAsync(); // Use normal memory/bootstrap before persisting the future timer.
            var owner = await seed.CreateNamedAsync("main", "scheduled", null, null);
            await seed.ExecuteTimerToolAsync(
                owner,
                "create_timer",
                new JsonObject
                {
                    ["afterSeconds"] = 2,
                    ["message"] = "headless persisted timer event",
                },
                CancellationToken.None
            );
        }
        var settings = await HttpServerSettings.CaptureAsync(config, data);
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        Assert.False(host.HttpEnabled);
        var request = await provider.Request.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains("headless persisted timer event", request.Body);
        host.Lifetime.StopApplication();
        await host.DisposeAsync();
        Assert.Equal(1, provider.RequestCount);
        Assert.False(File.Exists(Path.Combine(data, "state", "token")));
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json")));
    }
}
