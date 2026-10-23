using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class McpOAuthTests
{
    private const string PublicBase = "https://localhost/preview";

    private static JsonObject Mode(string? id = null, string? secret = null) =>
        new()
        {
            ["authentication"] = "oauth",
            ["scope"] = "read",
            ["clientId"] = id,
            ["clientSecret"] = secret,
        };

    private static JsonObject Args(string value) => new() { ["value"] = value };

    private static int Count(JsonObject state, string key) => state[key]!.GetValue<int>();

    private static async Task ConfigureAsync(
        OutboundMcpFixture f,
        McpOAuthPeer peer,
        string transport = "streamable-http"
    )
    {
        await f.ConfigureAsync(
            transport == "streamable-http" ? peer.Resource : peer.Url + "/sse",
            transport,
            new JsonObject { ["headers"] = new JsonObject { ["X-API-Key"] = "resource-only-key" } }
        );
        await f.Mcp.SetAuthorizationAsync("peer", Mode());
    }

    [Theory]
    [InlineData("none")]
    [InlineData("cimd")]
    [InlineData("dcr")]
    public async Task Browser_PKCE_registration_paths_persist_private_Source_records_and_survive_fresh_client(
        string registration
    )
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await peer.SetAsync(new() { ["registration"] = registration });
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        if (registration == "none")
            await f.Mcp.SetAuthorizationAsync(
                "peer",
                Mode("pre-registered", "pre-registered-secret")
            );
        if (registration == "cimd")
            await peer.MetadataAsync(f.Mcp.OAuth.ClientMetadata());
        var begin = await f.Mcp.OAuth.BeginAsync(
            "peer",
            f.Mcp.AuthorizationServer("peer"),
            default
        );
        var callback = await peer.CallbackAsync(begin);
        await f.Mcp.OAuth.FinishAsync(callback, default);
        Assert.Contains("/preview/api/mcp/oauth/callback", Uri.UnescapeDataString(begin));
        Assert.Contains("code_challenge_method=S256", begin);
        var state = await peer.StateAsync();
        Assert.Equal(1, Count(state, "exchanges"));
        Assert.Equal(registration == "dcr" ? 1 : 0, Count(state, "registrations"));
        Assert.All(
            state["asHeaders"]!.AsArray(),
            headers =>
            {
                Assert.Null(headers!["x-api-key"]);
                var authorization = headers["authorization"]?.GetValue<string>();
                Assert.False(authorization?.StartsWith("Bearer ") == true);
            }
        );
        var file = Path.Combine(f.Data, "state", "mcp-oauth.json");
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        Assert.Equal(1, saved["version"]!.GetValue<int>());
        Assert.Equal(peer.Resource, saved["servers"]!["peer"]!["serverUrl"]!.GetValue<string>());
        Assert.Equal(PublicBase, saved["servers"]!["peer"]!["publicBaseUrl"]!.GetValue<string>());
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(file)
            );
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(Path.Combine(f.Data, "state", "mcp.json"))
            );
        }
        Assert.DoesNotContain("pre-registered-secret", f.Mcp.Authorizations().ToJsonString());
        Assert.DoesNotContain(
            "fixture-client-secret",
            (await f.Mcp.ListServersAsync(default)).ToJsonString()
        );
        await using var fresh = new McpClient(f.Data, PublicBase);
        Assert.Single(await fresh.ListToolsAsync("peer", default, f.First, f.First.McpGeneration));
        Assert.Equal(
            "persisted",
            McpOAuthPeer.Value(await fresh.CallAsync("peer", "state", Args("persisted"), default, f.First, f.First.McpGeneration))[
                "value"
            ]!.GetValue<string>()
        );
        await Assert.ThrowsAsync<McpOAuthException>(() =>
            fresh.OAuth.FinishAsync(callback, default)
        );
    }

    [Fact]
    public async Task Callback_state_issuer_config_generation_and_single_use_reject_without_unwanted_exchange()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        var url = await f.Mcp.OAuth.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default);
        var callback = await peer.CallbackAsync(url);
        var wrongState = (JsonObject)callback.DeepClone();
        wrongState["state"] = "not-pending";
        await Assert.ThrowsAsync<McpOAuthException>(() =>
            f.Mcp.OAuth.FinishAsync(wrongState, default)
        );
        var wrongIssuer = (JsonObject)callback.DeepClone();
        wrongIssuer["iss"] = peer.Url + "/evil";
        Assert.Equal(
            "issuer",
            (
                await Assert.ThrowsAsync<McpOAuthException>(() =>
                    f.Mcp.OAuth.FinishAsync(wrongIssuer, default)
                )
            ).Code
        );
        var missingIssuer = (JsonObject)callback.DeepClone();
        missingIssuer.Remove("iss");
        await Assert.ThrowsAsync<McpOAuthException>(() =>
            f.Mcp.OAuth.FinishAsync(missingIssuer, default)
        );
        Assert.Equal(0, Count(await peer.StateAsync(), "exchanges"));
        await f.Mcp.OAuth.FinishAsync(callback, default);
        await Assert.ThrowsAsync<McpOAuthException>(() =>
            f.Mcp.OAuth.FinishAsync(callback, default)
        );
        var replaced = await peer.CallbackAsync(
            await f.Mcp.OAuth.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default)
        );
        var changed = Mode();
        changed["scope"] = "write";
        await f.Mcp.SetAuthorizationAsync("peer", changed);
        await Assert.ThrowsAsync<McpOAuthException>(() =>
            f.Mcp.OAuth.FinishAsync(replaced, default)
        );
        Assert.Equal(1, Count(await peer.StateAsync(), "exchanges"));
    }

    [Theory]
    [InlineData("mismatchIssuer")]
    [InlineData("mismatchResource")]
    [InlineData("pkce")]
    public async Task Discovery_rejects_resource_issuer_and_missing_S256_before_registration(
        string setting
    )
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        await peer.SetAsync(new() { [setting] = setting != "pkce" });
        await Assert.ThrowsAsync<McpOAuthException>(() =>
            f.Mcp.OAuth.BeginAsync("peer", f.Mcp.AuthorizationServer("peer"), default)
        );
        Assert.Equal(0, Count(await peer.StateAsync(), "registrations"));
        Assert.Equal(0, Count(await peer.StateAsync(), "exchanges"));
    }

    [Fact]
    public async Task Shared_single_flight_rotation_retains_two_trusted_Session_contexts_search_call_and_native_Monty()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        await peer.AuthorizeAsync(f.Mcp);
        var search = await f.Tools(f.First)
            .ExecuteAsync(
                new JsonObject
                {
                    ["name"] = "search_tools",
                    ["args"] = new JsonObject
                    {
                        ["sources"] = new JsonArray("mcp"),
                        ["server"] = "peer",
                    },
                },
                default
            );
        Assert.Contains("state", search!["output"]!.GetValue<string>());
        var first = McpOAuthPeer.Value(await f.CallAsync(f.First, "state", Args("first")));
        var second = McpOAuthPeer.Value(await f.CallAsync(f.Second, "state", Args("second")));
        Assert.NotEqual(first["context"]!.GetValue<int>(), second["context"]!.GetValue<int>());
        var script = await f.ScriptAsync("return call_tool('mcp:peer/state', {})");
        Assert.Equal("completed", script!["status"]!.GetValue<string>());
        Assert.Equal(
            first["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(script["result"])["context"]!.GetValue<int>()
        );
        await peer.GateAsync("refresh");
        await peer.SetAsync(new() { ["force401"] = 2, ["omitRefreshScope"] = true });
        var one = f.CallAsync(f.First, "state");
        await peer.WaitAsync("refreshEntered");
        var two = f.CallAsync(f.Second, "state");
        await peer.ReleaseAsync("refresh");
        Assert.Equal(
            first["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await one)["context"]!.GetValue<int>()
        );
        Assert.Equal(
            second["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await two)["context"]!.GetValue<int>()
        );
        Assert.Equal(1, Count(await peer.StateAsync(), "refreshes"));
        Assert.Equal(2, Count(await peer.StateAsync(), "contexts"));
        Assert.Equal(
            "read",
            f.Mcp.OAuth.Status("peer", f.Mcp.AuthorizationServer("peer"))[
                "grantedScope"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Scope403_has_no_effect_replay_or_context_loss_and_explicit_new_grant_fences_old_context()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        await peer.AuthorizeAsync(f.Mcp);
        var first = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        await peer.SetAsync(new() { ["requiredScope"] = "write" });
        var denied = await f.CallAsync(f.First, "state", Args("must-not-run"));
        Assert.NotNull(denied!["error"]);
        Assert.Equal(1, Count(await peer.StateAsync(), "effects"));
        Assert.Equal(
            "needs-authorization",
            f.Mcp.OAuth.Status("peer", f.Mcp.AuthorizationServer("peer"))[
                "state"
            ]!.GetValue<string>()
        );
        await peer.SetAsync(new() { ["requiredScope"] = "" });
        Assert.Equal(
            first["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await f.CallAsync(f.First, "state"))["context"]!.GetValue<int>()
        );
        await peer.AuthorizeAsync(f.Mcp);
        Assert.NotEqual(
            first["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await f.CallAsync(f.First, "state"))["context"]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task Ordinary_calls_do_not_start_consent_and_static_conflicts_stdio_and_private_endpoint_escapes_are_rejected()
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        var denied = await f.CallAsync(f.First, "state");
        Assert.NotNull(denied!["error"]);
        Assert.Equal(0, Count(await peer.StateAsync(), "registrations"));
        Assert.Equal(0, Count(await peer.StateAsync(), "effects"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Mcp.SetAuthorizationAsync(
                "peer",
                new() { ["authentication"] = "oauth", ["clientSecret"] = "missing-id" }
            )
        );
        await f.Mcp.SetAuthorizationAsync("peer", new() { ["authentication"] = "static" });
        await f.Mcp.ConfigureAsync(
            new() { ["name"] = "peer", ["token"] = "fixture-static-token" },
            default
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Mcp.SetAuthorizationAsync("peer", Mode())
        );
        var replacement = Mode();
        replacement["replaceStaticAuthorization"] = true;
        await f.Mcp.SetAuthorizationAsync("peer", replacement);
        Assert.False(
            f.Mcp.Authorizations()["servers"]![0]!["hasStaticAuthorization"]!.GetValue<bool>()
        );
        Assert.Throws<InvalidDataException>(() =>
            McpConfiguration.Normalize(
                new() { ["transport"] = "stdio", ["oauth"] = new JsonObject() },
                false
            )
        );
        foreach (
            var endpoint in new[]
            {
                "https://127.0.0.1/token",
                "https://[::ffff:127.0.0.1]/token",
                "https://192.168.1.1/token",
            }
        )
            await Assert.ThrowsAsync<McpOAuthException>(() =>
                McpOAuthHttp.RequestAsync(
                    "https://resource.example/mcp",
                    endpoint,
                    HttpMethod.Get,
                    null,
                    null,
                    default
                )
            );
        Assert.Throws<McpOAuthException>(() =>
            McpOAuthHttp.Endpoint("http://production.example/token")
        );
        Assert.Throws<McpOAuthException>(() => new McpClient(f.Data).OAuth.PublicUrl("/callback"));
    }
}
