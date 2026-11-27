using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests.Hosted;

// The production hosted runtime composition on TenantServer behind one front (P2 E1 spike):
// two tenants share the front's listener; each request reaches its own tenant's pipeline.
[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class HostedTenantServerTests
{
    [Fact]
    public async Task TwoTenantRuntimesServeTheirOwnHostsBehindOneFront()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await harness.StartAsync("alpha", front);
        await using var beta = await harness.StartAsync("beta", front);

        Assert.Equal(HttpStatusCode.OK, (await alpha.Client.GetAsync("api/sessions")).StatusCode);
        // A tenant's credential is an ordinary authentication failure on another tenant's host.
        using var crossed = front.Client(HostedRuntimeHarness.Host("beta"), alpha.Token);
        Assert.Equal(HttpStatusCode.Unauthorized, (await crossed.GetAsync("api/sessions")).StatusCode);
        var created = await alpha.Client.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId = "only-alpha" });
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        Assert.Contains("only-alpha", await alpha.Client.GetStringAsync("api/sessions"));
        Assert.DoesNotContain("only-alpha", await beta.Client.GetStringAsync("api/sessions"));

        // Response compression in the tenant pipeline.
        using var compressed = new HttpRequestMessage(HttpMethod.Get, "api/sessions");
        compressed.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("gzip"));
        Assert.Equal("gzip", Assert.Single((await alpha.Client.SendAsync(compressed)).Content.Headers.ContentEncoding));

        // A Session's server-sent event stream starts at once and stays open.
        using var stream = await alpha.Client.GetAsync("api/sessions/only-alpha/stream", HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal("text/event-stream", stream.Content.Headers.ContentType?.MediaType);

        // The upload route raises the front's 2 MiB request limit for its request (the limit itself
        // is the front's: TenantServerTests).
        var large = new string('x', 3 * 1024 * 1024);
        using var upload = new MultipartFormDataContent
        {
            { new ByteArrayContent(Encoding.UTF8.GetBytes(large)), "file", "large.txt" },
        };
        var uploaded = await alpha.Client.PostAsync("api/upload", upload);
        Assert.NotEqual(HttpStatusCode.RequestEntityTooLarge, uploaded.StatusCode);
    }

    // Review 4b #3: a tenant can't stop the replica's process; the single-tenant runtime still can.
    [Fact]
    public async Task ShutdownIsRefusedBehindTheFrontAndTheTenantKeepsServing()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await harness.StartAsync("alpha", front);
        await using var beta = await harness.StartAsync("beta", front);
        var refused = await alpha.Client.PostAsync("admin/shutdown", null);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal(
            "Shutting down isn't available in this deployment.",
            JsonNode.Parse(await refused.Content.ReadAsStringAsync())!["error"]!.GetValue<string>()
        );
        await Task.Delay(300);
        Assert.False(alpha.Host.Stopped.IsCompleted, "the tenant runtime stopped");
        Assert.Equal(HttpStatusCode.OK, (await alpha.Client.GetAsync("api/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await beta.Client.GetAsync("api/sessions")).StatusCode);

        await using var single = await harness.StartAsync("single");
        Assert.Equal(HttpStatusCode.Accepted, (await single.Client.PostAsync("admin/shutdown", null)).StatusCode);
        await single.Host.Stopped.WaitAsync(TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task TheWebUiSocketUpgradesThroughTheFrontAndTenantHostsHaveNoLogs()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await harness.StartAsync("alpha", front);
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Host", HostedRuntimeHarness.Host("alpha"));
        socket.Options.SetRequestHeader("Authorization", "Bearer " + alpha.Token);
        await socket.ConnectAsync(new UriBuilder(front.BaseUri) { Scheme = "ws", Path = "api/webui/stream" }.Uri, CancellationToken.None);
        var subscription = new JsonObject
        {
            ["type"] = "set-subscriptions",
            ["revision"] = 1,
            ["sessionListActive"] = false,
            ["sessionIds"] = new JsonArray(),
            ["sessionListIds"] = new JsonArray(),
            ["logs"] = new JsonObject { ["id"] = "logs-1" },
        };
        await socket.SendAsync(Encoding.UTF8.GetBytes(subscription.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);
        var buffer = new byte[64 * 1024];
        string? error = null;
        while (socket.State == WebSocketState.Open)
        {
            var received = await socket.ReceiveAsync(buffer, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10));
            if (received.MessageType == WebSocketMessageType.Close)
                break;
            var frame = JsonNode.Parse(Encoding.UTF8.GetString(buffer, 0, received.Count));
            if (frame?["type"]?.ToString() == "protocol-error")
                error = frame["message"]?.ToString();
        }
        Assert.Equal("Logs are unavailable.", error);
        // The tenant's close status and reason reach the client through the front.
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, socket.CloseStatus);
        Assert.Equal("Logs are unavailable.", socket.CloseStatusDescription);
        Assert.Equal(HttpStatusCode.NotFound, (await alpha.Client.GetAsync("api/webui/logs?direction=latest")).StatusCode);
    }

    [Fact]
    public async Task InboundMcpStreamsThroughTheFront()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await harness.StartAsync("alpha", front);
        const string token = "synthetic-mcp-identity-token-0001";
        var saved = await alpha.Client.PostAsJsonAsync(
            "api/setup/config",
            new { yaml = $"access: {{identities: {{client: {{token: {token}, surfaces: {{mcp: {{}}}}}}}}}}\n" }
        );
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
        using var mcp = front.Client(HostedRuntimeHarness.Host("alpha"), token);
        using var initialize = new HttpRequestMessage(HttpMethod.Post, "mcp")
        {
            Content = new StringContent(
                new JsonObject
                {
                    ["jsonrpc"] = "2.0",
                    ["id"] = 1,
                    ["method"] = "initialize",
                    ["params"] = new JsonObject
                    {
                        ["protocolVersion"] = "2025-06-18",
                        ["capabilities"] = new JsonObject(),
                        ["clientInfo"] = new JsonObject { ["name"] = "spike", ["version"] = "1" },
                    },
                }.ToJsonString(),
                Encoding.UTF8,
                "application/json"
            ),
        };
        initialize.Headers.Accept.ParseAdd("application/json, text/event-stream");
        var initialized = await mcp.SendAsync(initialize);
        var body = await initialized.Content.ReadAsStringAsync();
        Assert.True(initialized.IsSuccessStatusCode, body);
        Assert.Contains("\"protocolVersion\"", body);
        var session = initialized.Headers.GetValues("Mcp-Session-Id").Single();

        // The server-to-client stream opens and stays open until the client leaves.
        using var listen = new HttpRequestMessage(HttpMethod.Get, "mcp");
        listen.Headers.Accept.ParseAdd("text/event-stream");
        listen.Headers.Add("Mcp-Session-Id", session);
        listen.Headers.Add("MCP-Protocol-Version", "2025-06-18");
        using var events = await mcp.SendAsync(listen, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, events.StatusCode);
        Assert.Equal("text/event-stream", events.Content.Headers.ContentType?.MediaType);
        await using var reading = await events.Content.ReadAsStreamAsync();
        var read = reading.ReadAsync(new byte[1]).AsTask();
        Assert.False(read.Wait(TimeSpan.FromMilliseconds(500)) && read.Result == 0, "the stream ended");
    }

    [Fact]
    public async Task ARetiredTenantIsRefusedAtTheFrontWhileTheOtherKeepsServing()
    {
        await using var harness = await HostedRuntimeHarness.CreateAsync();
        await using var front = await TenantFront.StartAsync();
        var alpha = await harness.StartAsync("alpha", front);
        await using var beta = await harness.StartAsync("beta", front);
        using var alphaClient = front.Client(HostedRuntimeHarness.Host("alpha"), alpha.Token);
        var stopping = System.Diagnostics.Stopwatch.StartNew();
        await alpha.DisposeAsync();
        Assert.InRange(stopping.ElapsedMilliseconds, 0, 10_000);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await alphaClient.GetAsync("api/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await beta.Client.GetAsync("api/sessions")).StatusCode);
    }
}
