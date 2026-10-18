using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm.Tests;

public sealed class InboundMcpMainHostTests
{
    [Fact]
    public async Task Official_Csharp_SDK_uses_normal_headless_MainHost_with_real_outbound_owner_and_existing_Session_catalog()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state")); Directory.CreateDirectory(work);
        File.WriteAllText(Path.Combine(data, "state", "config.yaml"), InboundMcpFixture.App().ToJsonString());
        File.WriteAllText(Path.Combine(data, "state", "models.yaml"), "{\"default\":\"local\",\"providers\":{\"local\":{\"providerType\":\"openai-responses\",\"baseUrl\":\"http://127.0.0.1:1\",\"models\":[\"wire\"]}}}");
        File.WriteAllText(Path.Combine(data, "state", "tool-authorization.yaml"), "version: 1\nrules:\n  - id: external\n    action: allow\n    match: {externalId: alpha}\n");
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(temp.Path, "peer"));
        File.WriteAllText(Path.Combine(data, "state", "mcp.json"), new JsonObject { ["servers"] = new JsonObject {
            ["peer"] = new JsonObject { ["url"] = peer.Url + "/mcp", ["transport"] = "streamable-http" } } }.ToJsonString());
        var config = new ModelConfiguration(data);
        var http = new HttpServerSettings(0, InboundMcpFixture.Admin, "127.0.0.1", new("http://127.0.0.1", "", "/", false), false);
        await using var host = await MainHost.CreateAsync([], data, work, config, http, null);
        await host.App.StartAsync();
        var url = host.App.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        await using var transport = new HttpClientTransport(new HttpClientTransportOptions {
            Endpoint = new Uri(url + "/mcp"), TransportMode = HttpTransportMode.StreamableHttp,
            AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = "Bearer " + InboundMcpFixture.Alpha } });
        await using var client = await SdkClient.CreateAsync(transport, new McpClientOptions { ProtocolVersion = "2025-11-25" });
        Assert.Equal(5, (await client.ListToolsAsync(new ListToolsRequestParams())).Tools.Count);
        var list = (await InboundMcpFixture.CallAsync(client, "foxwarm_session", new JsonObject { ["action"] = "list" }))["structuredContent"]!.AsObject();
        Assert.Empty(list["sessions"]!.AsArray()); // An empty local catalog must not gain a synthetic external Session.
        var first = await InboundMcpFixture.ConcreteAsync(client, "mcp:peer/probe");
        var second = await InboundMcpFixture.ConcreteAsync(client, "mcp:peer/probe");
        Assert.Equal(first["content"]!.ToJsonString(), second["content"]!.ToJsonString());
        Assert.Single(await peer.EventsAsync(), row => row["kind"]?.GetValue<string>() == "initialize");
        var after = (await InboundMcpFixture.CallAsync(client, "foxwarm_session", new JsonObject { ["action"] = "list" }))["structuredContent"]!.AsObject();
        Assert.Equal(list["total"]!.ToJsonString(), after["total"]!.ToJsonString());
    }
}
