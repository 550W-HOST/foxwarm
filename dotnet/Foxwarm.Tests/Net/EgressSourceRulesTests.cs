using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;

namespace Foxwarm.Tests.Net;

/// <summary>
/// Keeps outbound connections of the Main server inside <c>EgressHttp</c>. The rule reads the
/// compiled <c>Foxwarm</c> assembly's IL (<see cref="EgressIlScan"/>): no type but the
/// reviewed owners below constructs an HTTP client, a terminal handler, a WebSocket client, a
/// socket or a TLS stream, connects a WebSocket without the factory's invoker, gives the MCP
/// SDK a transport without the factory's client, or asks for HTTP/3 (QUIC connections don't
/// pass the factory's connect callback).
/// </summary>
public sealed class EgressSourceRulesTests
{
    // Each reviewed owner, with why it may.
    private static readonly Dictionary<string, string> Owners = new(StringComparer.Ordinal)
    {
        ["Foxwarm.Net.EgressHttp"] = "the factory",
        ["Foxwarm.Net.EgressPolicy"] = "the guarded connector's socket to a checked address",
        ["Foxwarm.Hosted.StandbyForwarder"] =
            "replica infrastructure: a standby forwards the public listener to the owner replica",
    };

    private static string Assembly(Type type) => type.Assembly.Location;

    [Fact]
    public void OnlyReviewedOwnersBuildOutboundConnections()
    {
        var hits = EgressIlScan.Scan(Assembly(typeof(Foxwarm.Net.EgressHttp)));
        var unexpected = hits.Where(hit => !Owners.ContainsKey(hit.Type)).Select(hit => hit.ToString()).ToArray();
        Assert.Empty(unexpected);
        // The scan sees the owners' own constructions, so it reads the right IL.
        Assert.Contains(hits, hit => hit.Type == "Foxwarm.Net.EgressHttp" && hit.Construct == "new System.Net.Http.SocketsHttpHandler");
        Assert.Contains(hits, hit => hit.Type == "Foxwarm.Net.EgressPolicy" && hit.Construct == "new System.Net.Sockets.Socket");
        // Every owner still needs its exception.
        Assert.All(Owners.Keys, owner => Assert.Contains(hits, hit => hit.Type == owner));
    }

    [Theory]
    [InlineData(nameof(ForbiddenIdioms.TargetTypedClient), "new System.Net.Http.HttpClient")]
    [InlineData(nameof(ForbiddenIdioms.ExpressionBodiedClient), "new System.Net.Http.HttpClient")]
    [InlineData(nameof(ForbiddenIdioms.ExpressionBodiedClient), "new System.Net.Http.HttpClientHandler")]
    [InlineData(nameof(ForbiddenIdioms.TargetTypedHandler), "new System.Net.Http.SocketsHttpHandler")]
    [InlineData(".ctor", "new System.Net.Http.HttpClient")]
    [InlineData(nameof(ForbiddenIdioms.OwnTerminalHandler), "new Foxwarm.Tests.Net.ForbiddenIdioms+Terminal")]
    [InlineData(nameof(ForbiddenIdioms.TargetTypedSocket), "new System.Net.Sockets.Socket")]
    [InlineData(nameof(ForbiddenIdioms.Tcp), "new System.Net.Sockets.TcpClient")]
    [InlineData(nameof(ForbiddenIdioms.Tls), "new System.Net.Security.SslStream")]
    [InlineData(nameof(ForbiddenIdioms.WebSocketClient), "new System.Net.WebSockets.ClientWebSocket")]
    [InlineData(nameof(ForbiddenIdioms.DirectWebSocketConnect), "ClientWebSocket.ConnectAsync without an invoker")]
    [InlineData(nameof(ForbiddenIdioms.Http3), "HttpVersion.Version30")]
    [InlineData(nameof(ForbiddenIdioms.ClientVersionPolicy), "HttpClient.DefaultVersionPolicy")]
    [InlineData(nameof(ForbiddenIdioms.SdkOwnedClient), "new ModelContextProtocol.Client.HttpClientTransport without a client")]
    public void TheRuleFindsEachIdiom(string method, string construct)
    {
        var hits = EgressIlScan.Scan(
            Assembly(typeof(ForbiddenIdioms)),
            type => type == typeof(ForbiddenIdioms).FullName
        );
        Assert.Contains(hits, hit => hit.Construct == construct && hit.Method.Contains(method, StringComparison.Ordinal));
    }

