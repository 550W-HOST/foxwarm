using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// An HTTP proxy in front of the S3 fixture that plays an endpoint without conditional writes.
/// Requests pass unchanged, signatures included. A <c>PUT</c> with <c>If-None-Match</c> that the
/// upstream refuses with 412 is answered 200 (<see cref="ConditionalMode.Ignore"/>: the header
/// had no effect), or every such <c>PUT</c> is answered 501 without reaching the upstream
/// (<see cref="ConditionalMode.Reject"/>), or every such <c>PUT</c> has its connection aborted
/// without reaching the upstream (<see cref="ConditionalMode.Reset"/>: a transport failure).
/// Counts the conditional <c>PUT</c>s it sees.
/// </summary>
internal sealed class S3ConditionalProxy : IAsyncDisposable
{
    internal enum ConditionalMode
    {
        Ignore,
        Reject,
        Reset,
    }

    private static readonly HashSet<string> HopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Host",
        "Connection",
        "Transfer-Encoding",
        "Keep-Alive",
        "Expect",
    };

    private readonly WebApplication app;
    private readonly HttpClient upstream;
    private readonly Uri target;
    private readonly ConditionalMode mode;
    private int conditionalPuts;

    private S3ConditionalProxy(WebApplication app, Uri target, ConditionalMode mode)
    {
        this.app = app;
        this.target = target;
        this.mode = mode;
        upstream = new HttpClient(new SocketsHttpHandler { UseProxy = false, AllowAutoRedirect = false });
    }

    internal Uri Endpoint { get; private set; } = null!;

    internal int ConditionalPuts => Volatile.Read(ref conditionalPuts);

    internal static async Task<S3ConditionalProxy> StartAsync(Uri target, ConditionalMode mode)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var proxy = new S3ConditionalProxy(builder.Build(), target, mode);
        proxy.app.Run(proxy.ForwardAsync);
        await proxy.app.StartAsync();
        proxy.Endpoint = new Uri(proxy.app.Urls.Single() + "/");
        return proxy;
    }

    private async Task ForwardAsync(HttpContext context)
    {
        var request = context.Request;
        var conditional = request.Method == "PUT" && request.Headers.ContainsKey("If-None-Match");
        if (conditional)
            Interlocked.Increment(ref conditionalPuts);
        if (conditional && mode == ConditionalMode.Reset)
        {
            context.Abort();
            return;
        }
        if (conditional && mode == ConditionalMode.Reject)
        {
            await DrainAsync(request);
            context.Response.StatusCode = (int)HttpStatusCode.NotImplemented;
            context.Response.ContentType = "application/xml";
            await context.Response.WriteAsync(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>NotImplemented</Code>"
                    + "<Message>A header you provided implies functionality that is not implemented.</Message></Error>"
            );
            return;
        }
        var raw = context.Features.Get<IHttpRequestFeature>()!.RawTarget;
        using var forward = new HttpRequestMessage(new HttpMethod(request.Method), new Uri(target, raw));
        // The client signed the host it addressed; keep it.
        forward.Headers.Host = request.Host.Value;
        // Content headers are signed even without a body.
        if (
            request.ContentLength is not null
            || request.Headers.ContainsKey("Transfer-Encoding")
            || request.Headers.ContentType.Count > 0
        )
            forward.Content = new StreamContent(request.Body);
        foreach (var (name, values) in request.Headers)
        {
            if (HopHeaders.Contains(name))
                continue;
            if (!forward.Headers.TryAddWithoutValidation(name, (IEnumerable<string>)values))
                forward.Content?.Headers.TryAddWithoutValidation(name, (IEnumerable<string>)values);
        }
        using var response = await upstream.SendAsync(
            forward,
            HttpCompletionOption.ResponseHeadersRead,
            context.RequestAborted
        );
        if (conditional && response.StatusCode == HttpStatusCode.PreconditionFailed)
        {
            // An endpoint that ignores the header accepts the write.
            context.Response.StatusCode = (int)HttpStatusCode.OK;
            context.Response.Headers.ETag = "\"" + new string('0', 32) + "\"";
            return;
        }
        context.Response.StatusCode = (int)response.StatusCode;
        foreach (var (name, values) in response.Headers.Concat(response.Content.Headers))
            if (!HopHeaders.Contains(name))
                context.Response.Headers[name] = values.ToArray();
        await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
    }

    private static async Task DrainAsync(HttpRequest request)
    {
        var buffer = new byte[65536];
        while (await request.Body.ReadAsync(buffer) > 0) { }
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
        upstream.Dispose();
    }
}
