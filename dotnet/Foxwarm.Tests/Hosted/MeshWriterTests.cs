using System.Net;
using Foxwarm.Hosted.Forwarding;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit;
using Yarp.ReverseProxy.Forwarder;

namespace Foxwarm.Tests.Hosted;

public sealed class MeshWriterTests
{
    private sealed class PublicConnect(Stream stream) : Microsoft.AspNetCore.Http.Features.IHttpExtendedConnectFeature
    {
        public bool IsExtendedConnect => true;
        public string Protocol => "websocket";
        public ValueTask<Stream> AcceptAsync() => new(stream);
    }

    private sealed class CleanClient(TaskCompletionSource eof) : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            eof.TrySetResult();
            return new(0);
        }
    }

    [Fact]
    public async Task CleanClientReadEndAllowsFinalReverseBytesAndTerminatesAtTheGraceBound()
    {
        var eof = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ended = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var owner = WebApplication.CreateSlimBuilder();
        owner.Logging.ClearProviders();
        owner.Services.AddHttpForwarder();
        owner.WebHost.UseKestrel(k => k.Listen(IPAddress.Loopback, 0, o => o.Protocols = HttpProtocols.Http2));
        await using var app = owner.Build();
        app.UseWebSockets();
        app.Run(async context =>
        {
            using var ws = await context.WebSockets.AcceptWebSocketAsync();
            await eof.Task.WaitAsync(context.RequestAborted);
            await ws.SendAsync("last"u8.ToArray(), System.Net.WebSockets.WebSocketMessageType.Text, true, context.RequestAborted);
            try { await ws.ReceiveAsync(new ArraySegment<byte>(new byte[16]), context.RequestAborted); }
            catch (Exception e) when (e is OperationCanceledException or System.Net.WebSockets.WebSocketException) { }
            finally { ended.TrySetResult(); }
        });
        await app.StartAsync();
        using var client = new CleanClient(eof);
        var context = new DefaultHttpContext();
        context.Request.Protocol = "HTTP/2";
        context.Request.Method = "CONNECT";
        context.Request.Scheme = "http";
        context.Request.Host = new("alpha.test");
        context.Request.Path = "/";
        context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpRequestFeature>()!.RawTarget = "/";
        context.Request.Headers.SecWebSocketVersion = "13";
        context.Features.Set<Microsoft.AspNetCore.Http.Features.IHttpExtendedConnectFeature>(new PublicConnect(client));
        using var mesh = new MeshTransport(new MeshAuthentication(new byte[32], "edge"));
        using var cleanup = new CancellationTokenSource(WebSocketEnd.CloseGrace + TimeSpan.FromSeconds(4));
        context.RequestAborted = cleanup.Token;
        await mesh.DispatchAsync(context, app.Services.GetRequiredService<IHttpForwarder>(), new("owner", 1, app.Urls.Single()), new("alpha", 42), default, () => { });
        Assert.False(cleanup.IsCancellationRequested);
        await ended.Task.WaitAsync(cleanup.Token);
        Assert.Equal(new byte[] { 0x81, 4, 108, 97, 115, 116 }, client.ToArray());
    }

    [Fact]
    public async Task BudgetExpiredAtFirstEncodingIsKnownNonDispatch()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(k => k.Listen(IPAddress.Loopback, 0, o => o.Protocols = HttpProtocols.Http2));
        builder.Services.AddHttpForwarder();
        await using var app = builder.Build();
        int received = 0;
        app.Run(_ => { Interlocked.Increment(ref received); return Task.CompletedTask; });
        await app.StartAsync();
        using var budget = new CancellationTokenSource();
        var handler = MeshTransport.CreateHandler();
        var encode = handler.RequestHeaderEncodingSelector!;
        handler.RequestHeaderEncodingSelector = (name, msg) => { budget.Cancel(); return encode(name, msg); };
        using var mesh = new MeshTransport(new MeshAuthentication(new byte[32], "edge"), new HttpMessageInvoker(handler));
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Protocol = "HTTP/1.1";
        context.Request.Host = new("alpha.test");
        context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpRequestFeature>()!.RawTarget = "/";
        var result = await mesh.DispatchAsync(context, app.Services.GetRequiredService<IHttpForwarder>(), new("owner", 1, app.Urls.Single()), new("alpha", 42), budget.Token, () => { });
        Assert.True(budget.IsCancellationRequested);
        Assert.Equal(DispatchOutcome.NotDispatched, result);
        Assert.Equal(0, received);
    }

    // Fault-injected loopback stream. Pause its writes only after HTTP/2 setup and a round trip.
    private sealed class Paused(Stream stream, Func<bool> pause, TaskCompletionSource entered, Task release) : Stream
    {
        private readonly CancellationTokenSource closed = new();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default)
        {
            if (pause())
            {
                entered.TrySetResult();
                using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token, closed.Token);
                await release.WaitAsync(lifetime.Token);
            }
            await stream.WriteAsync(buffer, token);
        }
        public override Task WriteAsync(byte[] b, int off, int count, CancellationToken token) => WriteAsync(b.AsMemory(off, count), token).AsTask();
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => stream.Flush();
        public override Task FlushAsync(CancellationToken token) => stream.FlushAsync(token);
        public override int Read(byte[] b, int o, int c) => stream.Read(b, o, c);
        public override ValueTask<int> ReadAsync(Memory<byte> b, CancellationToken token = default) => stream.ReadAsync(b, token);
        public override void Write(byte[] b, int o, int c) => stream.Write(b, o, c);
        public override long Seek(long o, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) { closed.Cancel(); stream.Dispose(); } base.Dispose(disposing); }
    }

    private sealed class EarlyResponse(TaskCompletionSource finished, System.Net.HttpStatusCode status) : HttpMessageHandler
    {
        internal Task? Upload;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Upload = request.Content!.CopyToAsync(Stream.Null, token);
            var response = new HttpResponseMessage(status) { Content = new BodyCompletion(finished), Version = HttpVersion.Version20 };
            response.Headers.TryAddWithoutValidation("X-Owner-Decision", "closed");
            return Task.FromResult(response);
        }
    }

    private sealed class BodyCompletion(TaskCompletionSource finished) : ByteArrayContent([])
    {
        protected override Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken) =>
            Task.FromResult<Stream>(new EndOfResponse(finished));
    }

    private sealed class EndOfResponse(TaskCompletionSource finished) : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> bytes, CancellationToken token = default)
        {
            finished.TrySetResult();
            return new(0);
        }
    }

    private sealed class IncompleteUpload(Task wait) : MemoryStream
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> bytes, CancellationToken token = default)
        {
            await wait.WaitAsync(token);
            throw new IOException("Upload source stopped after the response ended.");
        }
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.Conflict)]
    public async Task CompletedEarlyOwnerResponseSurvivesASubsequentUploadFailure(HttpStatusCode status)
    {
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new EarlyResponse(finished, status);
        using var mesh = new MeshTransport(new MeshAuthentication(new byte[32], "edge"), new HttpMessageInvoker(handler));
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.Services.AddHttpForwarder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var front = builder.Build();
        front.Run(async context =>
        {
            context.Request.Body = new IncompleteUpload(finished.Task);
            await mesh.DispatchAsync(context, front.Services.GetRequiredService<IHttpForwarder>(), new("owner", 1, "http://owner"),
                new("alpha", 42), context.RequestAborted, () => { });
        });
        await front.StartAsync();
        using var http = new HttpClient(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(8) };
        using var result = await http.PutAsync(front.Urls.Single(), new ByteArrayContent([1, 2, 3]));
        Assert.True(finished.Task.IsCompleted);
        Assert.Equal(status, result.StatusCode);
        Assert.Equal("closed", Assert.Single(result.Headers.GetValues("X-Owner-Decision")));
        Assert.Empty(await result.Content.ReadAsByteArrayAsync());
        if (handler.Upload is { } copy) { try { await copy; } catch (HttpRequestException) { } }
    }

    [Fact]
    public async Task EncodedAttemptsKeepTheirPermitUntilAStalledConnectionFails()
    {
        var owner = WebApplication.CreateSlimBuilder();
        owner.Logging.ClearProviders();
        owner.WebHost.UseKestrel(k => k.Listen(IPAddress.Loopback, 0, o => o.Protocols = HttpProtocols.Http2));
        await using var app = owner.Build();
        app.Run(c => c.Response.WriteAsync("ok"));
        await app.StartAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int stall = 0;
        var handler = MeshTransport.CreateHandler();
        int connections = 0;
        handler.ConnectCallback = async (context, token) =>
        {
            Interlocked.Increment(ref connections);
            var socket = new System.Net.Sockets.Socket(System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
            try { await socket.ConnectAsync(context.DnsEndPoint, token); }
            catch { socket.Dispose(); throw; }
            return new Paused(new System.Net.Sockets.NetworkStream(socket, ownsSocket: true),
                () => Volatile.Read(ref stall) != 0, entered, release.Task);
        };
        var encoding = handler.RequestHeaderEncodingSelector!;
        var queued = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        handler.RequestHeaderEncodingSelector = (name, request) =>
        {
            var selected = encoding(name, request);
            if (request.RequestUri?.AbsolutePath == "/queued") queued.TrySetResult();
            return selected;
        };
        var invoker = new HttpMessageInvoker(handler);
        using var mesh = new MeshTransport(new MeshAuthentication(new byte[32], "edge"), invoker);
        var address = app.Urls.Single();
        using var warm = new HttpRequestMessage(HttpMethod.Get, address) { Version = HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionExact };
        using (var warmed = await invoker.SendAsync(warm, default)) Assert.Equal("ok", await warmed.Content.ReadAsStringAsync());
        var front = WebApplication.CreateSlimBuilder();
        front.Logging.ClearProviders();
        front.Services.AddHttpForwarder();
        front.WebHost.UseUrls("http://127.0.0.1:0");
        await using var edge = front.Build();
        var permits = 0;
        edge.Run(async context =>
        {
            var held = 1;
            Interlocked.Increment(ref permits);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await mesh.DispatchAsync(context, edge.Services.GetRequiredService<IHttpForwarder>(), new("owner", 1, address), new("alpha", 42),
                deadline.Token, () => { if (Interlocked.Exchange(ref held, 0) == 1) Interlocked.Decrement(ref permits); });
        });
        await edge.StartAsync();
        using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false });
        try
        {
            Volatile.Write(ref stall, 1);
            var attempt = client.GetAsync(edge.Urls.Single());
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(4));
            var second = client.GetAsync(edge.Urls.Single() + "/queued");
            await queued.Task.WaitAsync(TimeSpan.FromSeconds(4));
            Assert.Equal(2, Volatile.Read(ref permits));
            using var response = await attempt.WaitAsync(MeshTransport.KeepAlivePingDelay + MeshTransport.KeepAlivePingTimeout + TimeSpan.FromSeconds(6));
            Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
            using var queuedResponse = await second.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(HttpStatusCode.BadGateway, queuedResponse.StatusCode);
            Assert.Equal(0, Volatile.Read(ref permits));
            Assert.Equal(1, connections);
        }
        finally { release.TrySetResult(); }
    }
}
