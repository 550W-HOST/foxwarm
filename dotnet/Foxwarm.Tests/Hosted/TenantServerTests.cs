using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System.Net;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using Foxwarm.Hosted.Runtimes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.ResponseCompression;

namespace Foxwarm.Tests.Hosted;

// Tenant applications on TenantServer behind a real Kestrel front with its own routing and DI
// scope (P2 E1 spike): each tenant request runs in the tenant's own context over the front's
// transport.
public sealed class TenantServerTests
{
    private sealed record Marker(string Name);

    private sealed class Tenant : IAsyncDisposable
    {
        internal required WebApplication App { get; init; }
        internal required TenantServer Server { get; init; }
        internal TaskCompletionSource Aborted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource SlowStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async ValueTask DisposeAsync() => await App.DisposeAsync();
    }

    private static async Task<Tenant> StartTenantAsync(TenantFront front, string name, TimeSpan? shutdown = null)
    {
        var server = front.Server(name + ".test");
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton<IServer>(server);
        builder.Services.AddSingleton<IHostLifetime, HostControlledLifetime>();
        builder.Services.AddScoped(_ => new Marker(name));
        builder.Services.AddResponseCompression(options => options.MimeTypes = ["text/plain"]);
        if (shutdown is { } timeout)
            builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = timeout);
        var app = builder.Build();
        Tenant? tenant = null;
        app.UseRouting();
        app.UseWebSockets();
        app.UseResponseCompression();
        app.MapGet(
            "/who",
            (HttpContext context, Marker marker) =>
                $"{marker.Name} {context.GetEndpoint()?.DisplayName} {context.Items.Count}"
        );
        app.MapPost(
            "/upload",
            async (HttpContext context) =>
            {
                if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                    limit.MaxRequestBodySize = null;
                var buffer = new MemoryStream();
                await context.Request.Body.CopyToAsync(buffer);
                return buffer.Length.ToString();
            }
        );
        app.MapPost(
            "/small",
            async (HttpContext context) =>
            {
                var buffer = new MemoryStream();
                await context.Request.Body.CopyToAsync(buffer);
                return buffer.Length.ToString();
            }
        );
        app.MapGet(
            "/events",
            async (HttpContext context) =>
            {
                context.Response.ContentType = "text/event-stream";
                for (var index = 0; index < 3; index++)
                {
                    await context.Response.WriteAsync($"data: {name}-{index}\n\n");
                    await context.Response.Body.FlushAsync();
                    await Task.Delay(300);
                }
            }
        );
        app.MapGet("/big", () => new string('x', 100_000));
        app.MapGet(
            "/slow",
            async (HttpContext context) =>
            {
                tenant!.SlowStarted.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.Infinite, context.RequestAborted);
                }
                catch (OperationCanceledException)
                {
                    tenant.Aborted.TrySetResult();
                }
            }
        );
        app.Map(
            "/ws",
            async (HttpContext context) =>
            {
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    context.Response.StatusCode = 400;
                    return;
                }
                using var socket = await context.WebSockets.AcceptWebSocketAsync();
                var buffer = new byte[1024];
                while (true)
                {
                    var received = await socket.ReceiveAsync(buffer, CancellationToken.None);
                    if (received.MessageType == WebSocketMessageType.Close)
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, name + " closes", CancellationToken.None);
                        return;
                    }
                    await socket.SendAsync(
                        Encoding.UTF8.GetBytes(name + ":" + Encoding.UTF8.GetString(buffer, 0, received.Count)),
                        WebSocketMessageType.Text,
                        true,
                        CancellationToken.None
                    );
                }
            }
        );
        tenant = new Tenant { App = app, Server = server };
        await app.StartAsync();
        return tenant;
    }

    [Fact]
    public async Task EachTenantRequestRunsInTheTenantsOwnContextBehindTheFrontsRouting()
    {
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await StartTenantAsync(front, "alpha");
        await using var beta = await StartTenantAsync(front, "beta");
        using var alphaClient = front.Client("alpha.test");
        using var betaClient = front.Client("beta.test");
        // The tenant's scoped service and its own endpoint, not the front's fallback, and no
        // items of the front's context; the front isn't re-entered.
        Assert.Equal("alpha HTTP: GET /who 0", await alphaClient.GetStringAsync("who"));
        Assert.Equal("beta HTTP: GET /who 0", await betaClient.GetStringAsync("who"));
        Assert.Equal("front", await alphaClient.GetStringAsync("front/marker"));
        // A tenant route the tenant lacks is the tenant's 404.
        Assert.Equal(HttpStatusCode.NotFound, (await alphaClient.GetAsync("none")).StatusCode);
        // An unknown host is refused at the front.
        using var unknown = front.Client("gamma.test");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await unknown.GetAsync("who")).StatusCode);
        // The tenant host has the replica-controlled lifetime, not the console's.
        Assert.IsType<HostControlledLifetime>(alpha.App.Services.GetRequiredService<IHostLifetime>());
    }

    [Fact]
    public async Task BodiesStreamsCompressionAndUpgradesUseTheFrontsTransport()
    {
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await StartTenantAsync(front, "alpha");
        using var client = front.Client("alpha.test");
        var large = new ByteArrayContent(new byte[3 * 1024 * 1024]);
        // The front's request size limit holds: a body declared over it is refused with 413
        // before any of it is read, and the connection closes. A client that streams the body
        // without waiting may see the close (a broken pipe) instead of the response, so this
        // exchange sends only the headers, as a client waiting on 100-continue does.
        Assert.StartsWith("HTTP/1.1 413 ", await HeadersOnlyAsync(front.BaseUri, "alpha.test", "/small", 3 * 1024 * 1024));
        // A tenant route can raise the limit.
        Assert.Equal((3 * 1024 * 1024).ToString(), await (await client.PostAsync("upload", large)).Content.ReadAsStringAsync());

        // Server-sent events arrive as written, not at the end of the response.
        using var events = await client.GetAsync("events", HttpCompletionOption.ResponseHeadersRead);
        await using var stream = await events.Content.ReadAsStreamAsync();
        using var reader = new StreamReader(stream);
        var started = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal("data: alpha-0", await reader.ReadLineAsync());
        Assert.InRange(started.ElapsedMilliseconds, 0, 250);

        // The tenant's response compression.
        using var compressed = new HttpRequestMessage(HttpMethod.Get, "big");
        compressed.Headers.AcceptEncoding.Add(new StringWithQualityHeaderValue("gzip"));
        var big = await client.SendAsync(compressed);
        Assert.Equal("gzip", Assert.Single(big.Content.Headers.ContentEncoding));
        Assert.InRange((await big.Content.ReadAsByteArrayAsync()).Length, 1, 10_000);

        // A WebSocket upgrade through the front, closed by the tenant with its status and reason.
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Host", "alpha.test");
        await socket.ConnectAsync(new UriBuilder(front.BaseUri) { Scheme = "ws", Path = "ws" }.Uri, CancellationToken.None);
        await socket.SendAsync(Encoding.UTF8.GetBytes("ping"), WebSocketMessageType.Text, true, CancellationToken.None);
        var buffer = new byte[1024];
        var echo = await socket.ReceiveAsync(buffer, CancellationToken.None);
        Assert.Equal("alpha:ping", Encoding.UTF8.GetString(buffer, 0, echo.Count));
        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
        var closing = await socket.ReceiveAsync(buffer, CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Close, closing.MessageType);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, socket.CloseStatus);
        Assert.Equal("alpha closes", socket.CloseStatusDescription);
    }

    [Fact]
    public async Task AClientThatGoesAwayAbortsTheTenantRequest()
    {
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await StartTenantAsync(front, "alpha");
        using var client = front.Client("alpha.test");
        using var cancel = new CancellationTokenSource();
        var request = client.GetAsync("slow", cancel.Token);
        await alpha.SlowStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        await alpha.Aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task StoppingATenantRefusesNewRequestsAndAbortsTheRestAfterItsShutdownTimeout()
    {
        await using var front = await TenantFront.StartAsync();
        await using var alpha = await StartTenantAsync(front, "alpha", shutdown: TimeSpan.FromMilliseconds(500));
        await using var beta = await StartTenantAsync(front, "beta");
        using var client = front.Client("alpha.test");
        using var betaClient = front.Client("beta.test");
        var slow = client.GetAsync("slow");
        await alpha.SlowStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stopping = System.Diagnostics.Stopwatch.StartNew();
        var stop = alpha.App.StopAsync();
        // New requests are refused before dispatch while the stop waits.
        await WaitUntilAsync(() => !alpha.Server.Serving);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.GetAsync("who")).StatusCode);
        await stop.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.InRange(stopping.ElapsedMilliseconds, 400, 5000);
        // The request still running at the timeout is aborted; the other tenant keeps serving.
        await alpha.Aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAnyAsync<HttpRequestException>(() => slow);
        Assert.Equal("beta HTTP: GET /who 0", await betaClient.GetStringAsync("who"));
    }

    // Sends a request's headers with Expect: 100-continue and no body; returns the response head.
    private static async Task<string> HeadersOnlyAsync(Uri baseUri, string host, string path, long length)
    {
        using var connection = new System.Net.Sockets.TcpClient();
        await connection.ConnectAsync(baseUri.Host, baseUri.Port);
        var stream = connection.GetStream();
        var request = $"POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {length}\r\nExpect: 100-continue\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(request));
        using var reader = new StreamReader(stream, Encoding.ASCII);
        var head = new StringBuilder();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await reader.ReadLineAsync(timeout.Token) is { Length: > 0 } line)
            head.Append(line).Append('\n');
        return head.ToString();
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException();
            await Task.Delay(20);
        }
    }
}