    [Fact]
    public void TheFactoryFormsPass()
    {
        var hits = EgressIlScan.Scan(
            Assembly(typeof(AllowedIdioms)),
            type => type == typeof(AllowedIdioms).FullName
        );
        Assert.Empty(hits);
    }
}

// Compiled, never run: the forms the rule must recognise, in the spellings this tree uses.
#pragma warning disable CA2000, CS1998
internal sealed class ForbiddenIdioms
{
    private readonly HttpClient field = new() { Timeout = TimeSpan.FromSeconds(1) };

    internal static HttpClient TargetTypedClient()
    {
        HttpClient client = new();
        return client;
    }

    internal static HttpClient ExpressionBodiedClient() => new(new HttpClientHandler { UseCookies = false });

    internal static HttpMessageHandler TargetTypedHandler()
    {
        SocketsHttpHandler handler = new() { UseProxy = false };
        return handler;
    }

    // The field initializer runs in the constructor.
    internal HttpClient Field() => field;

    internal sealed class Terminal : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) =>
            throw new NotSupportedException();
    }

    internal static HttpMessageHandler OwnTerminalHandler() => new Terminal();

    internal static Socket TargetTypedSocket()
    {
        Socket socket = new(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        return socket;
    }

    internal static TcpClient Tcp() => new("10.0.0.1", 5432);

    internal static System.Net.Security.SslStream Tls(Stream inner) => new(inner);

    internal static ClientWebSocket WebSocketClient() => new();

    internal static async Task DirectWebSocketConnect(ClientWebSocket socket, Uri uri) =>
        await socket.ConnectAsync(uri, CancellationToken.None);

    internal static void Http3(HttpRequestMessage request) => request.Version = HttpVersion.Version30;

    internal static void ClientVersionPolicy(HttpClient client) =>
        client.DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrHigher;

    internal static object SdkOwnedClient() =>
        new ModelContextProtocol.Client.HttpClientTransport(
            new ModelContextProtocol.Client.HttpClientTransportOptions { Endpoint = new Uri("http://x") }
        );
}

internal sealed class AllowedIdioms
{
    internal static HttpClient Client(Foxwarm.Net.EgressPolicy egress) =>
        Foxwarm.Net.EgressHttp.Client(egress, Foxwarm.Net.EgressPurpose.Model);

    internal static async Task Connect(Foxwarm.Net.EgressPolicy egress, Uri uri)
    {
        using var socket = Foxwarm.Net.EgressHttp.WebSocket();
        await Foxwarm.Net.EgressHttp.ConnectWebSocketAsync(
            egress,
            Foxwarm.Net.EgressPurpose.Channel,
            socket,
            uri,
            null,
            CancellationToken.None
        );
    }

    internal static async Task ConnectThrough(ClientWebSocket socket, Uri uri, HttpMessageInvoker invoker) =>
        await socket.ConnectAsync(uri, invoker, CancellationToken.None);

    internal static object SdkWithClient(HttpClient http) =>
        new ModelContextProtocol.Client.HttpClientTransport(
            new ModelContextProtocol.Client.HttpClientTransportOptions { Endpoint = new Uri("http://x") },
            http,
            ownsHttpClient: true
        );

    // Copying a request's own version (the OAuth retry) is no upgrade.
    internal static HttpRequestMessage Copy(HttpRequestMessage request) =>
        new(request.Method, request.RequestUri) { Version = request.Version, VersionPolicy = request.VersionPolicy };
}
#pragma warning restore CA2000, CS1998
