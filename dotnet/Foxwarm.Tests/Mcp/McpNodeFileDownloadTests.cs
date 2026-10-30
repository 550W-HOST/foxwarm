using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class McpNodeFileDownloadTests
{
    private static async Task Send(ClientWebSocket socket, JsonObject value) =>
        await socket.SendAsync(
            Encoding.UTF8.GetBytes(value.ToJsonString()),
            WebSocketMessageType.Text,
            true,
            default
        );

    private static async Task<JsonObject> Read(ClientWebSocket socket)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var output = new MemoryStream();
        var buffer = new byte[65536];
        WebSocketReceiveResult frame;
        do
        {
            frame = await socket.ReceiveAsync(buffer, deadline.Token);
            output.Write(buffer, 0, frame.Count);
        } while (!frame.EndOfMessage);
        return JsonNode.Parse(output.ToArray())!.AsObject();
    }

    private static async Task<ClientWebSocket> Connect(
        InboundMcpFixture f,
        string type = "cli-node",
        int version = 3,
        bool read = true
    )
    {
        var credential = f.Manager.Nodes.Registry.Create("download-node");
        var socket = new ClientWebSocket();
        await socket.ConnectAsync(
            new Uri(
                f.Url.Replace("http", "ws").Replace("/mcp", "/node_ws")
                    + "?id=download-node&auth="
                    + credential["authToken"]!.GetValue<string>()
            ),
            default
        );
        await Send(
            socket,
            new()
            {
                ["type"] = "node_register",
                ["nodeType"] = type,
                ["nodeProtocol"] = new JsonObject { ["min"] = version, ["max"] = version },
                ["capabilities"] = new JsonObject
                {
                    ["tools"] = read
                        ? new JsonArray(
                            new JsonObject
                            {
                                ["name"] = "read",
                                ["parameters"] = new JsonObject { ["type"] = "object" },
                            }
                        )
                        : new JsonArray(),
                    ["services"] = new JsonObject { ["vscode-fs"] = 1 },
                    ["features"] = new JsonObject { ["externalToolOwner"] = 1 },
                },
            }
        );
        Assert.Equal("registered", (await Read(socket))["type"]!.GetValue<string>());
        return socket;
    }

    private static Task<HttpResponseMessage> Download(
        InboundMcpFixture f,
        string query,
        string token = InboundMcpFixture.Alpha,
        string? suppliedContext = null
    )
    {
        var request = new HttpRequestMessage(
            HttpMethod.Get,
            f.Url.Replace("/mcp", "/api/vscode-web/fs/read-file") + "?" + query
        );
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
        if (suppliedContext is not null)
            request.Headers.Add("Mcp-Session-Id", suppliedContext);
        return f.Http.SendAsync(request);
    }

    private static string Query(string path) =>
        "nodeId=download-node&path=" + Uri.EscapeDataString(path);

    private static Task Reply(ClientWebSocket socket, JsonObject request, JsonObject result) =>
        Send(
            socket,
            new()
            {
                ["type"] = "node_service_response",
                ["requestId"] = request["requestId"]!.DeepClone(),
                ["result"] = result,
            }
        );

    [Fact]
    public async Task Headless_stateless_download_uses_exact_external_read_policy_and_only_fixed_remote_service()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        using var socket = await Connect(f);
        await f.PolicyAsync(
            "version: 1\ndefaultAction: allow\nrules:\n- id: one-file\n  action: allow\n  match:\n    externalId: alpha\n    tool: {source: node, name: read}\n    targetNode: download-node\n    args: {filePath: {oneOf: ['/exports/raw.bin', 'C:\\exports\\raw.bin']}}\n"
        );
        foreach (
            var query in new[]
            {
                "path=/exports/raw.bin",
                "nodeId=download-node",
                Query("relative"),
                Query("~/raw.bin"),
                Query("$fw_agentdir/raw.bin"),
                Query("/bad\0path"),
                Query("/exports/raw.bin") + "&path=/exports/raw.bin",
            }
        )
            Assert.Equal(HttpStatusCode.BadRequest, (await Download(f, query)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Download(f, "nodeId=master&path=/exports/raw.bin")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await Download(f, Query("/exports/raw.bin"), "unknown-token")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (
                await Download(
                    f,
                    Query("/exports/raw.bin"),
                    InboundMcpFixture.Alpha + ", Bearer " + InboundMcpFixture.Alpha
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Download(f, Query("/exports/raw.bin"), InboundMcpFixture.Beta)).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Download(f, Query("/exports/not-allowed.bin"))).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Download(f, "nodeId=another&path=/exports/raw.bin")).StatusCode
        );
        // A wire header cannot supply the absent Session fact on this independent route.
        await f.PolicyAsync(
            "version: 1\nrules:\n- id: invented-context\n  action: allow\n  match: {externalId: alpha, session: supplied-context, tool: read}\n"
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await Download(f, Query("/exports/raw.bin"), suppliedContext: "supplied-context")
            ).StatusCode
        );
        await f.PolicyAsync(
            "version: 1\nrules:\n- id: physical-only\n  action: allow\n  match: {externalId: alpha, tool: read, path: {allWithin: /exports}}\n"
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Download(f, Query("/exports/raw.bin"))).StatusCode
        );
        await Send(socket, new() { ["type"] = "ping" });
        Assert.Equal("pong", (await Read(socket))["type"]!.GetValue<string>()); // No denied request reached the service.
        await f.PolicyAsync(
            "version: 1\nrules:\n- id: read\n  action: allow\n  match: {externalId: alpha, tool: {source: node, name: read}, targetNode: download-node}\n"
        );
        var bytes = new byte[] { 0, 255, 128, 13, 10, 42 };
        foreach (var path in new[] { "/exports/raw.bin", "C:\\exports\\raw.bin" })
        {
            var pending = Download(f, Query(path) + "&service=vscode-git&operation=delete");
            var request = await Read(socket);
            Assert.Equal("node_service_request", request["type"]!.GetValue<string>());
            Assert.Equal("vscode-fs", request["service"]!.GetValue<string>());
            Assert.Equal("read-file", request["operation"]!.GetValue<string>());
            Assert.Equal(path, request["args"]!["path"]!.GetValue<string>());
            Assert.Single(request["args"]!.AsObject());
            Assert.Null(request["sessionId"]);
            Assert.Null(request["agentName"]);
            await Reply(
                socket,
                request,
                new() { ["contentBase64"] = Convert.ToBase64String(bytes) }
            );
            using var response = await pending;
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(bytes, await response.Content.ReadAsByteArrayAsync());
        }
        Assert.Single(f.Manager.Catalog.List()); // The route created no external Agent or Session.
        socket.Abort();
    }

    [Fact]
    public async Task Download_rechecks_live_policy_before_publishing_and_sanitizes_remote_errors()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        using var socket = await Connect(f);
        var pending = Download(f, Query("/exports/raw.bin"));
        var request = await Read(socket);
        await f.PolicyAsync("version: 1\nrules: []\n");
        await Reply(socket, request, new() { ["contentBase64"] = "AP+A" });
        Assert.Equal(HttpStatusCode.Forbidden, (await pending).StatusCode);
        await f.PolicyAsync(
            "version: 1\nrules: [{id: external, action: allow, match: {externalId: alpha}}]\n"
        );
        pending = Download(f, Query("/exports/raw.bin"));
        request = await Read(socket);
        await Send(
            socket,
            new()
            {
                ["type"] = "node_service_error",
                ["requestId"] = request["requestId"]!.DeepClone(),
                ["error"] = new JsonObject
                {
                    ["statusCode"] = 501,
                    ["message"] = "Synthetic private backend detail",
                },
            }
        );
        using var failed = await pending;
        Assert.Equal(HttpStatusCode.NotImplemented, failed.StatusCode);
        Assert.DoesNotContain("private", await failed.Content.ReadAsStringAsync());
        socket.Abort();
    }

    [Theory]
    [InlineData("browser-extension", 3, true)]
    [InlineData("cli-node", 2, true)]
    [InlineData("cli-node", 3, false)]
    public async Task Download_requires_a_compatible_CLI_read_capability(
        string type,
        int version,
        bool read
    )
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        using var socket = await Connect(f, type, version, read);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await Download(f, Query("/exports/raw.bin"))).StatusCode
        );
        await Send(socket, new() { ["type"] = "ping" });
        Assert.Equal("pong", (await Read(socket))["type"]!.GetValue<string>());
        socket.Abort();
    }
}
