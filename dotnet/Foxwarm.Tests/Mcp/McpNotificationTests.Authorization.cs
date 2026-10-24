using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Theory]
    [InlineData(60)]
    [InlineData(5)]
    public async Task OAuth_same_grant_refresh_retains_reception_and_stream_credentials_but_disconnect_fences_the_named_server(int tokenLifetime)
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await peer.SetAsync(new() { ["tokenLifetime"] = tokenLifetime });
        await using var f = await OutboundMcpFixture.CreateAsync("https://localhost/preview");
        await f.ConfigureAsync(peer.Resource);
        await f.Mcp.SetAuthorizationAsync(
            "peer",
            new JsonObject { ["authentication"] = "oauth", ["scope"] = "read" }
        );
        await peer.AuthorizeAsync(f.Mcp);
        Assert.Equal("receiving", State(await Notifications(f, "start")));
        var original = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        // Ordinary POSTs can renew the grant independently of the still-open GET.
        // Select the credential that actually authenticated that physical stream.
        var get = Assert.Single((await peer.StateAsync())["resourceHeaders"]!.AsArray()
            .OfType<JsonObject>(), headers => headers["accept"]?.GetValue<string>() == "text/event-stream");
        var oldAccess = get["authorization"]!.GetValue<string>()["Bearer ".Length..];
        await peer.SetAsync(new() { ["force401"] = 1 });
        var refreshed = McpOAuthPeer.Value(await f.CallAsync(f.First, "state"));
        Assert.Equal(original["context"]!.GetValue<int>(), refreshed["context"]!.GetValue<int>());
        Assert.Equal("receiving", State(await Notifications(f, "status")));
        using var handling = new NotificationHandling(Foxwarm.McpClient.SessionMessageMethod);
        using var http = new HttpClient();
        async Task Notify(string text)
        {
            using var response = await http.PostAsJsonAsync(
                peer.Url + "/fixture/notify",
                new JsonObject { ["message"] = text, ["endpoint"] = "oauth-peer" }
            );
            response.EnsureSuccessStatusCode();
        }
        await Notify("old GET credential: " + oldAccess);
        await handling.WaitAsync();
        Assert.Empty(Queue(f.First));
        await Notify("ordinary after refresh");
        await handling.WaitAsync();
        Assert.Single(Queue(f.First));
        Assert.Equal(
            "ordinary after refresh",
            Queue(f.First)[0].Parts![1]["text"]!.GetValue<string>()
        );
        await peer.SetAsync(new() { ["requiredScope"] = "write" });
        Assert.NotNull((await f.CallAsync(f.First, "state"))!["error"]);
        Assert.Equal("receiving", State(await Notifications(f, "status")));
        await peer.SetAsync(new() { ["requiredScope"] = "" });
        Assert.Equal(
            original["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await f.CallAsync(f.First, "state"))["context"]!.GetValue<int>()
        );
        f.Mcp.OAuth.Disconnect("peer");
        Assert.Equal("stopped", State(await Notifications(f, "status")));
        await Notify("after disconnect");
        Assert.Single(Queue(f.First));
        Assert.NotNull((await Notifications(f, "start"))!["error"]);
    }

    [Fact]
    public async Task Account_revocation_unregisters_only_its_reply_context_and_ordinary_scoped_access_edits_preserve_reception()
    {
        await using var peer = await InboundMcpFixture.CreateAsync();
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        await f.Mcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "other",
                ["transport"] = "streamable-http",
                ["url"] = peer.Url,
                ["token"] = InboundMcpFixture.Beta,
            },
            default
        );
        await Notifications(f, "start");
        await Notifications(f, "start", f.Second, "other");
        var alpha = Target(
            await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "alpha"))
        );
        var betaCall = new JsonObject
        {
            ["name"] = "call_tool",
            ["args"] = new JsonObject
            {
                ["toolId"] = "mcp:other/foxwarm_session",
                ["args"] = Send(peer.Target.Id, "beta"),
            },
        };
        var beta = Target(await f.Tools(f.Second).ExecuteAsync(betaCall, default));
        await peer.Configuration.Access.ApplyAsync(
            AccessConfiguration.Normalize(InboundMcpFixture.App(webui: true)["access"])
        );
        Assert.Null((await Reply(peer, alpha, "still alpha"))!["error"]);
        await Until(() => Queue(f.First).Length == 1);
        await peer.Configuration.Access.ApplyAsync(
            AccessConfiguration.Normalize(
                InboundMcpFixture.App("synthetic-rotated-alpha")["access"]
            )
        );
        Assert.NotNull((await Reply(peer, alpha, "revoked"))!["error"]);
        Assert.Null((await Reply(peer, beta, "beta unaffected"))!["error"]);
        await Until(() => Queue(f.Second).Length == 1);
        Assert.Single(Queue(f.First));
        Assert.Equal("receiving", State(await Notifications(f, "status", f.Second, "other")));
    }

    [Fact]
    public async Task Registered_destination_authorization_is_concrete_for_direct_unified_and_native_calls()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        var sent = new List<string>();
        f.Manager.ChannelRegistry.Register(
            "controlled",
            (conversation, text, _) =>
            {
                if (text == "adapter failure")
                    throw new InvalidOperationException("Synthetic transport failure.");
                sent.Add(conversation + "=" + text);
                return Task.CompletedTask;
            }
        );
        var args = Channel("controlled:conversation:with:colons", "direct");
        var tool = f.Tools(f.First);
        Assert.Null(
            (
                await tool.ExecuteAsync(
                    new JsonObject { ["name"] = "send_to_channel", ["args"] = args.DeepClone() },
                    default
                )
            )!["error"]
        );
        Assert.Equal(new[] { "conversation:with:colons=direct" }, sent);
        await f.Manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n  - id: deny-channel\n    action: deny\n    match: {tool: {source: builtin, name: send_to_channel}}\n"
            ),
            default
        );
        Assert.NotNull(
            (
                await tool.ExecuteAsync(
                    new JsonObject { ["name"] = "send_to_channel", ["args"] = args.DeepClone() },
                    default
                )
            )!["error"]
        );
        Assert.NotNull(
            (
                await tool.ExecuteAsync(
                    new JsonObject
                    {
                        ["name"] = "call_tool",
                        ["args"] = new JsonObject
                        {
                            ["toolId"] = "builtin:send_to_channel",
                            ["args"] = args.DeepClone(),
                        },
                    },
                    default
                )
            )!["error"]
        );
        var native = await f.ScriptAsync(
            "return call_tool('builtin:send_to_channel', {'channelTargetId': 'controlled:conversation:with:colons', 'message': 'native denied'})"
        );
        Assert.True(
            native?["error"] is not null || native?["result"]?["error"] is not null,
            native?.ToJsonString()
        );
        Assert.Single(sent);
        await f.Manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes("version: 1\nrules: []\n"),
            default
        );
        args["message"] = "adapter failure";
        var failed = await tool.ExecuteAsync(
            new JsonObject { ["name"] = "send_to_channel", ["args"] = args.DeepClone() },
            default
        );
        Assert.Contains(
            "Synthetic transport failure",
            failed!["error"]!["message"]!.GetValue<string>()
        );
        Assert.Single(sent);
    }
}
