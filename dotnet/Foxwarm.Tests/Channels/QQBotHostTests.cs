using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class QQBotHostTests
{
    [Fact]
    public async Task Normal_Main_provider_followup_attachments_canonical_history_generated_media_and_Setup_reload_keep_latest_passive_local()
    {
        using var temp = new TempDirectory();
        await using var peer = await QQBotPeer.StartAsync();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var provider = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
            {
                if (index == 0)
                    await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                var output = new JsonArray(
                    TelegramHostTests.Output(
                        index == 0 ? "QQ intermediate answer" : "QQ final answer"
                    )
                );
                if (index == 1)
                    output.Add(
                        new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["id"] = "generated-QQ-fixture",
                            ["status"] = "completed",
                            ["output_format"] = "jpeg",
                            ["result"] = Convert.ToBase64String(TelegramChannelTests.Jpeg()),
                        }
                    );
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    WeWorkTurnTests.Complete(output)
                );
            }
        );
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        var channels = new JsonObject { ["qq"] = peer.Config() };
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            new JsonObject { ["channels"] = channels.DeepClone() }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: '{provider.BaseUri}'\n    models: [wire]\n"
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        var configuration = new ModelConfiguration(data);
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? Directory.GetCurrentDirectory();
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            configuration,
            settings,
            Path.Combine(root, "packages", "webui", "dist"),
            channelDependencies: peer.Dependencies
        );
        await host.StartAsync();
        using var http = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        http.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var created = await http.PostAsJsonAsync(
            "api/sessions",
            new { agentId = "main", sessionId = "qq-source" }
        );
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonObject>())![
            "sessionId"
        ]!.GetValue<string>();
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("attach", "/attach " + id));
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message("attach-other", "/attach " + id, group: "other")
        );
        await TelegramChannelTests.Until(() => peer.Sent.Count() == 2);
        peer.Push(
            "GROUP_AT_MESSAGE_CREATE",
            QQBotPeer.Message("qq-first", "QQ original first input")
        );
        var first = await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Contains("group-message", first.Body);
        Assert.Contains("channelInstanceId=", first.Body);
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("qq-busy", "QQ busy followup 用户"));
        await TelegramChannelTests.Until(() =>
            File.ReadAllText(Path.Combine(data, "state", "sessions", id + ".json"))
                .Contains("QQ busy followup", StringComparison.Ordinal)
        );
        release.TrySetResult();
        var second = await provider.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Contains("QQ busy followup", second.Body);
        Assert.Contains("group-message", second.Body);
        await TelegramChannelTests.Until(() =>
            peer.Sent.Count(call => call.Body["content"]?.ToString() == "QQ final answer") == 2
            && peer.Sent.Count(call => call.Body["msg_type"]?.ToString() == "7") == 2
        );
        var modelText = peer
            .Sent.Where(call =>
                call.Body["content"]?.ToString() is "QQ intermediate answer" or "QQ final answer"
            )
            .ToArray();
        Assert.Equal(4, modelText.Length);
        Assert.All(
            modelText.Where(call => call.Path.Contains("/room/", StringComparison.Ordinal)),
            call => Assert.Equal("qq-busy", call.Body["msg_id"]!.ToString())
        );
        Assert.All(
            modelText.Where(call => call.Path.Contains("/other/", StringComparison.Ordinal)),
            call => Assert.Equal("attach-other", call.Body["msg_id"]!.ToString())
        );
        var history = await http.GetFromJsonAsync<JsonObject>(
            "api/sessions/" + Uri.EscapeDataString(id) + "/history"
        );
        var rows = history!["messages"]!.AsArray();
        Assert.Equal(2, rows.Count(row => SessionWait.Text(row?["role"]) == "user"));
        Assert.Equal(2, rows.Count(row => SessionWait.Text(row?["role"]) == "model"));
        Assert.DoesNotContain("qqbotMessageId", history.ToJsonString());
        Assert.DoesNotContain("qq-busy", history.ToJsonString());
        Assert.Contains(
            rows,
            row =>
                (row?["parts"] as JsonArray ?? []).Any(part => part?["inlineDataRef"] is not null)
        );
        if (Environment.GetEnvironmentVariable("FOXWARM_QQBOT_BROWSER") == "1")
        {
            var start = new ProcessStartInfo("node")
            {
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add(Path.Combine(root, "dotnet", "qqbot-browser.mjs"));
            foreach (var arg in new[] { settings.Address.BaseUrl, settings.Token, id })
                start.ArgumentList.Add(arg);
            using var browser = Process.Start(start)!;
            var stdout = browser.StandardOutput.ReadToEndAsync();
            var stderr = browser.StandardError.ReadToEndAsync();
            await browser.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(45));
            Assert.True(browser.ExitCode == 0, await stdout + "\n" + await stderr);
            Console.WriteLine(await stdout);
        }
        var setup = await http.PostAsJsonAsync(
            "api/setup/channels",
            new JsonObject { ["channels"] = channels.DeepClone() }
        );
        setup.EnsureSuccessStatusCode();
        var installed = (await setup.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Single(installed["reload"]!["started"]!.AsArray());
        Assert.Single(installed["reload"]!["stopped"]!.AsArray());
        var status = await http.GetFromJsonAsync<JsonObject>("api/setup/status");
        Assert.NotNull(status);
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("after-reload", "/whoami"));
        await TelegramChannelTests.Until(() =>
            peer.Sent.Any(call => SessionWait.Text(call.Body["msg_id"]) == "after-reload")
        );
    }
}
