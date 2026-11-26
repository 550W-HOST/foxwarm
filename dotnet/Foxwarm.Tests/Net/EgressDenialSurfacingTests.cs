using System.Net.Http;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Net;

namespace Foxwarm.Tests.Net;

// Callers whose errors already carry an inner reason show the egress denial, so a blocked
// address isn't mistaken for a network failure.
public sealed class EgressDenialSurfacingTests
{
    private static readonly string Copy = EgressDeniedException.Copy("127.0.0.1");

    [Theory]
    [InlineData("streamable-http")]
    [InlineData("sse")]
    public async Task AnOutboundMcpConnectionNamesTheDenial(string transport)
    {
        await using var peer = await EgressFixture.StartAsync();
        // File mode's features with the hosted egress guard.
        await using var f = await OutboundMcpFixture.CreateAsync(
            capabilities: RuntimeCapabilities.File with { Egress = EgressPolicy.Hosted() }
        );
        try
        {
            await f.ConfigureAsync($"http://127.0.0.1:{peer.Port}/mcp", transport);
        }
        catch (Exception error)
        {
            // A configuration that probes the server reports the same reason.
            Assert.Contains(Copy, error.Message);
        }
        var listed = await Assert.ThrowsAnyAsync<Exception>(() =>
            f.Mcp.ListToolsAsync("peer", default, f.First, f.First.McpGeneration)
        );
        Assert.Contains(Copy, listed.Message);
        Assert.Equal(0, peer.Requests);
    }

    [Fact]
    public void AChannelStatusNamesTheDenial()
    {
        var denied = new HttpRequestException(
            "connect",
            new EgressDeniedException("127.0.0.1", System.Net.IPAddress.Loopback)
        );
        Assert.Equal(
            "Channel start failed: " + Copy,
            ChannelFailure.Describe(new ChannelFailure("Channel start", denied))
        );
    }

    [Fact]
    public void OAuthErrorsNameTheDenial()
    {
        var denied = new HttpRequestException(
            "connect",
            new EgressDeniedException("127.0.0.1", System.Net.IPAddress.Loopback)
        );
        Assert.Contains(Copy, McpOAuthService.SafeError(denied).Message);
    }
}
