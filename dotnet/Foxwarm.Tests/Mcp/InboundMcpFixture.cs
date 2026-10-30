using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Terminal;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm.Tests;

internal sealed class InboundMcpFixture : IAsyncDisposable
{
    internal readonly TempDirectory Temp = new();
    internal string Data => Path.Combine(Temp.Path, "data");
    internal string Work => Path.Combine(Temp.Path, "work");
    internal ModelConfiguration Configuration = null!;
    internal SessionManager Manager = null!;
    internal Action<string, AtomicJsonWriteStage>? WriteStage;
    internal SessionOwner Target = null!;
    internal TerminalRegistry Terminals = null!;
    internal HttpServer Server = null!;
    internal string Url = "";
    internal HttpClient Http = new();
    internal const string Alpha = "synthetic-inbound-alpha";
    internal const string Beta = "synthetic-inbound-beta";
    internal const string Admin = "synthetic-inbound-admin";

    internal static JsonObject Access(string alpha = Alpha, bool mcp = true, bool webui = false) =>
        new()
        {
            ["access"] = new JsonObject
            {
                ["identities"] = new JsonObject
                {
                    ["alpha"] = new JsonObject
                    {
                        ["token"] = alpha,
                        ["surfaces"] = new JsonObject
                        {
                            ["mcp"] = mcp ? new JsonObject() : null,
                            ["webui"] = webui
                                ? new JsonObject { ["sessions"] = new JsonArray("target") }
                                : null,
                        },
                    },
                    ["beta"] = new JsonObject
                    {
                        ["token"] = Beta,
                        ["surfaces"] = new JsonObject { ["mcp"] = new JsonObject() },
                    },
                },
            },
        };

    internal static JsonObject App(string alpha = Alpha, bool webui = false)
    {
        var app = Access(alpha, webui: webui);
        app["url"] = "https://localhost/preview";
        var surfaces = app["access"]!["identities"]!["alpha"]!["surfaces"]!.AsObject();
        if (!webui)
            surfaces.Remove("webui");
        return app;
    }

    internal static async Task<InboundMcpFixture> CreateAsync(
        bool allow = true,
        Action<WebApplication>? configure = null,
        JsonObject? appConfiguration = null,
        bool webUiEnabled = false
    )
    {
        var f = new InboundMcpFixture();
        try
        {
            Directory.CreateDirectory(Path.Combine(f.Data, "state"));
            Directory.CreateDirectory(f.Work);
            File.WriteAllText(
                Path.Combine(f.Data, "state", "config.yaml"),
                (appConfiguration ?? App()).ToJsonString()
            );
            File.WriteAllText(
                Path.Combine(f.Data, "state", "models.yaml"),
                "{\"default\":\"local\",\"providers\":{\"local\":{\"providerType\":\"openai-responses\",\"baseUrl\":\"http://127.0.0.1:1\",\"models\":[\"wire\"]}}}"
            );
            f.Configuration = new(f.Data);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "",
                "",
                "",
                713
            );
            f.Manager = new(
                f.Data,
                f.Work,
                options,
                f.Configuration.Models,
                authorityStageHook: (id, stage) => f.WriteStage?.Invoke(id, stage)
            );
            await f.Manager.LoadMainHostAsync();
            f.Target = await f.Manager.CreateNamedAsync("main", "target", null, null);
            f.Target.Registry.TriggerOverride = _ => Task.CompletedTask;
            f.Terminals = new(f.Data, default);
            f.Server = new([], 0, Admin, null, f.Manager, f.Terminals, webUiEnabled: webUiEnabled);
            if (webUiEnabled)
            {
                var runtime = new SessionRuntime(f.Manager);
                new Foxwarm.Channels.WebUi.WebUIChannel(
                    f.Manager,
                    runtime,
                    new MessageRouter(runtime),
                    f.Terminals,
                    f.Server.Downloads
                ).Register(f.Server.App);
            }
            configure?.Invoke(f.Server.App);
            await f.Server.App.StartAsync();
            f.Url =
                f.Server.App.Services.GetRequiredService<IServer>()
                    .Features.Get<IServerAddressesFeature>()!
                    .Addresses.Single() + "/mcp";
            if (allow)
                await f.PolicyAsync(
                    "version: 1\nrules:\n  - id: external\n    action: allow\n    match: {externalId: [alpha, beta]}\n"
                );
            return f;
        }
        catch
        {
            await f.DisposeAsync();
            throw;
        }
    }

    internal Task PolicyAsync(string yaml) =>
        Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);

    internal async Task<SdkClient> ClientAsync(
        string token = Alpha,
        bool standaloneGet = true,
        McpClientOptions? options = null
    )
    {
        var transport = new HttpClientTransport(
            new HttpClientTransportOptions
            {
                Endpoint = new Uri(Url),
                TransportMode = HttpTransportMode.StreamableHttp,
                AdditionalHeaders = new Dictionary<string, string>
                {
                    ["Authorization"] = "Bearer " + token,
                },
                OwnsSession = true,
                EnableStandaloneGetStream = standaloneGet,
            }
        );
        return await SdkClient.CreateAsync(
            transport,
            options ?? new McpClientOptions { ProtocolVersion = "2025-11-25" }
        );
    }

    internal static async Task<JsonObject> CallAsync(SdkClient client, string name, JsonObject args)
    {
        var response = await client.SendRequestAsync(
            new JsonRpcRequest
            {
                Id = new RequestId(Guid.NewGuid().ToString("N")),
                Method = "tools/call",
                Params = new JsonObject { ["name"] = name, ["arguments"] = args.DeepClone() },
            }
        );
        return response.Result!.AsObject();
    }

    internal static Task<JsonObject> ConcreteAsync(
        SdkClient client,
        string id,
        JsonObject? args = null
    ) =>
        CallAsync(
            client,
            "foxwarm_call",
            new JsonObject { ["toolId"] = id, ["args"] = args ?? new JsonObject() }
        );

    internal HttpRequestMessage Request(
        string method,
        string? id,
        string token = Alpha,
        string? body = null
    )
    {
        var request = new HttpRequestMessage(new HttpMethod(method), Url);
        request.Headers.Add("Authorization", "Bearer " + token);
        request.Headers.Add("Accept", "application/json, text/event-stream");
        request.Headers.Add("MCP-Protocol-Version", "2025-11-25");
        if (id is not null)
            request.Headers.Add("Mcp-Session-Id", id);
        if (body is not null)
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return request;
    }

    public async ValueTask DisposeAsync()
    {
        if (Server is not null)
        {
            await Server.InboundMcp.DisposeAsync();
            await Server.App.StopAsync();
            await Server.App.DisposeAsync();
        }
        if (Manager is not null)
        {
            Manager.BeginShutdown();
            await Manager.ShutdownAsync();
            await Manager.DisposeAsync();
        }
        if (Terminals is not null)
            await Terminals.DisposeAsync();
        Http.Dispose();
        Temp.Dispose();
    }
}
