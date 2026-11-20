using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    // A loopback bot.httpHost is the only listener, and Main's own address follows it when no
    // public url is configured.
    [Theory]
    [InlineData("127.0.0.1", "127.0.0.1")]
    [InlineData("'::1'", "[::1]")]
    public async Task Configured_listen_address_is_the_only_listener_and_Main_address(
        string yaml,
        string host
    )
    {
        if (host == "[::1]" && !CanListen(IPAddress.IPv6Loopback))
            return;
        await using var h = new Host(codeAssets: true);
        var assets = Path.Combine(h.Installation, "packages/vscode-web/assets/vscode-web");
        foreach (
            var file in new[]
            {
                "out/nls.messages.js",
                "out/vs/workbench/workbench.web.main.internal.css",
                "out/vs/workbench/workbench.web.main.internal.js",
            }
        )
        {
            var path = Path.Combine(assets, file);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, "metadata fixture");
        }
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(
            h.ConfigPath,
            $"bot:\n  httpPort: {h.Port}\n  httpHost: {yaml}\nvector: false\n"
        );
        var origin = $"http://{host}:{h.Port}";
        h.ListenHost = host;
        h.Client.Dispose();
        // The test environment's closed proxy exempts 127.0.0.1 but not every IPv6 spelling.
        h.Client = new HttpClient(new HttpClientHandler { UseCookies = false, UseProxy = false })
        {
            BaseAddress = new Uri(origin),
            Timeout = TimeSpan.FromSeconds(20),
        };
        h.Start();
        await h.Ready();
        // Main's own address, as published to the Code workbench.
        var html = await h.Client.GetStringAsync("/vscode-web/");
        var match = System.Text.RegularExpressions.Regex.Match(html, "data-settings=\"([^\"]+)\"");
        var bootstrap = JsonNode.Parse(WebUtility.HtmlDecode(match.Groups[1].Value))!;
        Assert.Equal(
            origin + "/vscode-web/static",
            bootstrap["productConfiguration"]!["webEndpointUrlTemplate"]!.GetValue<string>()
        );
        // Node bootstrap without a configured url suggests the address the browser used.
        var commands = await h.Client.PostAsJsonAsync(
            "/api/nodes/onboarding/commands",
            new { fallbackUrl = origin }
        );
        Assert.Equal(HttpStatusCode.OK, commands.StatusCode);
        Assert.Equal(
            origin,
            (await commands.Content.ReadFromJsonAsync<JsonObject>())!["baseUrl"]!.GetValue<string>()
        );
        // The wildcard default would also accept connections on the other loopback family.
        var other = host == "[::1]" ? IPAddress.Loopback : IPAddress.IPv6Loopback;
        if (CanListen(other))
        {
            using var client = new TcpClient(other.AddressFamily);
            await Assert.ThrowsAnyAsync<SocketException>(() =>
                client.ConnectAsync(other, h.Port)
            );
        }
        await h.Stop();
    }

    private static bool CanListen(IPAddress address)
    {
        try
        {
            var listener = new TcpListener(address, 0);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
