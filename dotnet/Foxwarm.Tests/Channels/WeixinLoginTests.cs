using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WeixinLoginTests
{
    [Fact]
    public async Task Qr_reuse_force_five_minute_TTL_scaned_expiry_timeout_and_failed_fetch_follow_the_actual_wire()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var now = DateTimeOffset.UtcNow;
        var api = new WeixinApi(
            new(
                Now: () => now,
                Delay: (duration, _) =>
                {
                    now += duration;
                    return Task.CompletedTask;
                }
            )
        );
        var first = await api.StartLoginAsync(peer.Address.ToString(), "9", " route ", "same");
        Assert.Equal("same", SessionWait.Text(first["sessionKey"]));
        Assert.Equal(
            SessionWait.Text(first["qrcodeUrl"]),
            SessionWait.Text(
                (await api.StartLoginAsync(peer.Address.ToString(), sessionKey: "same"))[
                    "qrcodeUrl"
                ]
            )
        );
        Assert.Single(peer.Calls);
        await api.StartLoginAsync(peer.Address.ToString(), sessionKey: "same", force: true);
        Assert.Equal(2, peer.Calls.Count);
        now += TimeSpan.FromMinutes(5);
        var expired = await api.WaitLoginAsync("same", peer.Address.ToString());
        Assert.False(expired.Connected);
        Assert.Contains("过期", expired.Message);
        Assert.Equal(2, peer.Calls.Count);
        await api.StartLoginAsync(peer.Address.ToString(), sessionKey: "same");
        var statuses = new Queue<string>(["scaned", "wait", "confirmed"]);
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.EndsWith("/get_qrcode_status", StringComparison.Ordinal)
                    ? Results.Json(
                        new
                        {
                            status = statuses.Dequeue(),
                            bot_token = "token",
                            ilink_user_id = "owner",
                            baseurl = "http://127.0.0.1:12345/returned",
                        }
                    )
                    : null
            );
        var confirmed = await api.WaitLoginAsync("same", peer.Address.ToString(), "route");
        Assert.True(confirmed.Connected);
        Assert.Equal("token", confirmed.BotToken);
        Assert.Equal("owner", confirmed.UserId);
        Assert.EndsWith("/returned", confirmed.BaseUrl);
        Assert.False((await api.WaitLoginAsync("same", peer.Address.ToString())).Connected);
        Assert.Equal("9", peer.Calls.First().Query["bot_type"]);
        Assert.Equal("route", peer.Calls.First().Headers["SKRouteTag"]);
        Assert.Equal("", peer.Calls.First().Key);
        Assert.All(
            peer.Calls.Where(call =>
                call.Path.EndsWith("/get_qrcode_status", StringComparison.Ordinal)
            ),
            call =>
            {
                Assert.Equal("synthetic QR?code", call.Query["qrcode"]);
                Assert.Equal("1", call.Headers["iLink-App-ClientVersion"]);
                Assert.Equal("", call.Key);
            }
        );
        peer.Respond = null;
        peer.QrStatus = "wait";
        await api.StartLoginAsync(peer.Address.ToString(), sessionKey: "timeout");
        var pending = await api.WaitLoginAsync("timeout", peer.Address.ToString(), timeoutMs: 1);
        Assert.False(pending.Connected);
        Assert.Contains("仍未完成", pending.Message);
        peer.QrStatus = "confirmed";
        Assert.True((await api.WaitLoginAsync("timeout", peer.Address.ToString())).Connected);
        peer.QrStatus = "expired";
        await api.StartLoginAsync(peer.Address.ToString(), sessionKey: "wire-expired");
        Assert.Contains(
            "过期",
            (await api.WaitLoginAsync("wire-expired", peer.Address.ToString())).Message
        );
        peer.Respond = call =>
            Task.FromResult<IResult?>(Results.Text("controlled QR failure", statusCode: 503));
        await Assert.ThrowsAsync<IOException>(() => api.StartLoginAsync(peer.Address.ToString()));
    }

    [Fact]
    public async Task Real_normal_Main_prefixed_Setup_and_Matrix_command_preserve_authorization_merge_and_all_vs_selected_restart()
    {
        using var temp = new TempDirectory();
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var telegram = await TelegramPeer.StartAsync();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        var channels = new JsonObject
        {
            ["alpha"] = peer.Matrix(),
            ["telegram"] = ExternalChannelFixture.Channel(),
            ["wx-first"] = peer.Weixin("first-token"),
            ["weixin"] = peer.Weixin("default-token"),
        };
        channels["wx-first"]!["custom"] = "preserve";
        channels["weixin"]!["allowedUsers"] = new JsonArray("existing-user");
        var app = new JsonObject
        {
            ["channels"] = channels,
            ["other"] = new JsonObject { ["preserve"] = true },
            ["access"] = new JsonObject
            {
                ["identities"] = new JsonObject
                {
                    ["scoped"] = new JsonObject
                    {
                        ["token"] = "synthetic-scoped",
                        ["surfaces"] = new JsonObject
                        {
                            ["webui"] = new JsonObject { ["sessions"] = new JsonArray("chat") },
                        },
                    },
                },
            },
        };
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            app.ToJsonString()
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        settings = settings with
        {
            Address = new PublicWebAddress(
                settings.Address.Origin,
                new PathString("/nested/app"),
                "/nested/app/",
                false
            ),
        };
        var configuration = new ModelConfiguration(data);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            configuration,
            settings,
            null,
            channelDependencies: telegram.Dependencies
        );
        await host.StartAsync();
        using var http = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        foreach (var token in new[] { "", "synthetic-scoped" })
        {
            http.DefaultRequestHeaders.Authorization =
                token.Length == 0 ? null : new("Bearer", token);
            foreach (var action in new[] { "start", "wait" })
                Assert.Equal(
                    token.Length == 0 ? 401 : 403,
                    (int)
                        (
                            await http.PostAsJsonAsync(
                                "api/setup/weixin/login/" + action,
                                new { sessionKey = "fake" }
                            )
                        ).StatusCode
                );
        }
        Assert.DoesNotContain(
            peer.Calls,
            call => call.Path.Contains("qrcode", StringComparison.Ordinal)
        );
        http.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var start = await http.PostAsJsonAsync("api/setup/weixin/login/start", new { });
        start.EnsureSuccessStatusCode();
        var login = (await start.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("wx-first", SessionWait.Text(login["channelId"]));
        Assert.Null(login["botToken"]);
        var confirmation = await http.PostAsJsonAsync(
            "api/setup/weixin/login/wait",
            new { sessionKey = SessionWait.Text(login["sessionKey"]) }
        );
        confirmation.EnsureSuccessStatusCode();
        var result = (await confirmation.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(SessionCatalog.Flag(result["connected"]));
        Assert.Equal(4, result["reload"]!["started"]!.AsArray().Count);
        Assert.Null(result["botToken"]);
        var current = configuration.CurrentChannels();
        Assert.Equal("confirmed-token", SessionWait.Text(current["wx-first"]!["token"]));
        Assert.Contains("owner", SessionWait.Strings(current["wx-first"]!["allowedUsers"]));
        Assert.Equal("preserve", SessionWait.Text(current["wx-first"]!["custom"]));
        Assert.Equal(2, telegram.Calls.Count(call => call.Method == "setMyCommands"));
        var matrixVersions = peer.Calls.Count(call =>
            call.Key == "matrix-a" && call.Path.EndsWith("/versions", StringComparison.Ordinal)
        );
        Assert.Equal(2, matrixVersions);
        peer.MatrixEvents(
            "matrix-a",
            "!command:fixture",
            ExternalProtocolPeer.MatrixText("login-command", "/channel weixin login")
        );
        await TelegramChannelTests.Until(() =>
            peer.Sent("matrix-a")
                .Any(call =>
                    SessionWait
                        .Text(call.Body["body"])
                        ?.Contains("sessionKey:", StringComparison.Ordinal) == true
                )
        );
        var commandReply = peer.Sent("matrix-a")
            .Select(call => SessionWait.Text(call.Body["body"]) ?? "")
            .Single(text => text.Contains("sessionKey:", StringComparison.Ordinal));
        var key = Regex.Match(commandReply, "sessionKey: `([^`]+)`").Groups[1].Value;
        Assert.NotEmpty(key);
        peer.Owner = "command-owner";
        peer.MatrixEvents(
            "matrix-a",
            "!command:fixture",
            ExternalProtocolPeer.MatrixText("wait-command", "/channel weixin wait " + key)
        );
        await TelegramChannelTests.Until(() =>
            peer.Sent("matrix-a")
                .Any(call =>
                    SessionWait
                        .Text(call.Body["body"])
                        ?.Contains("login completed", StringComparison.Ordinal) == true
                )
        );
        current = configuration.CurrentChannels();
        Assert.Equal("confirmed-token", SessionWait.Text(current["weixin"]!["token"]));
        Assert.Equal(
            new[] { "existing-user" },
            SessionWait.Strings(current["weixin"]!["allowedUsers"])
        );
        Assert.Equal(2, telegram.Calls.Count(call => call.Method == "setMyCommands"));
        Assert.Equal(
            matrixVersions,
            peer.Calls.Count(call =>
                call.Key == "matrix-a" && call.Path.EndsWith("/versions", StringComparison.Ordinal)
            )
        );
        Assert.True(
            SessionCatalog.Flag(
                ConfigurationYaml.Parse(await File.ReadAllTextAsync(configuration.AppPath), "app")[
                    "other"
                ]!["preserve"]
            )
        );
        Assert.True((await http.GetAsync("api/setup/status")).IsSuccessStatusCode);
        Assert.Equal(
            400,
            (int)(await http.PostAsJsonAsync("api/setup/weixin/login/wait", new { })).StatusCode
        );
        await host.DisposeAsync();
    }

    [Fact]
    public async Task Qr_status_long_poll_keeps_its_real_35_second_timeout_even_when_the_caller_deadline_is_shorter()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var api = new WeixinApi(null);
        var start = await api.StartLoginAsync(peer.Address.ToString());
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (!call.Path.EndsWith("/get_qrcode_status", StringComparison.Ordinal))
                return null;
            await release.Task;
            return Results.Json(new { status = "wait" });
        };
        var watch = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            var result = await api.WaitLoginAsync(
                    SessionWait.Text(start["sessionKey"])!,
                    peer.Address.ToString(),
                    timeoutMs: 1000
                )
                .WaitAsync(TimeSpan.FromSeconds(45));
            Assert.False(result.Connected);
            Assert.InRange(watch.Elapsed.TotalSeconds, 35, 42);
        }
        finally
        {
            release.TrySetResult();
        }
    }
}
