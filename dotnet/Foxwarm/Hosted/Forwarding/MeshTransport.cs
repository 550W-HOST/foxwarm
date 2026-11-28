using System.Net;
using Microsoft.AspNetCore.Http;
using Foxwarm.Net;
using Yarp.ReverseProxy.Forwarder;

namespace Foxwarm.Hosted.Forwarding;

internal enum DispatchOutcome { Completed, NotDispatched, Refused }

/// <summary>One connection pool for the boot. An internal transport resend carries the original nonce.</summary>
internal sealed class MeshTransport(MeshAuthentication authentication, HttpMessageInvoker client) : IDisposable
{
    internal static readonly TimeSpan KeepAlivePingDelay = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan KeepAlivePingTimeout = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan PhysicalWriteTimeout = TimeSpan.FromSeconds(20);
    private static readonly HttpRequestOptionsKey<AttemptBoundary> Boundary = new("Foxwarm.MeshAttempt");
    internal MeshTransport(MeshAuthentication authentication) : this(authentication, new HttpMessageInvoker(CreateHandler())) { }

    internal static SocketsHttpHandler CreateHandler()
    {
        // Only RouteDirectory/ReplicaRegistry supply destinations, never a caller's URL.
        var handler = (SocketsHttpHandler)EgressHttp.Handler(EgressPolicy.Unguarded, EgressPurpose.Deployment,
            new EgressHandlerOptions { UseProxy = false, AllowAutoRedirect = false, UseCookies = false });
        handler.AutomaticDecompression = DecompressionMethods.None;
        handler.ActivityHeadersPropagator = null;
        handler.EnableMultipleHttp2Connections = true;
        handler.KeepAlivePingDelay = KeepAlivePingDelay;
        handler.KeepAlivePingTimeout = KeepAlivePingTimeout;
        handler.KeepAlivePingPolicy = HttpKeepAlivePingPolicy.Always;
        handler.PlaintextStreamFilter = (connection, _) => new(new ConnectionWriter(connection.PlaintextStream));
        // SocketsHttpHandler encodes headers on the selected connection, after the pool wait
        // and connect. From this point bytes may be written; never infer non-dispatch after it.
        handler.RequestHeaderEncodingSelector = (_, message) =>
        {
            if (message.Options.TryGetValue(Boundary, out var attempt))
                attempt.StartWriting();
            return null;
        };
        return handler;
    }

