using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class InitialChannelStartupTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task<(MainHost Host, ModelConfiguration Config)> MainAsync(
        TempDirectory temp,
        JsonObject channels,
        ChannelTransportDependencies dependencies
    )
    {
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            new JsonObject { ["vector"] = false, ["channels"] = channels }.ToJsonString()
        );
        var config = new ModelConfiguration(data);
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            config,
            settings,
            null,
            channelDependencies: dependencies
        );
        return (host, config);
    }

    private static JsonObject Status(ModelConfiguration config, string id) =>
        config
            .ManagedChannels!.Statuses()
            .OfType<JsonObject>()
            .Single(row => row["channelId"]!.ToString() == id);

    [Fact]
    public async Task Normal_Main_starts_Telegram_while_QQ_is_pending_and_stop_owns_the_pending_initializer()
    {
        using var temp = new TempDirectory();
        await using var qq = await QQBotPeer.StartAsync();
        await using var telegram = await TelegramPeer.StartAsync();
        var qqReached = Signal();
        var release = Signal();
        var lateReply = Signal();
        var telegramReached = Signal();
        qq.Respond = async call =>
        {
            if (call.Path != "/app/getAppAccessToken")
                return null;
            qqReached.TrySetResult();
            await release.Task;
            lateReply.TrySetResult();
            return Results.Json(new { access_token = "late-fixture-token", expires_in = 7200 });
        };
        telegram.Respond = call =>
        {
            if (call.Method == "getUpdates")
                telegramReached.TrySetResult();
            return Task.FromResult<IResult?>(null);
        };
        var (host, config) = await MainAsync(
            temp,
            new() { ["qq"] = qq.Config(), ["telegram"] = ExternalChannelFixture.Channel() },
            telegram.Dependencies with
            {
                CreateQQBotHttp = qq.Dependencies.CreateQQBotHttp,
            }
        );
        await using var ownedHost = host;
        var lifetime = host.Lifetime;
        var start = host.StartAsync();
        try
        {
            await Task.WhenAll(qqReached.Task, telegramReached.Task)
                .WaitAsync(TimeSpan.FromSeconds(10));
            await start.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(release.Task.IsCompleted);
            await TelegramChannelTests.Until(() =>
                Status(config, "telegram")["running"]!.GetValue<bool>()
            );
            Assert.False(Status(config, "qq")["running"]!.GetValue<bool>());
            lifetime.StopApplication();
            await start.WaitAsync(TimeSpan.FromSeconds(5));
            await host.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            release.TrySetResult();
            await lateReply.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.All(
                config.ManagedChannels!.Statuses().OfType<JsonObject>(),
                row => Assert.False(row["running"]!.GetValue<bool>())
            );
            Assert.Equal(0, qq.Connections);
            Assert.DoesNotContain(qq.Calls, call => call.Path == "/gateway");
        }
        finally
        {
            release.TrySetResult();
            lifetime.StopApplication();
            await start;
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Initial_attempts_are_bounded_and_successful_retry_registers_once(bool recover)
    {
        using var temp = new TempDirectory();
        await using var qq = await QQBotPeer.StartAsync();
        await using var telegram = await TelegramPeer.StartAsync();
        var qqAttempts = 0;
        var telegramAttempts = 0;
        qq.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path == "/app/getAppAccessToken"
                && (Interlocked.Increment(ref qqAttempts) == 1 || !recover)
                    ? Results.Text("secret-vendor-body", statusCode: 401)
                    : null
            );
        telegram.Fail = call =>
            call.Method == "setMyCommands"
            && (Interlocked.Increment(ref telegramAttempts) == 1 || !recover)
                ? (401, "secret-vendor-description")
                : null;
        var delays = new ConcurrentQueue<TimeSpan>();
        var (host, config) = await MainAsync(
            temp,
            new() { ["qq"] = qq.Config(), ["telegram"] = ExternalChannelFixture.Channel() },
            telegram.Dependencies with
            {
                CreateQQBotHttp = qq.Dependencies.CreateQQBotHttp,
                Delay = (duration, token) =>
                {
                    token.ThrowIfCancellationRequested();
                    delays.Enqueue(duration);
                    return Task.CompletedTask;
                },
            }
        );
        await using var ownedHost = host;
        await host.StartAsync().WaitAsync(TimeSpan.FromSeconds(10));
        await config.ManagedChannels!.StartInitialAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(2, qqAttempts);
        Assert.Equal(recover ? 2 : 4, telegramAttempts);
        Assert.Equal(1, delays.Count(value => value == TimeSpan.FromSeconds(3)));
        Assert.Equal(recover ? 1 : 3, delays.Count(value => value == TimeSpan.FromSeconds(5)));
        foreach (var id in new[] { "qq", "telegram" })
        {
            var status = Status(config, id);
            Assert.Equal(recover, status["running"]!.GetValue<bool>());
            if (recover)
                Assert.Null(status["lastError"]);
            else
            {
                var error = status["lastError"]!.ToString();
                Assert.Contains("401", error);
                Assert.DoesNotContain("secret", error);
                Assert.DoesNotContain("fixture-secret", error);
            }
        }
        Assert.Equal(recover ? 1 : 0, qq.Connections);
    }

    [Fact]
    public async Task Shutdown_cancels_a_pending_initial_retry_without_starting_the_next_attempt()
    {
        using var temp = new TempDirectory();
        await using var peer = await TelegramPeer.StartAsync();
        peer.Fail = call => call.Method == "setMyCommands" ? (401, "synthetic") : null;
        var retry = Signal();
        var (host, config) = await MainAsync(
            temp,
            new() { ["telegram"] = ExternalChannelFixture.Channel() },
            peer.Dependencies with
            {
                Delay = (duration, token) =>
                {
                    Assert.Equal(TimeSpan.FromSeconds(5), duration);
                    retry.TrySetResult();
                    return Task.Delay(Timeout.InfiniteTimeSpan, token);
                },
            }
        );
        await using var ownedHost = host;
        var start = host.StartAsync();
        await retry.Task.WaitAsync(TimeSpan.FromSeconds(10));
        host.Lifetime.StopApplication();
        await start.WaitAsync(TimeSpan.FromSeconds(5));
        await host.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(peer.Calls, call => call.Method == "setMyCommands");
        Assert.False(Status(config, "telegram")["running"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("disable-save")]
    [InlineData("explicit-stop")]
    [InlineData("enabled-save")]
    [InlineData("failed-reload")]
    public async Task Normal_save_or_stop_supersedes_pending_initial_retry(string action)
    {
        using var temp = new TempDirectory();
        await using var peer = await TelegramPeer.StartAsync();
        var commands = 0;
        peer.Fail = call =>
            call.Method == "setMyCommands"
            && (Interlocked.Increment(ref commands) == 1 || action == "failed-reload")
                ? (401, "synthetic")
                : null;
        var retry = Signal();
        var release = Signal();
        var (host, config) = await MainAsync(
            temp,
            new() { ["telegram"] = ExternalChannelFixture.Channel() },
            peer.Dependencies with
            {
                Delay = (duration, token) =>
                {
                    Assert.Equal(TimeSpan.FromSeconds(5), duration);
                    retry.TrySetResult();
                    return release.Task.WaitAsync(token);
                },
            }
        );
        await using var ownedHost = host;
        try
        {
            await host.StartAsync().WaitAsync(TimeSpan.FromSeconds(10));
            await retry.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(Status(config, "telegram")["running"]!.GetValue<bool>());
            if (action == "explicit-stop")
                await config.ManagedChannels!.ChangeAsync("stop", "telegram");
            else
            {
                var next = config.CurrentChannels();
                if (action == "disable-save")
                    next["telegram"]!["enabled"] = false;
                var saved = await config.SaveChannelsAsync(next);
                Assert.True(saved["saved"]!.GetValue<bool>());
                Assert.Contains("channels", saved["applied"]!.AsArray().Select(value => value!.ToString()));
                if (action == "failed-reload")
                    Assert.Contains("channels.telegram", saved["notApplied"]!.AsArray().Select(value => value!.ToString()));
                else
                    Assert.Empty(saved["notApplied"]!.AsArray());
            }
            release.TrySetResult();
            await config.ManagedChannels!.StartInitialAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(action is "enabled-save" or "failed-reload" ? 2 : 1, commands);
            Assert.Equal(action == "enabled-save", Status(config, "telegram")["running"]!.GetValue<bool>());
            if (action != "enabled-save")
                Assert.DoesNotContain(peer.Calls, call => call.Method == "getUpdates");
            if (action == "explicit-stop")
            {
                // Stopping initial intent must not disable a later explicit start.
                await config.ManagedChannels.ChangeAsync("start", "telegram");
                Assert.Equal(2, commands);
                Assert.True(Status(config, "telegram")["running"]!.GetValue<bool>());
            }
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Theory]
    [InlineData(4914)]
    [InlineData(4915)]
    public async Task QQ_terminal_rejection_is_visible_without_redefining_registry_running_as_account_health(
        int closeCode
    )
    {
        using var temp = new TempDirectory();
        await using var peer = await QQBotPeer.StartAsync();
        var (host, config) = await MainAsync(
            temp,
            new() { ["qq"] = peer.Config() },
            peer.Dependencies
        );
        await using var ownedHost = host;
        await host.StartAsync().WaitAsync(TimeSpan.FromSeconds(10));
        await config.ManagedChannels!.StartInitialAsync().WaitAsync(TimeSpan.FromSeconds(10));
        await TelegramChannelTests.Until(() =>
            peer.Frames.Any(frame => frame["op"]!.ToString() == "2")
        );
        var socket = peer.Sockets.Single().Value;
        await socket.CloseOutputAsync(
            (WebSocketCloseStatus)closeCode,
            "secret-vendor-close-reason",
            default
        );
        await TelegramChannelTests.Until(() => Status(config, "qq")["lastError"] is not null);
        var status = Status(config, "qq");
        Assert.True(status["running"]!.GetValue<bool>());
        Assert.Contains(closeCode.ToString(), status["lastError"]!.ToString());
        Assert.DoesNotContain("secret", status["lastError"]!.ToString());
        Assert.Single(peer.Calls, call => call.Path == "/gateway");
        Assert.Equal(1, peer.Connections);
    }

    [Fact]
    public async Task Dynamic_reload_retains_sequential_start_and_does_not_apply_initial_retries()
    {
        await using var qq = await QQBotPeer.StartAsync();
        await using var telegram = await TelegramPeer.StartAsync();
        var reached = Signal();
        var release = Signal();
        var telegramConstructed = false;
        qq.Respond = async call =>
        {
            if (call.Path != "/app/getAppAccessToken")
                return null;
            reached.TrySetResult();
            await release.Task;
            return Results.StatusCode(401);
        };
        await using var fixture = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = qq.Config(), ["telegram"] = ExternalChannelFixture.Channel() },
            dependencies: telegram.Dependencies with
            {
                CreateQQBotHttp = qq.Dependencies.CreateQQBotHttp,
                TelegramApi = token =>
                {
                    telegramConstructed = true;
                    return telegram.Dependencies.TelegramApi!(token);
                },
            }
        );
        var reload = fixture.Manager.ManagedChannels!.ReloadAsync();
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(telegramConstructed);
            release.TrySetResult();
            var result = await reload.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("telegram", Assert.Single(result["started"]!.AsArray())!.ToString());
            Assert.Single(qq.Calls, call => call.Path == "/app/getAppAccessToken");
        }
        finally
        {
            release.TrySetResult();
            await reload;
        }
    }
}
