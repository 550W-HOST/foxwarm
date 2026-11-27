using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Limits;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Limits;

// The tenant's request rate, open WebSockets and upload size in its own HTTP pipeline.
public sealed class TenantLimitHttpTests
{
    private const string Token = "synthetic-limits-admin";

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        internal SessionManager Manager = null!;
        private HttpServer server = null!;
        internal HttpClient Client = null!;
        internal Uri Base = null!;

        internal static async Task<Fixture> Create(TenantLimits? limits)
        {
            var f = new Fixture();
            var data = Path.Combine(f.temp.Path, "data");
            var work = Path.Combine(f.temp.Path, "work");
            Directory.CreateDirectory(Path.Combine(data, "state"));
            Directory.CreateDirectory(work);
            await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\ndbWorkers: false\n");
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "models.yaml"),
                "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"
            );
            var configuration = new ModelConfiguration(HostPaths.ForDataRoot(data, f.temp.Path, environment: _ => null));
            var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "local/wire", "synthetic", "", 713);
            f.Manager = new SessionManager(
                data,
                work,
                options,
                configuration.Models,
                capabilities: RuntimeCapabilities.File with { Limits = limits }
            );
            await f.Manager.LoadMainHostAsync();
            var owner = await f.Manager.CreateNamedAsync("main", "uploads", null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            var runtime = new SessionRuntime(f.Manager);
            f.server = new HttpServer([], 0, Token, null, f.Manager, null, webUiEnabled: true);
            new WebUIChannel(f.Manager, runtime, new MessageRouter(runtime), null, f.server.Downloads).Register(
                f.server.App
            );
            await f.server.App.StartAsync();
            f.Base = new Uri(f.server.App.Urls.Single() + "/");
            f.Client = new HttpClient { BaseAddress = f.Base };
            f.Client.DefaultRequestHeaders.Authorization = new("Bearer", Token);
            return f;
        }

        internal async Task<ClientWebSocket> OpenStreamAsync()
        {
            var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("Authorization", "Bearer " + Token);
            socket.Options.CollectHttpResponseDetails = true;
            var uri = new UriBuilder(new Uri(Base, "api/webui/stream")) { Scheme = "ws" }.Uri;
            try
            {
                await socket.ConnectAsync(uri, default);
            }
            catch (WebSocketException) { }
            return socket;
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            await server.App.StopAsync();
            await server.App.DisposeAsync();
            await Manager.DisposeAsync();
            temp.Dispose();
        }
    }

    [Fact]
    public async Task RequestsOverTheRateAreRefusedWithRetryAfter()
    {
        await using var f = await Fixture.Create(TenantLimits.Defaults with { RequestsPerSecond = 1, RequestBurst = 3 });
        for (var i = 0; i < 3; i++)
            Assert.Equal(HttpStatusCode.OK, (await f.Client.GetAsync("health")).StatusCode);
        using var refused = await f.Client.GetAsync("health");
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(1), refused.Headers.RetryAfter?.Delta);
        Assert.NotNull((await refused.Content.ReadFromJsonAsync<JsonObject>())!["error"]);
        await Task.Delay(1100);
        Assert.Equal(HttpStatusCode.OK, (await f.Client.GetAsync("health")).StatusCode);
    }

    [Fact]
    public async Task FileModeHasNoRequestRate()
    {
        await using var f = await Fixture.Create(null);
        for (var i = 0; i < 150; i++)
            Assert.Equal(HttpStatusCode.OK, (await f.Client.GetAsync("health")).StatusCode);
    }

    [Fact]
    public async Task OneWebSocketOverTheLimitIsRefusedBeforeItIsAccepted()
    {
        await using var f = await Fixture.Create(TenantLimits.Defaults with { WebSockets = 1 });
        using var first = await f.OpenStreamAsync();
        Assert.Equal(WebSocketState.Open, first.State);
        using var second = await f.OpenStreamAsync();
        Assert.NotEqual(WebSocketState.Open, second.State);
        Assert.Equal(HttpStatusCode.TooManyRequests, second.HttpStatusCode);
        Assert.Equal(1, f.Manager.Admission!.WebSockets.Open);
        first.Abort();
        await TelegramChannelTests.Until(() => f.Manager.Admission.WebSockets.Open == 0);
        using var third = await f.OpenStreamAsync();
        Assert.Equal(WebSocketState.Open, third.State);
    }

    private static MultipartFormDataContent Upload(int bytes)
    {
        var multipart = new MultipartFormDataContent();
        multipart.Add(new ByteArrayContent(new byte[bytes]), "file", "large.bin");
        return multipart;
    }

    [Fact]
    public async Task AnUploadOverTheTenantsLimitIsRefused()
    {
        await using var f = await Fixture.Create(TenantLimits.Defaults with { UploadBytes = 1024 * 1024 });
        using var refused = await f.Client.PostAsync("api/upload?sessionId=uploads", Upload(1024 * 1024 + 1));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, refused.StatusCode);
        var body = (await refused.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(
            body["maxBytes"]?.GetValue<long>() == 1024 * 1024
                || body["error"]!.GetValue<string>() == "This file is larger than the 1 MiB upload limit.",
            body.ToJsonString()
        );
        using var accepted = await f.Client.PostAsync("api/upload?sessionId=uploads", Upload(1024 * 1024 - 4096));
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
    }
}
