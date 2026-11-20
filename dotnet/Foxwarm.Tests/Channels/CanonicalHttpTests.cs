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
            Assert.False(File.Exists(Path.Combine(data, "state", "token")));
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
            // POST /trigger was removed in 0.9.6; bot.enableTrigger only keeps the listener.
            Assert.Equal(
                HttpStatusCode.NotFound,
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
                    InboundMcpFixture.ToolNames,
                    InboundMcpFixture.Names(await sdk.ListToolsAsync(new ListToolsRequestParams()))
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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Headless_install_checks_the_existing_token_at_save_time_before_replacement_then_restarts_noncolliding_Mcp(
        bool replaceTokenAfterStartup
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        await WriteConfig(data, false, false);
        var tokenFile = Path.Combine(data, "state", "token");
        const string startupToken = "synthetic-startup-admin";
        var currentToken = replaceTokenAfterStartup ? "synthetic-next-admin" : startupToken;
        await File.WriteAllTextAsync(tokenFile, startupToken);
        var config = new ModelConfiguration(Paths(data));
        var originalBytes = await File.ReadAllBytesAsync(config.AppPath);
        var before = config.Access.Snapshot;
        await using (
            var host = await MainHost.CreateAsync(
                [],
                config,
                await HttpServerSettings.CaptureAsync(config, data)
            )
        )
        {
            await host.StartAsync();
            Assert.False(host.HttpEnabled);
            if (replaceTokenAfterStartup)
                await File.WriteAllTextAsync(tokenFile, " \n" + currentToken + "\n ");
            var candidate =
                "bot: {enableWebUI: false, enableTrigger: false}\naccess: {identities: {external: {token: "
                + currentToken
                + ", surfaces: {mcp: {}}}}}\n";
            var source = await CanonicalSourceFixture.RunAsync(
                new JsonObject
                {
                    ["applicationRoot"] = data,
                    ["operation"] = "access",
                    ["access"] = ConfigurationYaml.Parse(candidate, "candidate")[
                        "access"
                    ]!.DeepClone(),
                    ["instanceToken"] = currentToken,
                }
            );
            Assert.True(source["rejected"]!.GetValue<bool>());
            await Assert.ThrowsAsync<InvalidDataException>(() => config.SaveAppAsync(candidate));
            Assert.Equal(originalBytes, await File.ReadAllBytesAsync(config.AppPath));
            Assert.Same(before, config.Access.Snapshot);
            var installed = await config.SaveAppAsync(
                candidate.Replace(currentToken, "synthetic-external")
            );
            Assert.True(installed["saved"]!.GetValue<bool>());
            Assert.Contains("access.identities", installed["applied"]!.ToString());
            Assert.Contains("access.surfaces.mcp", installed["notApplied"]!.ToString());
            Assert.Contains("access.surfaces.mcp", installed["restartRequired"]!.ToString());
            Assert.False(host.HttpEnabled);
        }
        var restartedConfig = new ModelConfiguration(Paths(data));
        var settings = await HttpServerSettings.CaptureAsync(restartedConfig, data);
        Assert.True(settings.HttpEnabled);
        Assert.Equal(currentToken, settings.Token);
        await using var restarted = await MainHost.CreateAsync(
            [],
            restartedConfig,
            Ephemeral(settings)
        );
        await restarted.StartAsync();
        using var admin = Client(restarted, currentToken);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync("/health")).StatusCode);
        await using var transport = new HttpClientTransport(
            new HttpClientTransportOptions
            {
                Endpoint = new Uri(admin.BaseAddress!, "/mcp"),
                TransportMode = HttpTransportMode.StreamableHttp,
                AdditionalHeaders = new Dictionary<string, string>
                {
                    ["Authorization"] = "Bearer synthetic-external",
                },
            }
        );
        await using var sdk = await ModelContextProtocol.Client.McpClient.CreateAsync(
            transport,
            new McpClientOptions { ProtocolVersion = "2025-11-25" }
        );
        Assert.Equal(
            InboundMcpFixture.ToolNames,
            InboundMcpFixture.Names(await sdk.ListToolsAsync(new ListToolsRequestParams()))
        );
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
