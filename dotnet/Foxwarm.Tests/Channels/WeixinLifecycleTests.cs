using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WeixinLifecycleTests
{
    [Fact]
    public async Task Reload_does_not_create_a_cross_instance_cycle_when_existing_Weixin_fetch_returns_a_control_command()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var telegram = await TelegramPeer.StartAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var polls = 0;
        peer.Respond = async call =>
        {
            if (
                call.Path.EndsWith("/getupdates", StringComparison.Ordinal)
                && Interlocked.Increment(ref polls) == 1
            )
            {
                entered.TrySetResult();
                await release.Task;
                return Results.Json(
                    new JsonObject
                    {
                        ["ret"] = 0,
                        ["msgs"] = new JsonArray(
                            ExternalProtocolPeer.WeixinText("alice", "/channel stop alpha")
                        ),
                    }
                );
            }
            return null;
        };
        var config = new JsonObject
        {
            ["alpha"] = ExternalChannelFixture.Channel(),
            ["weixin"] = peer.Weixin(),
        };
        config["weixin"]!["longPollTimeoutMs"] = 10000;
        var f = await ExternalChannelFixture.CreateAsync(
            config,
            dependencies: telegram.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        config["weixin"]!["longPollTimeoutMs"] = 80;
        var reload = f.Configuration.SaveAppAsync(
            new JsonObject { ["channels"] = config.DeepClone() }.ToJsonString()
        );
        await TelegramChannelTests.Until(() => f.Manager.ChannelRegistry.Get("alpha") is null);
        release.TrySetResult();
        // On failure the bounded test process, rather than a joining teardown, owns cleanup of the cycle.
        var completed = await Task.WhenAny(reload, Task.Delay(2000));
        Assert.Same(reload, completed);
        await reload;
        Assert.NotNull(f.Manager.ChannelRegistry.Get("weixin"));
        await f.DisposeAsync();
    }

    [Fact]
    public async Task A_refused_reply_is_a_send_failure_and_polling_continues()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var polls = 0;
        var polledAgain = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = call =>
        {
            if (call.Path.EndsWith("/getupdates", StringComparison.Ordinal))
            {
                var count = Interlocked.Increment(ref polls);
                if (count == 1)
                    return Task.FromResult<IResult?>(
                        Results.Json(
                            new JsonObject
                            {
                                ["ret"] = 0,
                                ["get_updates_buf"] = "cursor-1",
                                // An unknown sender gets an awaited reply.
                                ["msgs"] = new JsonArray(ExternalProtocolPeer.WeixinText("stranger", "hello")),
                            }
                        )
                    );
                if (count >= 3)
                    polledAgain.TrySetResult();
                return Task.FromResult<IResult?>(Results.Json(new JsonObject { ["ret"] = 0, ["msgs"] = new JsonArray() }));
            }
            // The reply endpoint redirects to an address the policy refuses.
            return Task.FromResult<IResult?>(Results.Redirect("http://127.0.0.2:1/send"));
        };
        // The peer's loopback address is the one exception.
        var egress = Foxwarm.Net.EgressPolicy.Hosted(
            Foxwarm.Net.EgressRules.Parse(ConfigurationYaml.Parse("allow: {hosted: [127.0.0.1/32]}", "egress"))
        );
        var config = new JsonObject { ["weixin"] = peer.Weixin() };
        config["weixin"]!["longPollTimeoutMs"] = 80;
        await using var f = await ExternalChannelFixture.CreateAsync(
            config,
            dependencies: new Foxwarm.Channels.ChannelTransportDependencies(
                CreateHttp: () => Foxwarm.Channels.ChannelHttpClients.Single(egress),
                Delay: (_, token) => Task.Delay(10, token)
            )
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await polledAgain.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Contains(peer.Calls, call => !call.Path.EndsWith("/getupdates", StringComparison.Ordinal));
        var status = f.Configuration.ManagedChannels!.Statuses()
            .OfType<JsonObject>()
            .Single(row => row["channelId"]!.ToString() == "weixin")
            .ToJsonString();
        Assert.Contains("blocked by this deployment", status);
        Assert.Contains("sending", status, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Command_confirmation_uses_the_same_config_owner_without_waiting_for_Setup_to_join_its_Weixin_handler()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var key = "";
        var polls = 0;
        peer.Respond = async call =>
        {
            if (
                call.Key == "source-token"
                && call.Path.EndsWith("/getupdates", StringComparison.Ordinal)
                && Interlocked.Increment(ref polls) == 1
            )
            {
                entered.TrySetResult();
                await release.Task;
                return Results.Json(
                    new JsonObject
                    {
                        ["ret"] = 0,
                        ["msgs"] = new JsonArray(
                            ExternalProtocolPeer.WeixinText("alice", "/channel weixin-wait " + key)
                        ),
                    }
                );
            }
            return null;
        };
        var config = new JsonObject
        {
            ["a-default"] = peer.Weixin("default-token"),
            ["z-source"] = peer.Weixin("source-token"),
        };
        config["z-source"]!["longPollTimeoutMs"] = 10000;
        var f = await ExternalChannelFixture.CreateAsync(config, dependencies: peer.Dependencies);
        var login = await f.Manager.ManagedChannels!.Weixin.StartLoginAsync(
            peer.Address.ToString()
        );
        key = SessionWait.Text(login["sessionKey"])!;
        await f.Manager.ManagedChannels.ReloadAsync();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        config["z-source"]!["longPollTimeoutMs"] = 80;
        var reload = f.Configuration.SaveAppAsync(
            new JsonObject { ["channels"] = config.DeepClone() }.ToJsonString()
        );
        await TelegramChannelTests.Until(() => f.Manager.ChannelRegistry.Get("a-default") is null);
        release.TrySetResult();
        Assert.Same(reload, await Task.WhenAny(reload, Task.Delay(2000)));
        await reload;
        Assert.Equal(
            "confirmed-token",
            SessionWait.Text(f.Configuration.CurrentChannels()["a-default"]!["token"])
        );
        Assert.DoesNotContain(
            "owner",
            SessionWait.Strings(f.Configuration.CurrentChannels()["a-default"]!["allowedUsers"])
        );
        Assert.NotNull(f.Manager.ChannelRegistry.Get("a-default"));
        Assert.NotNull(f.Manager.ChannelRegistry.Get("z-source"));
        await f.DisposeAsync();
    }
}
