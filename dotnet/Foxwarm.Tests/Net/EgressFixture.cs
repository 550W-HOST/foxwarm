using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using Foxwarm.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests.Net;

/// <summary>
/// A local resolver and connector for the egress matrix. Names resolve to scripted address
/// sequences (one answer per lookup, the last repeated), so a name can answer public and then
/// private. "Public" addresses are documentation-free global addresses that the connector
/// carries to a loopback server, so a test sees an allowed public connection without leaving
/// the machine. Every lookup and every connect is recorded.
/// </summary>
internal sealed class EgressFixture : IAsyncDisposable
{
    internal static readonly IPAddress PublicV4 = IPAddress.Parse("93.184.215.14");
    internal static readonly IPAddress PublicV6 = IPAddress.Parse("2606:2800:21f:cb07:6820:80da:af6b:8b2c");

    private readonly ConcurrentDictionary<string, Queue<IPAddress[]>> names = new(
        StringComparer.OrdinalIgnoreCase
    );

    internal ConcurrentQueue<string> Lookups { get; } = new();
    internal ConcurrentQueue<IPEndPoint> Connects { get; } = new();
    internal WebApplication Server { get; }
    internal int Port { get; private set; }
    private int requests;

    /// <summary>Requests the server received, WebSocket upgrades included.</summary>
    internal int Requests => Volatile.Read(ref requests);

    private EgressFixture(WebApplication server) => Server = server;

    internal static async Task<EgressFixture> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        var fixture = new EgressFixture(app);
        app.Use(
            async (context, next) =>
            {
                Interlocked.Increment(ref fixture.requests);
                await next();
            }
        );
        app.UseWebSockets();
        app.MapGet("/ok", () => "ok");
        app.MapGet(
            "/redirect",
            (HttpContext context) =>
            {
                context.Response.StatusCode = 302;
                context.Response.Headers.Location = context.Request.Query["to"].ToString();
                return Task.CompletedTask;
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
                await socket.CloseAsync(
                    System.Net.WebSockets.WebSocketCloseStatus.NormalClosure,
                    "bye",
                    CancellationToken.None
                );
            }
        );
        await app.StartAsync();
        fixture.Port = new Uri(app.Urls.Single()).Port;
        return fixture;
    }

    /// <summary>The name answers each address set in turn; the last one repeats.</summary>
    internal void Name(string name, params IPAddress[][] answers) =>
        names[name] = new Queue<IPAddress[]>(answers);

    internal void Name(string name, IPAddress address) => Name(name, [address]);

    internal Task<IPAddress[]> ResolveAsync(string host, CancellationToken token)
    {
        Lookups.Enqueue(host);
        if (!names.TryGetValue(host, out var answers))
            throw new SocketException((int)SocketError.HostNotFound);
        lock (answers)
            return Task.FromResult(answers.Count > 1 ? answers.Dequeue() : answers.Peek());
    }

    internal async ValueTask<Stream> ConnectAsync(IPEndPoint endpoint, CancellationToken token)
    {
        Connects.Enqueue(endpoint);
        var target =
            endpoint.Address.Equals(PublicV4) || endpoint.Address.Equals(PublicV6)
                ? new IPEndPoint(IPAddress.Loopback, Port)
                : endpoint;
        var socket = new Socket(target.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
        {
            NoDelay = true,
        };
        try
        {
            await socket.ConnectAsync(target, token);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    internal EgressPolicy Hosted(EgressRules? rules = null) =>
        Wire(EgressPolicy.Hosted(rules));

    internal EgressPolicy Operator(EgressRules? rules = null) =>
        Wire(EgressPolicy.Operator(rules));

    private EgressPolicy Wire(EgressPolicy policy) =>
        // The fixture's resolver and connector replace the system ones.
        policy.WithTransport(ResolveAsync, ConnectAsync);

    public async ValueTask DisposeAsync() => await Server.DisposeAsync();
}
