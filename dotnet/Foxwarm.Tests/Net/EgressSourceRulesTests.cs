using System.Text.RegularExpressions;

namespace Foxwarm.Tests.Net;

/// <summary>
/// Keeps outbound connections of the Main server inside <c>EgressHttp</c>: no other file
/// constructs an HTTP client, a socket handler or a WebSocket client, or connects a WebSocket
/// itself. The factory applies the runtime's egress policy; a client built anywhere else would
/// reach internal destinations from a hosted tenant. HTTP/3 is refused too, because QUIC
/// connections don't pass the factory's connect callback.
/// </summary>
public sealed partial class EgressSourceRulesTests
{
    // The factory itself.
    private static readonly string[] Owners = ["Net/EgressHttp.cs", "Net/EgressPolicy.cs"];

    // Sockets that aren't tenant egress: the P1 standby forwards the public listener to the
    // owner replica (track FW replaces it).
    private static readonly string[] SocketOwners = ["Hosted/StandbyForwarder.cs"];

    [GeneratedRegex(
        @"\bnew\s+(?:System\.Net\.Http\.)?(?:HttpClient|SocketsHttpHandler|HttpClientHandler|ClientWebSocket)\b|\b(?:HttpClient|SocketsHttpHandler|HttpClientHandler|ClientWebSocket)\??\s+\w+\s*=\s*new\s*\(|\bHttpClientHandler\b|\bSocketsHttpHandler\b|\bVersion30\b|\bRequestVersionOrHigher\b|\bProviderHttpRequest\.CreateClient\(\s*\)"
    )]
    private static partial Regex ClientConstruction();

    [GeneratedRegex(@"\bnew\s+(?:System\.Net\.Sockets\.)?(?:Socket|TcpClient)\s*\(")]
    private static partial Regex RawSocket();

    [GeneratedRegex(@"\bClientWebSocket\b|EgressHttp\.WebSocket\(")]
    private static partial Regex WebSocketUse();

    [GeneratedRegex(@"\.ConnectAsync\(")]
    private static partial Regex DirectConnect();

    internal static IEnumerable<string> Violations(string relative, string source)
    {
        if (Owners.Contains(relative))
            yield break;
        // Comment lines may name the types.
        var lines = source
            .Split('\n')
            .Select((line, index) => (Text: line, Number: index + 1))
            .Where(line => !line.Text.TrimStart().StartsWith("//", StringComparison.Ordinal))
            .ToArray();
        var webSockets = lines.Any(line => WebSocketUse().IsMatch(line.Text));
        foreach (var (text, number) in lines)
        {
            foreach (Match match in ClientConstruction().Matches(text))
                yield return $"{relative}:{number}: {match.Value.Trim()}";
            if (!SocketOwners.Contains(relative))
                foreach (Match match in RawSocket().Matches(text))
                    yield return $"{relative}:{number}: {match.Value.Trim()}";
            // A WebSocket connected without the factory skips the guarded invoker.
            if (webSockets)
                foreach (Match match in DirectConnect().Matches(text))
                    yield return $"{relative}:{number}: WebSocket {match.Value.Trim()}";
        }
    }

    [Fact]
    public void OnlyTheFactoryBuildsOutboundClients()
    {
        var root = Path.Combine(
            Environment.GetEnvironmentVariable("FOXWARM_REPO_ROOT")
                ?? throw new InvalidOperationException("FOXWARM_REPO_ROOT is required."),
            "dotnet",
            "Foxwarm"
        );
        var violations = new List<string>();
        var scanned = 0;
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (
                relative.StartsWith("bin/", StringComparison.Ordinal)
                || relative.StartsWith("obj/", StringComparison.Ordinal)
            )
                continue;
            scanned++;
            violations.AddRange(Violations(relative, File.ReadAllText(file)));
        }
        Assert.True(scanned > 500, $"only {scanned} files scanned");
        Assert.Empty(violations);
    }

    [Theory]
    [InlineData("var client = new HttpClient();")]
    [InlineData("using var client = new HttpClient(handler) { Timeout = x };")]
    [InlineData("private static readonly HttpClient DefaultHttp = new() { Timeout = t };")]
    [InlineData("private readonly HttpClient? http = new(handler);")]
    [InlineData("var handler = new SocketsHttpHandler { UseProxy = false };")]
    [InlineData("HttpMessageHandler inner = new HttpClientHandler();")]
    [InlineData(": DelegatingHandler(new System.Net.Http.SocketsHttpHandler())")]
    [InlineData("internal readonly ClientWebSocket Socket = new();")]
    [InlineData("using var upstream = new ClientWebSocket();")]
    [InlineData("var socket = new Socket(family, SocketType.Stream, ProtocolType.Tcp);")]
    [InlineData("using var tcp = new TcpClient(\"10.0.0.1\", 5432);")]
    [InlineData("request.Version = HttpVersion.Version30;")]
    [InlineData("request.VersionPolicy = HttpVersionPolicy.RequestVersionOrHigher;")]
    [InlineData("var http = ProviderHttpRequest.CreateClient();")]
    public void TheRuleFindsEachKindOfConstruction(string line)
    {
        var source = "namespace Foxwarm;\nclass Sample\n{\n    void M()\n    {\n        " + line + "\n    }\n}\n";
        Assert.NotEmpty(Violations("Channels/Sample.cs", source));
        // The factory may.
        Assert.Empty(Violations("Net/EgressHttp.cs", source));
    }

    [Fact]
    public void TheRuleFindsAWebSocketConnectedOutsideTheFactory()
    {
        const string direct = """
            var socket = EgressHttp.WebSocket();
            await socket.ConnectAsync(uri, token);
            """;
        Assert.Single(Violations("Channels/Sample.cs", direct));
        const string guarded = """
            var socket = EgressHttp.WebSocket();
            await EgressHttp.ConnectWebSocketAsync(egress, EgressPurpose.Channel, socket, uri, null, token);
            """;
        Assert.Empty(Violations("Channels/Sample.cs", guarded));
        // Other ConnectAsync calls (pipes, MCP sessions) aren't WebSockets.
        Assert.Empty(Violations("Vector/VectorChild.cs", "await pipe.ConnectAsync(timeout.Token);"));
        // Comments and the egress-aware client calls pass.
        Assert.Empty(
            Violations(
                "Models/Sample.cs",
                "// new HttpClient() was here\nvar http = ProviderHttpRequest.CreateClient(egress);"
            )
        );
    }
}