    private sealed class ConnectionWriter(Stream stream) : MeshDuplexStream(stream)
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> bytes, CancellationToken token = default)
        {
            var writing = Inner.WriteAsync(bytes, token);
            return writing.IsCompleted ? writing : WaitForWriteAsync(writing);
        }

        private async ValueTask WaitForWriteAsync(ValueTask writing)
        {
            // Keepalive can fail streams already registered with HTTP/2, but not a HEADERS
            // entry waiting behind this write. Closing the socket wakes that queue as well.
            using var timeout = new Timer(static socket => ((Stream)socket!).Dispose(), Inner, PhysicalWriteTimeout, Timeout.InfiniteTimeSpan);
            await writing.ConfigureAwait(false);
        }
    }

    private static readonly ForwarderRequestConfig Config = new()
    {
        Version = HttpVersion.Version20,
        VersionPolicy = HttpVersionPolicy.RequestVersionExact,
        ActivityTimeout = TimeSpan.FromMinutes(10),
    };

    internal async Task ActivateAsync(string address, string candidate, string slug, string host, CancellationToken token)
    {
        const string path = "/";
        var (_, header) = authentication.Sign("activate", candidate, slug, null, "POST", host, path);
        using var request = new HttpRequestMessage(HttpMethod.Post, address + path)
        {
            Version = HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionExact,
        };
        request.Headers.Host = host;
        request.Headers.TryAddWithoutValidation(MeshAuthentication.Header, header);
        // No tenant request is sent on this instruction. Success, decline and a lost reply all
        // lead the edge back to the lease; the responding candidate never chooses the owner.
        using var response = await client.SendAsync(request, token).ConfigureAwait(false);
    }

    internal async Task<DispatchOutcome> DispatchAsync(HttpContext context, IHttpForwarder forwarder,
        DispatchRoute route, string slug, CancellationToken budget, Action endHold)
    {
        using var boundary = new AttemptBoundary(budget, context.RequestAborted, endHold);
        using var end = WebSocketEnd.Observe(context.Features, boundary.ClientEof);
        var transform = new MeshTransform(authentication, route, slug, boundary);
        var error = await forwarder.SendAsync(context, route.MeshAddress!, client, Config, transform, boundary.Token)
            .ConfigureAwait(false);
        if (transform.Refused && !context.Response.HasStarted)
        {
            context.Response.Clear();
            return DispatchOutcome.Refused;
        }
        if (error == ForwarderError.None || context.RequestAborted.IsCancellationRequested
            || transform.ResponseComplete && error is ForwarderError.RequestBodyCanceled or ForwarderError.RequestBodyClient or ForwarderError.RequestBodyDestination)
            return DispatchOutcome.Completed;
        if (context.Response.HasStarted)
        {
            // YARP has reset the request stream (or aborted an HTTP/1 connection). Do not
            // additionally abort the connection: other HTTP/2 streams may still be using it.
            return DispatchOutcome.Completed;
        }
        context.Response.Clear();
        if (!boundary.Writing && error is ForwarderError.Request or ForwarderError.RequestCanceled or ForwarderError.RequestTimedOut)
            return DispatchOutcome.NotDispatched;
        context.Response.StatusCode = StatusCodes.Status502BadGateway;
        await context.Response.WriteAsync("Upstream outcome unknown.", context.RequestAborted).ConfigureAwait(false);
        return DispatchOutcome.Completed;
    }

    public void Dispose() => client.Dispose();

    private sealed class AttemptBoundary : IDisposable
    {
        private readonly CancellationTokenSource sending;
        private readonly CancellationTokenRegistration deadline;
        private readonly Action endHold;
        private int writing;

        internal AttemptBoundary(CancellationToken budget, CancellationToken aborted, Action endHold)
        {
            sending = CancellationTokenSource.CreateLinkedTokenSource(aborted);
            deadline = budget.Register(() => sending.Cancel());
            this.endHold = endHold;
        }

        internal CancellationToken Token => sending.Token;
        internal bool Writing => Volatile.Read(ref writing) != 0;
        internal void StartWriting()
        {
            if (Writing) return;
            deadline.Dispose();
            Token.ThrowIfCancellationRequested();
            Volatile.Write(ref writing, 1);
        }
        internal void EndHold() => endHold();
        internal void ClientEof() => sending.CancelAfter(WebSocketEnd.CloseGrace);

        public void Dispose()
        {
            EndHold();
            deadline.Dispose();
            sending.Dispose();
        }
    }

    private sealed class MeshTransform(MeshAuthentication authentication, DispatchRoute route, string slug,
        AttemptBoundary boundary) : HttpTransformer
    {
        private MeshAttempt? attempt;
        internal bool Refused { get; private set; }
        internal bool ResponseComplete { get; private set; }

        public override async ValueTask TransformRequestAsync(HttpContext context, HttpRequestMessage message,
            string destinationPrefix, CancellationToken token)
        {
            await base.TransformRequestAsync(context, message, destinationPrefix, token).ConfigureAwait(false);
            var target = MeshAuthentication.RawTarget(context.Request);
            if (!target.StartsWith('/'))
                throw new InvalidDataException("Expected an origin-form mesh request target.");
            message.RequestUri = new Uri(destinationPrefix + target,
                new UriCreationOptions { DangerousDisablePathAndQueryCanonicalization = true });
            message.Headers.Host = context.Request.Host.Value;
            var signed = authentication.Sign("dispatch", route.Boot, slug, route.Epoch,
                message.Method.Method, message.Headers.Host, target);
            attempt = signed.Attempt;
            message.Headers.TryAddWithoutValidation(MeshAuthentication.Header, signed.Header);
            message.Options.Set(Boundary, boundary);
        }

        public override async ValueTask TransformResponseTrailersAsync(HttpContext context, HttpResponseMessage response,
            CancellationToken token)
        {
            await base.TransformResponseTrailersAsync(context, response, token).ConfigureAwait(false);
            // YARP invokes this only after copying the *entire* downstream response body.
            ResponseComplete = true;
        }

        public override async ValueTask<bool> TransformResponseAsync(HttpContext context, HttpResponseMessage? response,
            CancellationToken token)
        {
            if (response is not null) boundary.EndHold();
            if (response?.StatusCode == HttpStatusCode.MisdirectedRequest && attempt is not null
                && response.Headers.TryGetValues(MeshAuthentication.Refusal, out var values)
                && values.ToArray() is [var proof] && authentication.IsRefusal(attempt, proof))
            {
                Refused = true;
                return false;
            }
            if (response?.StatusCode == HttpStatusCode.Forbidden && response.Headers.Contains("Foxwarm-Mesh-Rejected"))
            {
                // It may be a repeated nonce that was accepted the first time. Never use this as retry evidence.
                context.Response.StatusCode = StatusCodes.Status502BadGateway;
                await context.Response.WriteAsync("Upstream outcome unknown.", token).ConfigureAwait(false);
                return false;
            }
            var copy = await base.TransformResponseAsync(context, response, token).ConfigureAwait(false);
            MeshAuthentication.StripControlHeaders(context.Response.Headers);
            return copy;
        }
    }
}
