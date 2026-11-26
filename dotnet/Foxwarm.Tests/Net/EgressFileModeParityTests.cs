using System.Net.WebSockets;
using System.Reflection;
using Foxwarm.Channels;
using Foxwarm.Hosted;
using Foxwarm.Models;
using Foxwarm.Net;

namespace Foxwarm.Tests.Net;

/// <summary>
/// File mode keeps today's outbound behavior: for every call site moved onto
/// <see cref="EgressHttp"/>, the file-mode client is the handler type the site constructed
/// before, with every public setting equal to that construction's (redirects, cookies,
/// decompression, proxy, timeouts, pooling, HTTP version limits), and the same client timeout.
/// The "before" constructions below are copied from the sites as they were on the base.
/// </summary>
public sealed class EgressFileModeParityTests
{
    private static readonly EgressPolicy File = EgressPolicy.Unguarded;

    private static HttpMessageHandler HandlerOf(HttpMessageInvoker client) =>
        (HttpMessageHandler)
            typeof(HttpMessageInvoker)
                .GetField("_handler", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(client)!;

    private static HttpMessageHandler Leaf(HttpMessageHandler handler)
    {
        while (handler is DelegatingHandler delegating)
            handler = delegating.InnerHandler!;
        return handler;
    }

    // Every readable public setting of the leaf handler, by name.
    private static SortedDictionary<string, string> Settings(HttpMessageHandler handler)
    {
        var leaf = Leaf(handler);
        var settings = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["(type)"] = leaf.GetType().FullName!,
        };
        foreach (var property in leaf.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public))
        {
            if (property.GetIndexParameters().Length > 0)
                continue;
            string text;
            try
            {
                var value = property.GetValue(leaf);
                text = value switch
                {
                    null => "null",
                    bool or int or long or TimeSpan or Enum or Version or string => value.ToString()!,
                    Delegate => "delegate",
                    _ => "object " + value.GetType().Name,
                };
            }
            catch (TargetInvocationException error)
            {
                text = "throws " + error.InnerException!.GetType().Name;
            }
            settings[property.Name] = text;
        }
        return settings;
    }

    private static void Same(HttpMessageInvoker before, HttpMessageInvoker after)
    {
        Assert.Equal(Settings(HandlerOf(before)), Settings(HandlerOf(after)));
        if (before is HttpClient beforeClient && after is HttpClient afterClient)
            Assert.Equal(beforeClient.Timeout, afterClient.Timeout);
    }

    private static void Same(HttpMessageHandler before, HttpMessageHandler after) =>
        Assert.Equal(Settings(before), Settings(after));

    [Fact]
    public void ModelClientSetupProbesAndTheModelCli()
    {
        // SessionManager.http and CliCommands (`foxwarm model`).
        using var before = new HttpClient(
            new ProviderResponseDecodingHandler(new HttpClientHandler { UseCookies = false })
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        using var after = ProviderHttpRequest.CreateClient(File);
        Same(before, after);
        Assert.IsType<ProviderResponseDecodingHandler>(HandlerOf(after));
    }

    [Fact]
    public void ResponsesWebSocketHandshake()
    {
        var headers = new Dictionary<string, string> { ["x-test"] = "1" };
        using var before = new SocketsHttpHandler { UseCookies = false };
        using var after = WsHandshakeHeaders.Create(headers, File);
        Same(before, after);
    }

    [Fact]
    public void OutboundMcpWithoutOAuth()
    {
        using var before = new HttpClient(new HttpClientHandler())
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        DelegatingHandler? observed = null;
        using var after = McpClient.PlainHttp(
            File,
            inner => observed = new PassThrough(inner)
        );
        Same(before, after);
        Assert.Same(observed, HandlerOf(after));
    }

    [Fact]
    public void OutboundMcpResourceRequestsWithOAuth()
    {
        using var before = new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false };
        using var after = McpOAuthService.ResourceTransport(File);
        Same(before, after);
    }

    [Fact]
    public async Task OAuthDiscoveryAndTokens()
    {
        // The handler's settings are as before...
        using var before = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            ConnectTimeout = TimeSpan.FromSeconds(15),
            ConnectCallback = (_, _) => throw new NotSupportedException(),
        };
        await using var fixture = await EgressFixture.StartAsync();
        using var after = await McpOAuthHttp.PinnedClientAsync(
            new Uri($"http://127.0.0.1:{fixture.Port}/mcp"),
            new Uri($"http://127.0.0.1:{fixture.Port}/ok"),
            File,
            CancellationToken.None
        );
        Same(before, HandlerOf(after));
        Assert.Equal(Timeout.InfiniteTimeSpan, after.Timeout);
        // ...and the real caller connects through them.
        Assert.Equal("ok", await after.GetStringAsync($"http://127.0.0.1:{fixture.Port}/ok"));
    }

    [Fact]
    public async Task OAuthFileConnectKeepsEachAddressAndDefaultSocketOptions()
    {
        // As the base connected: a socket of the address's own family, to the address as
        // resolved, with default options. A guarded connect differs (mapped addresses as IPv4,
        // no Nagle), which is why file mode keeps its own.
        using var v4 = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        v4.Start();
        var port = ((System.Net.IPEndPoint)v4.LocalEndpoint).Port;
        await using (
            var stream = (System.Net.Sockets.NetworkStream)(
                await EgressHttp.FilePinnedConnectAsync([System.Net.IPAddress.Loopback], port, default)
            )!
        )
        {
            Assert.Equal(System.Net.Sockets.AddressFamily.InterNetwork, stream.Socket.AddressFamily);
            Assert.False(stream.Socket.NoDelay);
        }
        using var v6 = new System.Net.Sockets.TcpListener(System.Net.IPAddress.IPv6Loopback, 0);
        v6.Start();
        await using (
            var stream = (System.Net.Sockets.NetworkStream)(
                await EgressHttp.FilePinnedConnectAsync(
                    [System.Net.IPAddress.IPv6Loopback],
                    ((System.Net.IPEndPoint)v6.LocalEndpoint).Port,
                    default
                )
            )!
        )
        {
            Assert.Equal(System.Net.Sockets.AddressFamily.InterNetworkV6, stream.Socket.AddressFamily);
            Assert.False(stream.Socket.DualMode);
            Assert.False(stream.Socket.NoDelay);
        }
        // A mapped address stays IPv6 on an IPv6-only socket: it doesn't reach the IPv4
        // listener, as before; the next address does.
        var mapped = System.Net.IPAddress.Parse("::ffff:127.0.0.1");
        Assert.Null(await EgressHttp.FilePinnedConnectAsync([mapped], port, default));
        await using var next = await EgressHttp.FilePinnedConnectAsync(
            [mapped, System.Net.IPAddress.Loopback],
            port,
            default
        );
        Assert.NotNull(next);
        // The guarded connect normalizes the same mapped address and connects.
        await using var guarded = await EgressPolicy.Operator().ConnectAsync([mapped], port, default);
        Assert.Equal(
            System.Net.Sockets.AddressFamily.InterNetwork,
            ((System.Net.Sockets.NetworkStream)guarded).Socket.AddressFamily
        );
    }

    [Fact]
    public void AsrService()
    {
        using var before = new HttpClient(
            new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        // Its stream's supplied-invoker handshake runs through the real caller in
        // AsrRoutesTests.Stream (file mode).
        using var proxy = new Foxwarm.Asr.AsrProxy(null, CancellationToken.None, File);
        var after = (HttpClient)
            typeof(Foxwarm.Asr.AsrProxy)
                .GetField("http", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(proxy)!;
        Same(before, after);
    }

    [Fact]
    public void TelegramMatrixWeWorkAndWeixinShareOneDefaultClientPerType()
    {
        using var before = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        using var clients = new ChannelHttpClients(File);
        foreach (var type in new[] { "telegram", "matrix", "wework", "weixin" })
        {
            Same(before, clients.For(type));
            Assert.Same(clients.For(type), clients.For(type));
        }
        Assert.NotSame(clients.For("telegram"), clients.For("matrix"));
    }

    [Fact]
    public void QQBot()
    {
        // The adapter set the timeout to infinite right after construction, as it still does.
        using var before = new HttpClient(
            new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }
        );
        before.Timeout = Timeout.InfiniteTimeSpan;
        using var after = QQBotChannel.CreateHttp(File);
        after.Timeout = Timeout.InfiniteTimeSpan;
        Same(before, after);
    }

    [Fact]
    public void VectorEmbeddings()
    {
        using var before = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        using var after = Foxwarm.Vector.VectorRuntime.EmbeddingsClient();
        Same(before, after);
    }

    [Fact]
    public void HostedHealthProbe()
    {
        using var before = new HttpClient(new SocketsHttpHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(3),
        };
        using var after = HostedCli.HealthClient();
        Same(before, after);
    }

    [Fact]
    public async Task FileModeReachesInternalDestinations()
    {
        // QQ Bot's gateway and WeWork connect without an invoker: in file mode the factory calls
        // ClientWebSocket.ConnectAsync(uri, token) itself, so the socket builds its own handler
        // as before. Their real callers run in QQBotSocketLifetimeTests and
        // WeWorkBoundedSocketTests against loopback servers.
        await using var fixture = await EgressFixture.StartAsync();
        using var client = ProviderHttpRequest.CreateClient(File);
        Assert.Equal("ok", await client.GetStringAsync($"http://127.0.0.1:{fixture.Port}/ok"));
    }

    [Fact]
    public void GuardedHandlersKeepEachSiteOptions()
    {
        var hosted = EgressPolicy.Hosted();
        foreach (
            var (options, redirect, cookies) in new[]
            {
                (new EgressHandlerOptions(), true, true),
                (new EgressHandlerOptions { FileHandler = EgressFileHandler.Client }, true, true),
                (new EgressHandlerOptions { AllowAutoRedirect = false, UseCookies = false }, false, false),
                (new EgressHandlerOptions { UseCookies = false }, true, false),
            }
        )
        {
            using var handler = (SocketsHttpHandler)EgressHttp.Handler(hosted, EgressPurpose.Model, options);
            Assert.Equal(redirect, handler.AllowAutoRedirect);
            Assert.Equal(cookies, handler.UseCookies);
            Assert.False(handler.UseProxy);
        }
        using var pinned = (SocketsHttpHandler)EgressHttp.PinnedHandler(
            hosted,
            EgressPurpose.Mcp,
            "example.com",
            443,
            [System.Net.IPAddress.Parse("93.184.215.14")],
            () => new InvalidOperationException(),
            () => new InvalidOperationException(),
            new EgressHandlerOptions { ConnectTimeout = TimeSpan.FromSeconds(15) }
        );
        Assert.Equal(TimeSpan.FromSeconds(15), pinned.ConnectTimeout);
        Assert.False(pinned.UseProxy);
    }

    private sealed class PassThrough(HttpMessageHandler inner) : DelegatingHandler(inner);
}
