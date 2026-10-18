using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;

namespace Foxwarm.Tests;

public sealed class InboundMcpTransportTests
{
    [Fact]
    public async Task DELETE_fences_first_closes_physical_GET_and_awaits_real_downstream_DELETE_before_response_headers()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["url"] = peer.Url + "/mcp?holdDelete=1", ["transport"] = "streamable-http" }, default);
        await using var alpha = await f.ClientAsync(standaloneGet: false);
        await using var beta = await f.ClientAsync(InboundMcpFixture.Beta);
        var result = await InboundMcpFixture.ConcreteAsync(alpha, "mcp:peer/probe");
        var peerId = JsonNode.Parse(result["content"]![0]!["text"]!.GetValue<string>())!["id"]!.GetValue<string>();
        using var get = f.Request("GET", alpha.SessionId);
        using var getCancellation = new CancellationTokenSource();
        using var stream = await f.Http.SendAsync(get, HttpCompletionOption.ResponseHeadersRead, getCancellation.Token);
        Assert.Equal(HttpStatusCode.OK, stream.StatusCode);
        var getEnded = ReadToEndAsync(stream);
        using var delete = f.Request("DELETE", alpha.SessionId);
        var deletion = f.Http.SendAsync(delete, HttpCompletionOption.ResponseHeadersRead);
        await peer.WaitAsync("delete-pending");
        Assert.False(deletion.IsCompleted);
        await getEnded.WaitAsync(TimeSpan.FromSeconds(5));
        using (var stale = f.Request("POST", alpha.SessionId, body: "{\"jsonrpc\":\"2.0\",\"id\":17,\"method\":\"tools/list\"}"))
            Assert.Equal(HttpStatusCode.NotFound, (await f.Http.SendAsync(stale)).StatusCode);
        Assert.NotNull(await beta.ListToolsAsync(new ListToolsRequestParams()));
        await peer.ReleaseAsync("delete-" + peerId);
        using var deleted = await deletion.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        Assert.Single(await peer.EventsAsync(), row => row["kind"]?.GetValue<string>() == "delete");
    }

    [Fact]
    public async Task Actual_service_POST_idle_keeps_active_POST_but_not_a_physical_GET_alive()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["url"] = peer.Url + "/mcp", ["transport"] = "streamable-http" }, default);
        await using var listener = await ShortService.StartAsync(f, TimeSpan.FromMilliseconds(300));
        await using var client = await f.ClientAsync(standaloneGet: false);
        using var get = f.Request("GET", client.SessionId);
        using var stream = await f.Http.SendAsync(get, HttpCompletionOption.ResponseHeadersRead);
        var ended = ReadToEndAsync(stream);
        var held = InboundMcpFixture.ConcreteAsync(client, "mcp:peer/hold", new JsonObject { ["tag"] = "active" });
        await peer.WaitAsync("effect", "active");
        await Task.Delay(700); // Deliberately cross more than two actual service idle sweeps.
        Assert.False(ended.IsCompleted); Assert.False(held.IsCompleted);
        await peer.ReleaseAsync("active");
        Assert.Null((await held)["isError"]);
        await ended.WaitAsync(TimeSpan.FromSeconds(5));
        using var stale = f.Request("DELETE", client.SessionId);
        Assert.Equal(HttpStatusCode.NotFound, (await f.Http.SendAsync(stale)).StatusCode);
        await using var fresh = await f.ClientAsync();
        Assert.NotNull(await fresh.ListToolsAsync(new ListToolsRequestParams()));
    }

    [Fact]
    public async Task Actual_service_deadline_or_aborted_POST_does_not_replay_effect_or_destroy_initialized_owner()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["url"] = peer.Url + "/mcp", ["transport"] = "streamable-http" }, default);
        await using var listener = await ShortService.StartAsync(f, TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(200));
        await using var client = await f.ClientAsync();
        var id = client.SessionId;
        // A real post-effect timeout may produce an MCP error result or an already-started aborted SSE body.
        var timed = InboundMcpFixture.ConcreteAsync(client, "mcp:peer/hold", new JsonObject { ["tag"] = "deadline" });
        await peer.WaitAsync("effect", "deadline");
        try { var result = await timed; Assert.True(result["isError"]!.GetValue<bool>()); }
        catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException or ModelContextProtocol.McpException) { }
        Assert.NotNull(await client.ListToolsAsync(new ListToolsRequestParams()));
        Assert.Equal(id, client.SessionId);
        Assert.Single(await peer.EventsAsync(), row => row["kind"]?.GetValue<string>() == "effect" && row["tag"]?.GetValue<string>() == "deadline");
        using var abort = new CancellationTokenSource();
        using var request = f.Request("POST", id, body: "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"foxwarm_call\",\"arguments\":{\"toolId\":\"mcp:peer/hold\",\"args\":{\"tag\":\"disconnect\"}}}}");
        var disconnected = f.Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, abort.Token);
        await peer.WaitAsync("effect", "disconnect");
        abort.Cancel();
        try { using var response = await disconnected; await response.Content.ReadAsStringAsync(abort.Token); }
        catch (Exception error) when (error is OperationCanceledException or HttpRequestException or IOException) { }
        await peer.WaitAsync("cancelled", "disconnect");
        Assert.NotNull(await client.ListToolsAsync(new ListToolsRequestParams()));
        Assert.Equal(id, client.SessionId);
        Assert.Single(await peer.EventsAsync(), row => row["kind"]?.GetValue<string>() == "effect" && row["tag"]?.GetValue<string>() == "disconnect");
    }

    private static async Task ReadToEndAsync(HttpResponseMessage response)
    {
        try { await response.Content.CopyToAsync(Stream.Null); }
        catch (Exception error) when (error is IOException or HttpRequestException) { }
    }

    // Shorten only clocks on the production service; handlers, catalog and real owners are unchanged.
    private sealed class ShortService(WebApplication app, McpInboundHttp service) : IAsyncDisposable
    {
        internal static async Task<ShortService> StartAsync(InboundMcpFixture fixture, TimeSpan idle, TimeSpan? deadline = null)
        {
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            var service = new McpInboundHttp(fixture.Configuration.Access, new McpInboundCatalog(fixture.Manager), idle, postDeadline: deadline);
            service.Register(app); await app.StartAsync();
            fixture.Url = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single() + "/mcp";
            return new(app, service);
        }
        public async ValueTask DisposeAsync() { await service.DisposeAsync(); await app.StopAsync(); await app.DisposeAsync(); }
    }
}
