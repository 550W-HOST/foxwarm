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

    [Theory]
    [InlineData("control")]
    [InlineData("slash")]
    [InlineData("route")]
    public async Task PublicStopFinalizesAnInputWhileItsProcessorWaitsForAdmission(string path)
    {
        await using var f = await Fixture.Create(TenantLimits.Defaults with { BusyTurns = 1 });
        var holder = await f.Manager.CreateNamedAsync("main", "holder", null, null);
        using var slot = await holder.Registry.TurnAdmission!(default);
        var owner = (await f.Manager.GetExistingAsync("uploads"))!;
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("pending input"));
        var waiting = owner.StartProcessing();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!owner.Entry.HasProcessor)
            await Task.Delay(5, deadline.Token);
        Assert.False(owner.Metadata().Busy);
        using var response = path switch
        {
            "control" => await f.Client.PostAsJsonAsync("api/sessions/uploads/message", new { text = "/stop", controlRequestId = "stop-1" }),
            "slash" => await f.Client.PostAsJsonAsync("api/sessions/uploads/message", new { text = "/stop" }),
            _ => await f.Client.PostAsync("api/sessions/uploads/stop", null),
        };
        response.EnsureSuccessStatusCode();
        await waiting.WaitAsync(deadline.Token);
        Assert.Empty(owner.Entry.Snapshot().Queue);
        Assert.Contains(owner.History(), row => row.ToJsonString().Contains("pending input"));
        Assert.Equal(1, f.Manager.Admission!.Turns.InUse);
    }

    [Fact]
    public async Task CwdChangeResolvesTheOwnerAfterReadingItsBody()
    {
        await using var f = await Fixture.Create(TenantLimits.Defaults);
        var before = (await f.Manager.GetExistingAsync("uploads"))!;
        const string body = "{\"cwd\":\"work\"}";
        using var client = new System.Net.Sockets.TcpClient();
        await client.ConnectAsync(f.Base.Host, f.Base.Port);
        var stream = client.GetStream();
        using var reader = new StreamReader(stream);
        await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes(
            $"POST /api/sessions/uploads/cwd HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {Token}\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n"));
        Assert.Contains("100 Continue", await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal("", await reader.ReadLineAsync());
        f.Manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Equal(1, f.Manager.ReleaseIdleOwners());
        Assert.True(before.Entry.Retired);
        await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes(body));
        Assert.Contains("200 OK", await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5)));
        var after = (await f.Manager.GetExistingAsync("uploads"))!;
        Assert.NotSame(before, after);
        Assert.Equal("work", after.Entry.Snapshot().AuthorityEnvelope["cwd"]?.ToString());
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
        // A declared length past the limit and its multipart framing is refused before the body
        // is read.
        using var declared = await f.Client.PostAsync("api/upload?sessionId=uploads", Upload(2 * 1024 * 1024 + 1));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, declared.StatusCode);
        var body = (await declared.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("This file is larger than the 1 MiB upload limit.", body["error"]!.GetValue<string>());
        Assert.Equal(1024 * 1024, body["maxBytes"]!.GetValue<long>());
        // A file just over the limit is refused by its own size, with the same text.
        using var file = new HttpClient { BaseAddress = f.Base };
        file.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        using var refused = await file.PostAsync("api/upload?sessionId=uploads", Upload(1024 * 1024 + 1));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, refused.StatusCode);
        Assert.Equal(
            "This file is larger than the 1 MiB upload limit.",
            (await refused.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.GetValue<string>()
        );
        using var fresh = new HttpClient { BaseAddress = f.Base };
        fresh.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        using var accepted = await fresh.PostAsync("api/upload?sessionId=uploads", Upload(1024 * 1024 - 4096));
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
    }

    // Content sent chunked: no declared length for the server to check up front.
    private sealed class Chunked(HttpContent inner) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context) =>
            inner.CopyToAsync(stream);

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    [Fact]
    public async Task AnUploadRequestIsLimitedAsItStreams()
    {
        await using var f = await Fixture.Create(TenantLimits.Defaults with { UploadBytes = 64 * 1024 });
        // A small file inside a body far larger than the file limit and its overhead, made of
        // fields each within the per-section limit.
        var multipart = Upload(1024);
        for (var index = 0; index < 40; index++)
            multipart.Add(new StringContent(new string('x', 60 * 1024)), "padding" + index);
        var content = new Chunked(multipart);
        content.Headers.ContentType = multipart.Headers.ContentType;
        using var refused = await f.Client.PostAsync("api/upload?sessionId=uploads", content);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, refused.StatusCode);
        Assert.Equal(
            "This file is larger than the 64 KiB upload limit.",
            (await refused.Content.ReadFromJsonAsync<JsonObject>())!["error"]!.GetValue<string>()
        );
        var small = Upload(1024);
        var smallContent = new Chunked(small);
        smallContent.Headers.ContentType = small.Headers.ContentType;
        // The server closes a connection whose oversized body it didn't read; a new one follows.
        using var fresh = new HttpClient { BaseAddress = f.Base };
        fresh.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        using var accepted = await fresh.PostAsync("api/upload?sessionId=uploads", smallContent);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
    }

    [Fact]
    public async Task AFileJustUnderTheLimitIsntRefusedForItsMultipartFraming()
    {
        const int limit = 64 * 1024;
        await using var f = await Fixture.Create(TenantLimits.Defaults with { UploadBytes = limit });
        // The file fits; its multipart body, with boundaries and part headers, doesn't.
        using var multipart = Upload(limit - 100);
        Assert.True(multipart.Headers.ContentLength > limit);
        using var accepted = await f.Client.PostAsync("api/upload?sessionId=uploads", multipart);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        // The limit itself still holds for the file.
        using var fresh = new HttpClient { BaseAddress = f.Base };
        fresh.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        using var refused = await fresh.PostAsync("api/upload?sessionId=uploads", Upload(limit + 1));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, refused.StatusCode);
    }
}
