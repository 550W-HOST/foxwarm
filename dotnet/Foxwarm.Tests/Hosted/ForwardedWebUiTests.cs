using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class ForwardedWebUiTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ScopedRealtimeAndAdministratorTerminalUseTheirRealWebSocketRoutes(bool terminalOnly)
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("operator");
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenants SET profile='operator' WHERE name='operator'");
        var owner = await cluster.StartAsync("owner", new Dictionary<string,string> { ["FOXWARM_ROLE"] = "master-host" });
        using (var warm = await owner.GetAsync("operator")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        var admin = await cluster.SignInTokenAsync("operator");
        using var http = Public(edge, "operator", admin);
        using var session = await http.PostAsJsonAsync("api/sessions", new { sessionId = "chat" });
        Assert.True(session.IsSuccessStatusCode, await session.Content.ReadAsStringAsync());
        const string scoped = "synthetic-scoped-realtime-access";
        var saved = await http.PostAsJsonAsync("api/setup/config", new { yaml = $"access: {{identities: {{viewer: {{token: {scoped}, surfaces: {{webui: {{sessions: [chat]}}}}}}}}}}\n" });
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        if (!terminalOnly)
        {
            using var realtime = Socket("operator", scoped);
            await realtime.ConnectAsync(new Uri($"ws://127.0.0.1:{edge.FrontPort}/api/webui/stream"), bound.Token);
            Assert.Equal("connected", (await Frame(realtime, bound.Token))["type"]!.ToString());
            await realtime.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"set-subscriptions\",\"revision\":1,\"sessionIds\":[\"chat\"],\"sessionListIds\":[],\"sessionListActive\":false}"), WebSocketMessageType.Text, true, bound.Token);
            while ((await Frame(realtime, bound.Token))["type"]!.ToString() != "subscriptions-applied") { }
            return;
        }
        using var createTerminal = await http.PostAsJsonAsync("api/terminals", new { nodeId = "master" });
        var terminal = await createTerminal.Content.ReadAsStringAsync();
        Assert.True(createTerminal.IsSuccessStatusCode, terminal);
        var path = JsonNode.Parse(terminal)!["streamPath"]!.ToString();
        var uri = new Uri($"ws://127.0.0.1:{edge.FrontPort}{path}");
        using var denied = Socket("operator", scoped);
        denied.Options.CollectHttpResponseDetails = true;
        await Assert.ThrowsAsync<WebSocketException>(() => denied.ConnectAsync(uri, bound.Token));
        Assert.Equal(HttpStatusCode.Forbidden, denied.HttpStatusCode);
        using var console = Socket("operator", admin);
        await console.ConnectAsync(uri, bound.Token);
        Assert.Equal(WebSocketState.Open, console.State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RemoteUploadUsesTheOwnersLimitAndTemplatesUseItsTrustedPublicPrefix(bool templateOnly)
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("alpha");
        await cluster.Database.ExecuteOwnerAsync("UPDATE tenants SET limits='{\"uploadBytes\":4194304}' WHERE name='alpha'");
        var owner = await cluster.StartAsync("owner", extraConfig: "url: 'https://{slug}.test/bot'\n");
        using (var warm = await owner.GetAsync("alpha")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        using var http = Public(edge, "alpha", await cluster.SignInTokenAsync("alpha"));
        http.DefaultRequestHeaders.Add("X-Forwarded-Proto", "http");
        http.DefaultRequestHeaders.Add("X-Forwarded-Host", "untrusted.test");
        if (templateOnly)
        {
            var script = await http.GetStringAsync("node/run.sh");
            Assert.Contains("https://alpha.test/bot", script);
            Assert.DoesNotContain("untrusted.test", script);
            return;
        }
        foreach (var (size, status) in new[] { (3 * 1024 * 1024, HttpStatusCode.OK), (6 * 1024 * 1024, HttpStatusCode.RequestEntityTooLarge) })
        {
            using var form = new MultipartFormDataContent { { new ByteArrayContent(new byte[size]), "file", "attachment.bin" } };
            using var uploaded = await http.PostAsync("api/upload", form);
            Assert.Equal(status, uploaded.StatusCode);
        }
    }

    [Theory]
    [InlineData("alpha.test:8443", true)]
    [InlineData("127.0.0.1", false)]
    public async Task HostedTemplateWithoutConfiguredUrlUsesOnlyAReachableRequestOrigin(string authority, bool usable)
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("alpha");
        await cluster.Database.ExecuteOwnerAsync("INSERT INTO tenant_hostnames(hostname,tenant_id,kind) SELECT '127.0.0.1',tenant_id,'custom' FROM tenants WHERE name='alpha'");
        var owner = await cluster.StartAsync("owner");
        using (var warm = await owner.GetAsync("alpha")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false });
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{edge.FrontPort}/node/run.sh");
        request.Headers.Host = authority;
        request.Headers.Add("X-Forwarded-Host", "untrusted.test");
        request.Headers.Add("X-Forwarded-Proto", "https");
        using var response = await client.SendAsync(request);
        Assert.Equal(usable ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        if (usable) Assert.Contains($"HOST=\"http://{authority}\"", body);
        else Assert.Contains("public URL", body);
        Assert.DoesNotContain("127.0.0.1", body);
        Assert.DoesNotContain("untrusted.test", body);
    }

    [Fact]
    public async Task EmptyOptionalBodiesAreAbsentAndMalformedNonemptyBodiesRemainBadRequests()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        await cluster.AddTenantAsync("alpha");
        var owner = await cluster.StartAsync("owner");
        using (var warm = await owner.GetAsync("alpha")) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        var edge = await cluster.StartAsync("edge");
        using var http = Public(edge, "alpha", await cluster.SignInTokenAsync("alpha"));
        using var made = await http.PostAsJsonAsync("api/sessions", new { sessionId = "optional" });
        Assert.True(made.IsSuccessStatusCode, await made.Content.ReadAsStringAsync());
        foreach (var (method, route) in new[] { (HttpMethod.Delete, "api/sessions/optional"),
            (HttpMethod.Post, "api/agents/main/isolation-migration") })
        {
            using var malformed = await Send("{");
            Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);
            using var empty = await Send("");
            if (method == HttpMethod.Delete) Assert.True(empty.IsSuccessStatusCode, await empty.Content.ReadAsStringAsync());
            else
            {
                using var absent = await http.PostAsync(route, null);
                Assert.Equal(absent.StatusCode, empty.StatusCode);
                Assert.Equal(await absent.Content.ReadAsStringAsync(), await empty.Content.ReadAsStringAsync());
            }
            async Task<HttpResponseMessage> Send(string text)
            {
                using var request = new HttpRequestMessage(method, route) { Content = new StringContent(text, Encoding.UTF8, "application/json") };
                request.Headers.TransferEncodingChunked = true;
                return await http.SendAsync(request);
            }
        }
    }

    private static HttpClient Public(ReplicaProcessHarness.Replica edge, string slug, string token)
    {
        var http = new HttpClient(new SocketsHttpHandler { UseProxy = false }) { BaseAddress = new Uri($"http://127.0.0.1:{edge.FrontPort}/") };
        http.DefaultRequestHeaders.Host = slug + ".test";
        http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return http;
    }

    private static ClientWebSocket Socket(string slug, string token)
    {
        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Host", slug + ".test");
        socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
        return socket;
    }

    private static async Task<JsonNode> Frame(ClientWebSocket socket, CancellationToken token)
    {
        var buffer = new byte[4096];
        using var output = new MemoryStream();
        WebSocketReceiveResult read;
        do
        {
            read = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
            Assert.Equal(WebSocketMessageType.Text, read.MessageType);
            output.Write(buffer, 0, read.Count);
        } while (!read.EndOfMessage);
        return JsonNode.Parse(output.ToArray())!;
    }
}
