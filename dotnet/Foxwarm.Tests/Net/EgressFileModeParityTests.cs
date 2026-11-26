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
        using var tests = ProviderHttpRequest.CreateClient();
        Same(before, tests);
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
        using var before = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            ConnectTimeout = TimeSpan.FromSeconds(15),
            ConnectCallback = (_, _) => throw new NotSupportedException(),
        };
        using var after = await McpOAuthHttp.PinnedClientAsync(
            new Uri("https://127.0.0.1/mcp"),
            new Uri("https://127.0.0.1/token"),
            File,
            CancellationToken.None
        );
        Same(before, HandlerOf(after));
        Assert.Equal(Timeout.InfiniteTimeSpan, after.Timeout);
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
        using var proxy = new Foxwarm.Asr.AsrProxy(null, CancellationToken.None);
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
    public async Task WebSocketsWithoutAnInvokerConnectAsBefore()
    {
        // QQ Bot's gateway and WeWork connect without an invoker: in file mode the factory calls
        // ClientWebSocket.ConnectAsync(uri, token) itself, so the socket builds its own handler
        // with its own options (proxy and all) exactly as before, internal addresses included.
        await using var fixture = await EgressFixture.StartAsync();
        using var socket = EgressHttp.WebSocket();
        await EgressHttp.ConnectWebSocketAsync(
            File,
            EgressPurpose.Channel,
            socket,
            new Uri($"ws://127.0.0.1:{fixture.Port}/ws"),
            null,
            CancellationToken.None
        );
        var frame = await socket.ReceiveAsync(new byte[16], CancellationToken.None);
        Assert.Equal(WebSocketMessageType.Close, frame.MessageType);
        // File-mode HTTP reaches internal destinations too.
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
