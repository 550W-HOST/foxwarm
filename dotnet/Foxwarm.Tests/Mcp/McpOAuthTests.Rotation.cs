using System.Net;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class McpOAuthTests
{
    [Fact]
    public async Task Consent_preparation_and_rotating_refresh_merge_into_current_authority()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        var first = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        await peer.GateAsync("refresh"); await peer.SetAsync(new() { ["force401"] = 1 });
        var renewing = f.CallAsync(f.First, "state");
        await peer.WaitAsync("refreshEntered");
        var pending = await f.Mcp.OAuth.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default);
        await peer.ReleaseAsync("refresh");
        Assert.Equal(first["context"]!.GetValue<int>(), McpOAuthPeer.Value(await renewing)["context"]!.GetValue<int>());
        var state = await peer.StateAsync();
        var newAccess = state["accessTokens"]!.AsArray().Last()!.GetValue<string>();
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "mcp-oauth.json")))!;
        Assert.Equal(newAccess, saved["servers"]!["peer"]!["tokens"]!["access_token"]!.GetValue<string>());
        Assert.Equal("authorizing", f.Mcp.OAuth.Status("peer", f.Mcp.AuthorizationServer("peer"))["state"]!.GetValue<string>());
        Assert.Contains("state=", pending);
        Assert.Equal(1, Count(state, "registrations"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task New_grant_or_disconnect_fences_inflight_refresh_publication_and_remote_binding(bool disconnect)
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        var old = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        await peer.GateAsync("refresh"); await peer.SetAsync(new() { ["force401"] = 1 });
        var renewing = f.CallAsync(f.First, "state"); await peer.WaitAsync("refreshEntered");
        if (disconnect) f.Mcp.OAuth.Disconnect("peer");
        else await peer.AuthorizeAsync(f.Mcp);
        var after = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "mcp-oauth.json")))!["servers"]!["peer"]!["tokens"]?.DeepClone();
        if (!disconnect)
        {
            await peer.SetAsync(new() { ["force401"] = 1 });
            var independent = await f.CallAsync(f.First, "state").WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotEqual(old["context"]!.GetValue<int>(), McpOAuthPeer.Value(independent)["context"]!.GetValue<int>());
            after = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "mcp-oauth.json")))!["servers"]!["peer"]!["tokens"]?.DeepClone();
        }
        await peer.ReleaseAsync("refresh");
        Assert.NotNull((await renewing)!["error"]);
        await f.Mcp.OAuth.DrainAsync();
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "mcp-oauth.json")))!;
        Assert.True(JsonNode.DeepEquals(after, saved["servers"]!["peer"]!["tokens"]));
        if (disconnect)
        {
            Assert.Null(after);
            var state = await peer.StateAsync();
            Assert.NotNull((await f.CallAsync(f.First, "state"))!["error"]);
            Assert.Equal(Count(state, "effects"), Count(await peer.StateAsync(), "effects"));
            await peer.AuthorizeAsync(f.Mcp);
            Assert.Equal(1, Count(await peer.StateAsync(), "registrations"));
        }
        var fresh = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        Assert.NotEqual(old["context"]!.GetValue<int>(), fresh["context"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Result_and_error_guards_withhold_actually_selected_intermediate_credentials_across_two_rotations(bool error)
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        await f.CallAsync(f.First, "state"); await f.CallAsync(f.Second, "state");
        await peer.SetAsync(new() { ["force401"] = 1 });
        await f.CallAsync(f.First, "state");
        var intermediate = (await peer.StateAsync())["accessTokens"]!.AsArray().Last()!.GetValue<string>();
        await peer.SetAsync(new() { ["slowEcho"] = true, ["slowError"] = error }); await peer.GateAsync("slow");
        var slow = f.CallAsync(f.First, "state", new() { ["label"] = "slow" }); await peer.WaitAsync("slowEntered");
        for (var i = 0; i < 2; i++)
        {
            await peer.SetAsync(new() { ["force401"] = 1 });
            Assert.NotNull(McpOAuthPeer.Value(await f.CallAsync(f.Second, "state")));
        }
        await peer.ReleaseAsync("slow");
        var blocked = await slow;
        Assert.NotNull(blocked!["error"]);
        Assert.Contains("credential", blocked["error"]!["message"]!.GetValue<string>());
        var state = await peer.StateAsync();
        Assert.Equal(6, Count(state, "effects"));
        foreach (var secret in state["accessTokens"]!.AsArray().Concat(state["refreshTokens"]!.AsArray()))
            Assert.DoesNotContain(secret!.GetValue<string>(), blocked.ToJsonString());
        // An operation context is cleared, not promoted into a global token history.
        var ordinary = await f.Mcp.OAuth.GuardAsync(f.Mcp.AuthorizationServer("peer"), () => Task.FromResult<JsonNode?>(JsonValue.Create(intermediate)));
        Assert.Equal(intermediate, ordinary!.GetValue<string>());
    }

    [Fact]
    public async Task Standard401_resends_once_but503_404_network_and_unknown_effects_never_replay()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        await f.CallAsync(f.First, "state");
        await peer.SetAsync(new() { ["force401"] = 1 });
        Assert.NotNull(McpOAuthPeer.Value(await f.CallAsync(f.First, "state")));
        Assert.Equal(2, Count(await peer.StateAsync(), "effects"));
        Assert.Equal(1, Count(await peer.StateAsync(), "refreshes"));
        await peer.SetAsync(new() { ["slowError"] = true });
        Assert.NotNull((await f.CallAsync(f.First, "state", new() { ["label"] = "slow" }))!["error"]);
        Assert.Equal(3, Count(await peer.StateAsync(), "effects"));
        Assert.Equal(1, Count(await peer.StateAsync(), "refreshes"));
        using var resource = f.Mcp.OAuth.ResourceClient("peer", f.Mcp.AuthorizationServer("peer"));
        using var missing = await resource.GetAsync(peer.Url + "/unknown-resource");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal(1, Count(await peer.StateAsync(), "refreshes"));
        // A refused connection is not an authorization rejection and never launches a token request.
        await peer.DisposeAsync();
        await Assert.ThrowsAsync<HttpRequestException>(() => resource.PostAsync(peer.Resource, new StringContent("{}")));
    }

    [Fact]
    public async Task Invalid_grant_requires_administrator_and_auto_fallback_does_not_hide_authorization()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        await f.CallAsync(f.First, "state");
        await peer.SetAsync(new() { ["invalidRefresh"] = true, ["force401"] = 1 });
        Assert.NotNull((await f.CallAsync(f.First, "state"))!["error"]);
        Assert.Equal("needs-authorization", f.Mcp.OAuth.Status("peer", f.Mcp.AuthorizationServer("peer"))["state"]!.GetValue<string>());
        var state = await peer.StateAsync();
        Assert.NotNull((await f.CallAsync(f.First, "state"))!["error"]);
        Assert.Equal(Count(state, "effects"), Count(await peer.StateAsync(), "effects"));
        await f.Mcp.ConfigureAsync(new() { ["name"] = "peer", ["transport"] = "auto" }, default);
        Assert.NotNull((await f.CallAsync(f.First, "state"))!["error"]);
        Assert.Equal(1, Count(await peer.StateAsync(), "contexts"));
        Assert.Equal(1, Count(await peer.StateAsync(), "registrations"));
    }

    [Theory]
    [InlineData("sse")]
    [InlineData("auto")]
    public async Task OAuth_SSE_and_auto_preserve_caller_context_and_static_alias_is_independent(string transport)
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer, transport); await peer.AuthorizeAsync(f.Mcp);
        var one = McpOAuthPeer.Value(await f.CallAsync(f.First, "state", Args("oauth")));
        await peer.SetAsync(new() { ["force401"] = 1 });
        Assert.Equal(one["context"]!.GetValue<int>(), McpOAuthPeer.Value(await f.CallAsync(f.First, "state"))["context"]!.GetValue<int>());
        await f.Mcp.ConfigureAsync(new() { ["name"] = "static", ["url"] = peer.Resource, ["transport"] = "streamable-http", ["token"] = "fixture-static-token" }, default);
        var independent = McpOAuthPeer.Value(await f.Mcp.CallAsync("static", "state", Args("static"), default, f.Second, f.Second.McpGeneration));
        Assert.Equal("static", independent["value"]!.GetValue<string>());
        await peer.SetAsync(new() { ["echoCredential"] = true });
        var blocked = await Assert.ThrowsAsync<InvalidOperationException>(() => f.Mcp.CallAsync("static", "state", new(), default, f.Second, f.Second.McpGeneration));
        Assert.Contains("credential", blocked.Message);
        f.Mcp.OAuth.Disconnect("peer");
        await peer.SetAsync(new() { ["echoCredential"] = false });
        Assert.Equal(independent["context"]!.GetValue<int>(), McpOAuthPeer.Value(await f.Mcp.CallAsync("static", "state", new(), default, f.Second, f.Second.McpGeneration))["context"]!.GetValue<int>());
    }

    [Fact]
    public async Task Nonrotating_refresh_response_retains_original_refresh_authority_for_the_next_renewal()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        await f.CallAsync(f.First, "state");
        var file = Path.Combine(f.Data, "state", "mcp-oauth.json");
        var original = JsonNode.Parse(await File.ReadAllTextAsync(file))!["servers"]!["peer"]!["tokens"]!["refresh_token"]!.GetValue<string>();
        await peer.SetAsync(new() { ["omitRefreshToken"] = true });
        for (var i = 0; i < 2; i++)
        {
            await peer.SetAsync(new() { ["force401"] = 1 });
            Assert.NotNull(McpOAuthPeer.Value(await f.CallAsync(f.First, "state")));
            Assert.Equal(original, JsonNode.Parse(await File.ReadAllTextAsync(file))!["servers"]!["peer"]!["tokens"]!["refresh_token"]!.GetValue<string>());
        }
        Assert.Equal(2, Count(await peer.StateAsync(), "refreshes"));
    }

    [Fact]
    public async Task Short_lived_nonrefresh_grant_requires_new_consent_only_after_expiry()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await peer.SetAsync(new() { ["issueRefreshTokens"] = false, ["tokenLifetime"] = 1 });
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer); await peer.AuthorizeAsync(f.Mcp);
        Assert.NotNull(McpOAuthPeer.Value(await f.CallAsync(f.First, "state")));
        await Task.Delay(1200);
        Assert.NotNull((await f.CallAsync(f.First, "state"))!["error"]);
        Assert.Equal(1, Count(await peer.StateAsync(), "effects"));
        Assert.Equal(0, Count(await peer.StateAsync(), "refreshes"));
    }
}
