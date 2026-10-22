using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WeixinCommitOrderingTests
{
    [Fact]
    public async Task Concurrent_normal_Setup_and_shared_command_confirmations_preserve_both_logins_and_only_Setup_owner()
    {
        using var temp = new TempDirectory();
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var serial = 0;
        var waiting = 0;
        var both = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (call.Path.EndsWith("/get_bot_qrcode", StringComparison.Ordinal))
                return Results.Json(
                    new
                    {
                        qrcode = "qr-" + Interlocked.Increment(ref serial),
                        qrcode_img_content = "synthetic-qr",
                    }
                );
            if (!call.Path.EndsWith("/get_qrcode_status", StringComparison.Ordinal))
                return null;
            if (Interlocked.Increment(ref waiting) == 2)
                both.TrySetResult();
            await both.Task.WaitAsync(TimeSpan.FromSeconds(5));
            return Results.Json(
                new
                {
                    status = "confirmed",
                    bot_token = "token-" + call.Query["qrcode"],
                    ilink_user_id = "owner-" + call.Query["qrcode"],
                    baseurl = peer.Address.ToString(),
                }
            );
        };
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        var channels = new JsonObject
        {
            ["wx-first"] = peer.Weixin("initial-first"),
            ["weixin"] = peer.Weixin("initial-default"),
        };
        channels["wx-first"]!["enabled"] = false;
        channels["wx-first"]!["custom"] = "preserve";
        channels["weixin"]!["enabled"] = false;
        var raw =
            "# retained YAML comment\nother:\n  preserve: true\nchannels:\n"
            + string.Join(
                    "\n",
                    ModelConfiguration
                        .ChannelsYamlForObject(channels)
                        .TrimEnd()
                        .Split('\n')
                        .Select(line => "  " + line)
                )
                .Replace("\n  weixin:", "\n# between Weixin entries\n  weixin:")
            + "\n\n# retained following section\nlast: {preserve: true}\n";
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), raw);
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        var configuration = new ModelConfiguration(data);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            configuration,
            settings,
            null
        );
        await host.StartAsync();
        using var http = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        http.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        async Task<JsonObject> Post(string path, object body)
        {
            using var response = await http.PostAsJsonAsync(path, body);
            response.EnsureSuccessStatusCode();
            return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        }
        var session = await Post("api/sessions", new { agentId = "main", sessionId = "chat" });
        var route =
            "api/sessions/"
            + Uri.EscapeDataString(SessionWait.Text(session["sessionId"])!)
            + "/message";
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (attempt > 0)
                await Post("api/setup/config", new { yaml = raw });
            waiting = 0;
            both = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var commandLogin = await Post(
                "api/setup/weixin/login/start",
                new { channelId = "weixin" }
            );
            var setupLogin = await Post("api/setup/weixin/login/start", new { });
            Assert.Equal("wx-first", SessionWait.Text(setupLogin["channelId"]));
            var confirmSetup = Post(
                "api/setup/weixin/login/wait",
                new { sessionKey = SessionWait.Text(setupLogin["sessionKey"]) }
            );
            var confirmCommand = Post(
                route,
                new
                {
                    text = "/channel weixin wait " + SessionWait.Text(commandLogin["sessionKey"]),
                }
            );
            var results = await Task.WhenAll(confirmSetup, confirmCommand);
            Assert.True(SessionCatalog.Flag(results[0]["connected"]));
            var current = configuration.CurrentChannels();
            var commandQr = "qr-" + (attempt * 2 + 1);
            var setupQr = "qr-" + (attempt * 2 + 2);
            Assert.Equal("token-" + setupQr, SessionWait.Text(current["wx-first"]!["token"]));
            Assert.Equal("token-" + commandQr, SessionWait.Text(current["weixin"]!["token"]));
            Assert.True(SessionCatalog.Flag(current["wx-first"]!["enabled"]));
            Assert.True(SessionCatalog.Flag(current["weixin"]!["enabled"]));
            Assert.Equal(
                new[] { "alice", "bob", "owner-" + setupQr },
                SessionWait.Strings(current["wx-first"]!["allowedUsers"])
            );
            Assert.Equal(
                new[] { "alice", "bob" },
                SessionWait.Strings(current["weixin"]!["allowedUsers"])
            );
            Assert.Equal("preserve", SessionWait.Text(current["wx-first"]!["custom"]));
            var saved = await File.ReadAllTextAsync(configuration.AppPath);
            Assert.Contains("# retained YAML comment", saved);
            Assert.Contains("# retained following section\nlast: {preserve: true}", saved);
            Assert.Equal(2, current.Count);
            Assert.True(
                SessionCatalog.Flag(ConfigurationYaml.Parse(saved, "app")["other"]!["preserve"])
            );
            Assert.True((await http.GetAsync("api/setup/status")).IsSuccessStatusCode);
        }
    }
}
