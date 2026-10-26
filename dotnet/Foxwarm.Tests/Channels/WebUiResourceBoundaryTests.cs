using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class WebUiResourceBoundaryTests
{
    [Fact]
    public async Task Scope_only_install_fences_prepared_artifact_responses_but_preserves_other_identity_and_still_allowed_upload()
    {
        await using var f = await Fixture.Create();
        var original = await f.Viewer.GetByteArrayAsync(f.Resource);
        Assert.Equal(f.Image, original);
        Assert.Equal(HttpStatusCode.OK, (await f.Viewer.GetAsync(f.Document)).StatusCode);
        using var multipart = new MultipartFormDataContent();
        multipart.Add(
            new ByteArrayContent(Encoding.UTF8.GetBytes("retained attachment")),
            "file",
            "retained.txt"
        );
        var uploaded = await f.Viewer.PostAsync("api/upload?sessionId=survivor", multipart);
        Assert.Equal(HttpStatusCode.OK, uploaded.StatusCode);
        var upload = (await uploaded.Content.ReadFromJsonAsync<JsonObject>())!;
        var staged = SessionWait.Text(upload["path"])!;

        var document = f.Hold(f.Document);
        var resource = f.Hold(f.Resource);
        var readingDocument = f.Viewer.GetAsync(f.Document);
        var readingResource = f.Viewer.GetAsync(f.Resource);
        await Task.WhenAll(document.Reached.Task, resource.Reached.Task)
            .WaitAsync(TimeSpan.FromSeconds(10));
        // Both requests have passed the actual immutable record/resource owners and selected 200 responses.
        Assert.True(document.WasAuthorized);
        Assert.True(resource.WasAuthorized);
        Assert.Equal("application/json", document.ContentType!.Split(';')[0]);
        Assert.Equal("image/png", resource.ContentType);
        try
        {
            var installed = await f.Admin.PostAsJsonAsync(
                "api/setup/config",
                new { yaml = Fixture.AppYaml("[survivor]") }
            );
            Assert.Equal(HttpStatusCode.OK, installed.StatusCode);
            Assert.NotNull(f.Configuration.Access.Authenticate("synthetic-resource-viewer"));
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await f.Viewer.GetAsync(f.Document)).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await f.Viewer.GetAsync(f.Resource)).StatusCode
            );
            Assert.Equal(f.Image, await f.Other.GetByteArrayAsync(f.Resource));
            Assert.True(File.Exists(staged));
            var accepted = await f.Viewer.PostAsJsonAsync(
                "api/sessions/survivor/message",
                new JsonObject
                {
                    ["text"] = "still allowed",
                    ["uploadedFiles"] = new JsonArray(upload.DeepClone()),
                }
            );
            Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
            Assert.False(File.Exists(staged));
            var survivor = (await f.Runtime.GetOwnerAsync("survivor"))!;
            Assert.Single(survivor.Entry.Snapshot().Queue);
            var saved = Directory.GetFiles(
                Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "webui"),
                "*retained.txt"
            );
            Assert.Equal("retained attachment", await File.ReadAllTextAsync(Assert.Single(saved)));
        }
        finally
        {
            document.Release.TrySetResult();
            resource.Release.TrySetResult();
        }
        await AssertAborted(readingDocument);
        await AssertAborted(readingResource);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Canonical_move_or_deletion_fences_prepared_artifact_and_bound_WS_SSE_without_revoking_surviving_session(
        bool move
    )
    {
        await using var f = await Fixture.Create();
        using var deletedSocket = await f.Subscribe("asset-owner");
        using var survivorSocket = await f.Subscribe("survivor");
        using var sse = await f.Viewer.GetAsync(
            "api/sessions/asset-owner/stream",
            HttpCompletionOption.ResponseHeadersRead
        );
        Assert.Equal(HttpStatusCode.OK, sse.StatusCode);
        using var stream = await sse.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);
        Assert.Contains("connected", await reader.ReadLineAsync());
        Assert.Equal("", await reader.ReadLineAsync());
        Assert.Contains("session-state", await reader.ReadLineAsync());
        Assert.Equal("", await reader.ReadLineAsync());
        var held = f.Hold(f.Resource);
        var reading = f.Viewer.GetAsync(f.Resource);
        await held.Reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(held.WasAuthorized);
        f.Viewer.DefaultRequestHeaders.Remove("X-Publication-Hold");
        try
        {
            if (move)
            {
                Assert.Equal(
                    HttpStatusCode.Created,
                    (
                        await f.Admin.PostAsJsonAsync("api/agents", new { agentId = "team" })
                    ).StatusCode
                );
                Assert.Equal(
                    HttpStatusCode.OK,
                    (
                        await f.Admin.PostAsJsonAsync(
                            "api/sessions/asset-owner/message",
                            new { text = "/session move team/moved" }
                        )
                    ).StatusCode
                );
                Assert.Null(f.Runtime.Catalog.Get("asset-owner"));
                Assert.Equal(
                    "team/moved",
                    SessionCatalog.Text(f.Runtime.Catalog.Resolve("asset-owner")["sessionId"])
                );
                // Exact scope follows the committed alias; artifacts retain their original exact receipt owner.
                Assert.Equal(f.Image, await f.Viewer.GetByteArrayAsync(f.Resource));
                Assert.Equal(
                    HttpStatusCode.NotFound,
                    (
                        await f.Viewer.GetAsync(f.Resource.Replace("asset-owner", "team%2Fmoved"))
                    ).StatusCode
                );
            }
            else
            {
                var deleted = await f.Admin.DeleteAsync("api/sessions/asset-owner");
                var body = await deleted.Content.ReadAsStringAsync();
                Assert.True(
                    deleted.StatusCode == HttpStatusCode.OK,
                    $"Expected HTTP 200; DELETE returned {(int)deleted.StatusCode} ({deleted.StatusCode}). Body: {body}"
                );
                Assert.Null(f.Runtime.Catalog.Get("asset-owner"));
                Assert.Equal(
                    HttpStatusCode.Forbidden,
                    (await f.Viewer.GetAsync(f.Resource)).StatusCode
                );
            }
            Assert.Equal(
                HttpStatusCode.OK,
                (await f.Viewer.GetAsync("api/sessions/survivor/history")).StatusCode
            );
            await AssertSocketClosed(deletedSocket);
            try
            {
                _ = await reader.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (IOException) { }
            // The same unchanged identity can still use its independent surviving stream.
            await Fixture.SendSubscription(survivorSocket, "survivor", 2);
            await Fixture.UntilApplied(survivorSocket, 2);
            Assert.NotNull(f.Configuration.Access.Authenticate("synthetic-resource-viewer"));
        }
        finally
        {
            held.Release.TrySetResult();
        }
        await AssertAborted(reading);
    }

    private static async Task AssertAborted(Task<HttpResponseMessage> request)
    {
        await Assert.ThrowsAsync<HttpRequestException>(async () =>
        {
            using var response = await request.WaitAsync(TimeSpan.FromSeconds(10));
            _ = await response.Content.ReadAsByteArrayAsync();
        });
    }

    private static async Task AssertSocketClosed(ClientWebSocket socket)
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            while (true)
            {
                var result = await socket.ReceiveAsync(
                    new ArraySegment<byte>(new byte[65536]),
                    stop.Token
                );
                if (result.MessageType == WebSocketMessageType.Close)
                    return;
            }
        }
        catch (WebSocketException) { }
    }

    private sealed class PublicationHold
    {
        internal readonly TaskCompletionSource Reached = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource Release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal bool WasAuthorized;
        internal string? ContentType;
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly Dictionary<string, PublicationHold> holds = new(StringComparer.Ordinal);
        internal ModelConfiguration Configuration = null!;
        internal SessionManager Manager = null!;
        internal SessionRuntime Runtime = null!;
        private Foxwarm.Terminal.TerminalRegistry terminals = null!;
        private HttpServer server = null!;
        internal HttpClient Admin = null!,
            Viewer = null!,
            Other = null!;
        internal byte[] Image = null!;
        internal string Document = null!,
            Resource = null!;

        internal static string AppYaml(string viewerBindings) =>
            "vector: false\ndbWorkers: false\naccess:\n  identities:\n"
            + "    viewer:\n      token: synthetic-resource-viewer\n      surfaces:\n        webui: {sessions: "
            + viewerBindings
            + "}\n"
            + "    other:\n      token: synthetic-resource-other\n      surfaces:\n        webui: {sessions: [asset-owner]}\n";

        internal static async Task<Fixture> Create()
        {
            var f = new Fixture();
            var data = Path.Combine(f.temp.Path, "data");
            var work = Path.Combine(f.temp.Path, "work");
            Directory.CreateDirectory(Path.Combine(data, "state"));
            Directory.CreateDirectory(work);
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "config.yaml"),
                AppYaml("[asset-owner, survivor]")
            );
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "models.yaml"),
                "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"
            );
            f.Configuration = new ModelConfiguration(
                HostPaths.ForDataRoot(data, f.temp.Path, environment: _ => null)
            );
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "local/wire",
                "synthetic",
                "",
                713
            );
            f.Manager = new SessionManager(data, work, options, f.Configuration.Models);
            await f.Manager.LoadMainHostAsync();
            var owner = await f.Manager.CreateNamedAsync("main", "asset-owner", null, null);
            var survivor = await f.Manager.CreateNamedAsync("main", "survivor", null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            survivor.Registry.TriggerOverride = _ => Task.CompletedTask;
            // Publish through the ordinary authorized Main-local tool and immutable resource owner.
            f.Image = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
            var source = Path.Combine(work, "published.png");
            await File.WriteAllBytesAsync(source, f.Image);
            await using (var mcp = new McpClient(data))
            {
                var registry = SessionToolExecutor.CreateRegistry(
                    new JsonArray(ArtifactToolDefinition.Definition()),
                    mcp,
                    _ => work
                );
                var tools = new SessionToolExecutor(
                    new WorkspaceTools(work),
                    owner,
                    f.Manager,
                    registry
                );
                tools.BeginTurn();
                var published = await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["name"] = "artifact",
                        ["args"] = new JsonObject
                        {
                            ["action"] = "publish",
                            ["filePath"] = source,
                            ["type"] = "image",
                        },
                    },
                    default
                );
                Assert.Null(published!["error"]);
                var id = SessionWait.Text(published["artifact"]?["artifactId"])!;
                f.Document = $"api/sessions/asset-owner/artifacts/{id}/1";
                f.Resource = f.Document + "/resources/image";
            }
            f.terminals = new Foxwarm.Terminal.TerminalRegistry(data, default);
            f.Runtime = new SessionRuntime(f.Manager);
            f.server = new HttpServer(
                [],
                0,
                "synthetic-resource-admin",
                null,
                f.Manager,
                f.terminals,
                webUiEnabled: true
            );
            f.server.App.Use(
                async (context, next) =>
                {
                    if (
                        context.Request.Headers["X-Publication-Hold"] == "yes"
                        && f.holds.TryGetValue(
                            context.Request.Path.Value!.TrimStart('/'),
                            out var hold
                        )
                    )
                        context.Response.OnStarting(async () =>
                        {
                            hold.WasAuthorized =
                                context.Response.StatusCode == 200
                                && WebUiAccess.Request(context) is { } request
                                && request.Current
                                && request.Allows("asset-owner");
                            hold.ContentType = context.Response.ContentType;
                            hold.Reached.TrySetResult();
                            await hold.Release.Task;
                        });
                    await next();
                }
            );
            new WebUIChannel(
                f.Manager,
                f.Runtime,
                new MessageRouter(f.Runtime),
                f.terminals,
                f.server.Downloads
            ).Register(f.server.App);
            await f.server.App.StartAsync();
            HttpClient Client(string token)
            {
                var client = new HttpClient(new HttpClientHandler { UseCookies = false })
                {
                    BaseAddress = new Uri(f.server.App.Urls.Single() + "/"),
                };
                client.DefaultRequestHeaders.Authorization = new("Bearer", token);
                return client;
            }
            f.Admin = Client("synthetic-resource-admin");
            f.Viewer = Client("synthetic-resource-viewer");
            f.Other = Client("synthetic-resource-other");
            return f;
        }

        internal PublicationHold Hold(string route)
        {
            var hold = new PublicationHold();
            holds[route] = hold;
            if (!Viewer.DefaultRequestHeaders.Contains("X-Publication-Hold"))
                Viewer.DefaultRequestHeaders.TryAddWithoutValidation("X-Publication-Hold", "yes");
            return hold;
        }

        internal async Task<ClientWebSocket> Subscribe(string id)
        {
            var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("Authorization", "Bearer synthetic-resource-viewer");
            await socket.ConnectAsync(
                new UriBuilder(Admin.BaseAddress!)
                {
                    Scheme = "ws",
                    Path = "/api/webui/stream",
                }.Uri,
                default
            );
            await SendSubscription(socket, id, 1);
            await UntilApplied(socket, 1);
            return socket;
        }

        internal static async Task SendSubscription(
            ClientWebSocket socket,
            string id,
            int revision
        ) =>
            await socket.SendAsync(
                Encoding.UTF8.GetBytes(
                    new JsonObject
                    {
                        ["type"] = "set-subscriptions",
                        ["revision"] = revision,
                        ["sessionListActive"] = false,
                        ["sessionListIds"] = new JsonArray(),
                        ["sessionIds"] = new JsonArray(id),
                    }.ToJsonString()
                ),
                WebSocketMessageType.Text,
                true,
                default
            );

        internal static async Task UntilApplied(ClientWebSocket socket, int revision)
        {
            using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (true)
            {
                using var frame = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    var buffer = new byte[65536];
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), stop.Token);
                    Assert.Equal(WebSocketMessageType.Text, result.MessageType);
                    frame.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                var value = JsonNode.Parse(frame.ToArray())!;
                if (
                    SessionWait.Text(value["type"]) == "subscriptions-applied"
                    && SessionWait.Number(value["revision"]) == revision
                )
                    return;
            }
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var hold in holds.Values)
                hold.Release.TrySetResult();
            Admin?.Dispose();
            Viewer?.Dispose();
            Other?.Dispose();
            if (server is not null)
            {
                await server.App.StopAsync();
                await server.App.DisposeAsync();
            }
            if (terminals is not null)
                await terminals.DisposeAsync();
            if (Manager is not null)
                await Manager.DisposeAsync();
            temp.Dispose();
        }
    }
}
