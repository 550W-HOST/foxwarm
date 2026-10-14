using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class McpOAuthTests
{
    [Fact]
    public async Task Consent_started_before_a_completed_rotation_preserves_the_current_live_tokens()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        await peer.AuthorizeAsync(f.Mcp);
        var original = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        await peer.GateAsync("metadata");
        var consent = f.Mcp.OAuth.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default);
        await peer.WaitAsync("metadataEntered");
        await peer.SetAsync(new() { ["force401"] = 1 });
        var renewed = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        Assert.Equal(original["context"]!.GetValue<int>(), renewed["context"]!.GetValue<int>());
        var file = Path.Combine(f.Data, "state", "mcp-oauth.json");
        var rotated = JsonNode.Parse(await File.ReadAllTextAsync(file))!["servers"]!["peer"]![
            "tokens"
        ]!.DeepClone();
        await peer.ReleaseAsync("metadata");
        Assert.Contains("state=", await consent);
        Assert.True(
            JsonNode.DeepEquals(
                rotated,
                JsonNode.Parse(await File.ReadAllTextAsync(file))!["servers"]!["peer"]!["tokens"]
            )
        );
        Assert.Equal(1, Count(await peer.StateAsync(), "refreshes"));
        Assert.Equal(1, Count(await peer.StateAsync(), "registrations"));
    }

    [Fact]
    public async Task Caller_Stop_releases_only_its_waiter_while_another_owner_uses_shared_refresh()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        await peer.AuthorizeAsync(f.Mcp);
        await f.CallAsync(f.First, "state");
        var second = McpOAuthPeer.Value(await f.CallAsync(f.Second, "state"));
        await peer.GateAsync("refresh");
        await peer.SetAsync(new() { ["force401"] = 2 });
        using var stop = new CancellationTokenSource();
        var stopped = f.CallAsync(f.First, "state", token: stop.Token);
        await peer.WaitAsync("refreshEntered");
        var surviving = f.CallAsync(f.Second, "state");
        stop.Cancel();
        Assert.NotNull((await stopped)!["error"]);
        await peer.ReleaseAsync("refresh");
        Assert.Equal(
            second["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await surviving)["context"]!.GetValue<int>()
        );
        Assert.Equal(1, Count(await peer.StateAsync(), "refreshes"));
    }

    [Fact]
    public async Task Postrename_account_publication_failure_still_fences_old_resource_binding_and_stale_refresh()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        var fail = false;
        var closes = 0;
        var service = new McpOAuthService(
            f.Data,
            PublicBase,
            f.Mcp.AuthorizationServer,
            _ => closes++,
            CancellationToken.None,
            stage =>
            {
                if (fail && stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                    throw new IOException("Owned durability fixture failure");
            }
        );
        async Task Consent()
        {
            var url = await service.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default);
            await service.FinishAsync(await peer.CallbackAsync(url), default);
        }
        await Consent();
        using var old = service.ResourceClient("peer", f.Mcp.AuthorizationServer("peer"));
        using (var response = await old.GetAsync(peer.Url + "/unknown-resource"))
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        await peer.GateAsync("refresh");
        await peer.SetAsync(new() { ["force401"] = 1 });
        var renewing = old.GetAsync(peer.Resource);
        await peer.WaitAsync("refreshEntered");
        var pending = await service.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default);
        var query = await peer.CallbackAsync(pending);
        fail = true;
        var error = await Assert.ThrowsAsync<McpOAuthException>(() =>
            service.FinishAsync(query, default)
        );
        Assert.Equal("storage", error.Code);
        var file = Path.Combine(f.Data, "state", "mcp-oauth.json");
        var committed = JsonNode.Parse(await File.ReadAllTextAsync(file))!["servers"]!["peer"]![
            "tokens"
        ]!.DeepClone();
        Assert.Equal(
            "authorized",
            service.Status("peer", f.Mcp.AuthorizationServer("peer"))["state"]!.GetValue<string>()
        );
        Assert.Equal(2, closes);
        fail = false;
        await peer.ReleaseAsync("refresh");
        await Assert.ThrowsAsync<McpOAuthException>(() => renewing);
        await service.DrainAsync();
        Assert.True(
            JsonNode.DeepEquals(
                committed,
                JsonNode.Parse(await File.ReadAllTextAsync(file))!["servers"]!["peer"]!["tokens"]
            )
        );
        await Assert.ThrowsAsync<McpOAuthException>(() => old.GetAsync(peer.Resource));
        using var current = service.ResourceClient("peer", f.Mcp.AuthorizationServer("peer"));
        using var usable = await current.GetAsync(peer.Url + "/unknown-resource");
        Assert.Equal(HttpStatusCode.NotFound, usable.StatusCode);
    }
}
