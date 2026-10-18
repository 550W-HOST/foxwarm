using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WeWorkLifecycleTests
{
    [Fact]
    public async Task Normal_headless_Main_keeps_callback_listener_independent_of_administrator_HTTP_and_token_initialization()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        var port = WeWorkPeer.Port();
        var config = peer.Config(port);
        config.Remove("webhookUrl");
        await File.WriteAllTextAsync(
            Path.Combine(data, "state/config.yaml"),
            new JsonObject
            {
                ["bot"] = new JsonObject { ["enableWebUI"] = false, ["enableTrigger"] = false },
                ["channels"] = new JsonObject { ["work"] = config },
            }.ToJsonString()
        );
        var configuration = new ModelConfiguration(data);
        var settings = await HttpServerSettings.CaptureAsync(configuration, data);
        Assert.False(settings.HttpEnabled);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            configuration,
            settings,
            null,
            channelDependencies: peer.Dependencies
        );
        await host.StartAsync();
        Assert.False(host.HttpEnabled);
        Assert.False(File.Exists(Path.Combine(data, "state/token")));
        using var callback = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var initial = await WeWorkCallbackTests.Post(
            callback,
            WeWorkPeer.Text("who", "@企业机器人 /whoami")
        );
        Assert.Contains(
            "alice",
            WeWorkCallbackTests.Content(
                await WeWorkCallbackTests.Refresh(callback, WeWorkCallbackTests.Id(initial))
            )
        );
        Assert.False(File.Exists(Path.Combine(data, "state/token")));
        Assert.Empty(peer.Calls);
    }

    [Fact]
    public async Task Callback_self_restart_does_not_join_its_router_handler_and_late_accepted_work_keeps_existing_effect_truth()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(port) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        using var callback = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var old = f.Manager.ChannelRegistry.Get("work");
        await WeWorkCallbackTests.Post(
            callback,
            WeWorkPeer.Text("restart", "@企业机器人 /channel restart work")
        );
        await TelegramChannelTests.Until(() =>
            f.Manager.ChannelRegistry.Get("work") is { } value && !ReferenceEquals(old, value)
        );
        using var active = new HttpClient { BaseAddress = callback.BaseAddress };
        var fresh = await WeWorkCallbackTests.Post(active, WeWorkPeer.Text("fresh"));
        Assert.Equal("> 🤔 thinking", WeWorkCallbackTests.Content(fresh));
        var source = WeWorkCallbackTests.Id(fresh);
        await f
            .Manager.ManagedChannels.ChangeAsync("restart", "work")
            .WaitAsync(TimeSpan.FromSeconds(3));
        // Like Source server.close, a pooled old connection may fail rather than transparently move.
        try
        {
            var pooled = await WeWorkCallbackTests.Refresh(active, source);
            Assert.Equal("未找到对应的流式消息。", WeWorkCallbackTests.Content(pooled));
        }
        catch (HttpRequestException) { }
        using var replacement = new HttpClient { BaseAddress = callback.BaseAddress };
        var after = await WeWorkCallbackTests.Refresh(replacement, source);
        Assert.True(after["stream"]!["finish"]!.GetValue<bool>());
        Assert.Equal("未找到对应的流式消息。", WeWorkCallbackTests.Content(after));
        Assert.Empty(peer.Calls);
    }

    [Fact]
    public async Task Managed_partial_reload_keeps_other_adapters_and_unmanaged_registrations_without_redefining_configuration_readiness()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var protocol = await ExternalProtocolPeer.StartAsync();
        await using var telegram = await TelegramPeer.StartAsync();
        var port = WeWorkPeer.Port();
        var channels = new JsonObject
        {
            ["alpha"] = ExternalChannelFixture.Channel(),
            ["matrix"] = protocol.Matrix(),
            ["weixin"] = protocol.Weixin(),
            ["work"] = peer.Config(port),
            ["unready"] = new JsonObject
            {
                ["type"] = "wework",
                ["listenPort"] = port + 1,
                ["listenPath"] = "/callback",
            },
        };
        var dependencies = telegram.Dependencies with
        {
            CallbackAddress = System.Net.IPAddress.Loopback,
        };
        await using var f = await ExternalChannelFixture.CreateAsync(
            channels,
            dependencies: dependencies
        );
        var first = await f.Manager.ManagedChannels!.ReloadAsync();
        Assert.Equal(4, first["started"]!.AsArray().Count);
        Assert.False(
            first["statuses"]!
                .AsArray()
                .Single(item => item!["channelId"]!.GetValue<string>() == "unready")![
                "configured"
            ]!.GetValue<bool>()
        );
        // Fixed unmanaged registrations are outside managed stop/recreate ownership.
        var received = new List<string>();
        f.Manager.ChannelRegistry.Register(
            "webui",
            (_, text, _) =>
            {
                received.Add(text);
                return Task.CompletedTask;
            }
        );
        var second = await f.Configuration.SaveChannelsAsync(channels);
        Assert.Equal(4, second["reload"]!["stopped"]!.AsArray().Count);
        Assert.Equal(4, second["reload"]!["started"]!.AsArray().Count);
        var collision = peer.Config(port);
        channels["z-collision"] = collision;
        var partial = await f.Configuration.SaveChannelsAsync(channels);
        Assert.Equal(4, partial["reload"]!["started"]!.AsArray().Count);
        Assert.NotNull(f.Manager.ChannelRegistry.Get("work"));
        Assert.Null(f.Manager.ChannelRegistry.Get("z-collision"));
        Assert.NotNull(f.Manager.ChannelRegistry.Get("alpha"));
        Assert.NotNull(f.Manager.ChannelRegistry.Get("matrix"));
        Assert.NotNull(f.Manager.ChannelRegistry.Get("weixin"));
        await f.Manager.ChannelRegistry.SendAsync("webui:fixture", "still registered", default);
        Assert.Equal(new[] { "still registered" }, received);
        Assert.Null(f.Manager.ChannelBinding("webui:fixture"));
    }
}
