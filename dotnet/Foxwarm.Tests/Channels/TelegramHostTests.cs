using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TelegramHostTests
{
    private static byte[] Completed(JsonArray output) =>
        Encoding.UTF8.GetBytes(
            "data: "
                + new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "fixture-response",
                        ["status"] = "completed",
                        ["output"] = output,
                    },
                }.ToJsonString()
                + "\n\n"
        );

    internal static JsonObject Output(string text) =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = text }
            ),
        };

    [Fact]
    public async Task Normal_Main_provider_path_delivers_no_tool_followup_once_generated_image_and_typing_skips_send_only_and_keeps_WebUI_history_single()
    {
        using var temp = new TempDirectory();
        await using var peer = await TelegramPeer.StartAsync();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var provider = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
            {
                if (index == 0)
                    await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                var output = new JsonArray(Output(index == 0 ? "first-result" : "final-result"));
                if (index == 1)
                    output.Add(
                        new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["id"] = "generated-fixture",
                            ["status"] = "completed",
                            ["output_format"] = "jpeg",
                            ["result"] = Convert.ToBase64String(TelegramChannelTests.Jpeg()),
                        }
                    );
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Completed(output)
                );
            }
        );
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        var channels = new JsonObject
        {
            ["alpha"] = ExternalChannelFixture.Channel(),
            ["beta"] = ExternalChannelFixture.Channel("b"),
        };
        var raw =
            "channels:\n"
            + string.Join(
                "\n",
                ModelConfiguration
                    .ChannelsYamlForObject(channels)
                    .TrimEnd()
                    .Split('\n')
                    .Select(line => "  " + line)
            )
            + "\n";
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), raw);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: '{provider.BaseUri}'\n    models: [wire]\n"
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        var config = new ModelConfiguration(data);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            config,
            settings,
            null,
            channelDependencies: peer.Dependencies
        );
        await host.StartAsync();
        using var http = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        http.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var created = await http.PostAsJsonAsync(
            "api/sessions",
            new { agentId = "main", sessionId = "source" }
        );
        created.EnsureSuccessStatusCode();
        var id = SessionWait.Text(
            (await created.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]
        )!;
        peer.Push("a", TelegramPeer.Text("-100", "11", "/attach " + id));
        peer.Push("b", TelegramPeer.Text("-100", "11", "/attach " + id));
        await TelegramChannelTests.Until(() => peer.Sent("a").Any() && peer.Sent("b").Any());
        peer.Push("b", TelegramPeer.Text("-100", "11", "/channel mode send-only"));
        await TelegramChannelTests.Until(() =>
            peer.Sent("b")
                .Any(call => (SessionWait.Text(call.Body["text"]) ?? "").Contains("mode set"))
        );
        using var events = await http.GetAsync(
            "api/sessions/" + Uri.EscapeDataString(id) + "/stream",
            HttpCompletionOption.ResponseHeadersRead
        );
        events.EnsureSuccessStatusCode();
        var bodyTask = events.Content.ReadAsStringAsync();
        var admitted = await http.PostAsJsonAsync(
            "api/sessions/" + Uri.EscapeDataString(id) + "/message",
            new { text = "first input" }
        );
        admitted.EnsureSuccessStatusCode();
        await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(15));
        peer.Push("a", TelegramPeer.Text("-100", "11", "  busy followup\n\tkept  "));
        await TelegramChannelTests.Until(() =>
        {
            var path = Path.Combine(data, "state", "sessions", id + ".json");
            return File.Exists(path)
                && (JsonNode.Parse(File.ReadAllText(path))!["queue"] as JsonArray)?.Count == 1;
        });
        release.TrySetResult();
        var followup = await provider.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Contains("busy followup", followup.Body);
        Assert.Contains("channelInstanceId=", followup.Body);
        await TelegramChannelTests.Until(() =>
            peer.Sent("a")
                .Count(call =>
                    SessionWait.Text(call.Body["text"]) is "first-result" or "final-result"
                ) == 2
            && peer.Sent("a", "sendPhoto").Any()
        );
        Assert.Single(
            peer.Sent("a"),
            call => SessionWait.Text(call.Body["text"]) == "first-result"
        );
        Assert.Single(
            peer.Sent("a"),
            call => SessionWait.Text(call.Body["text"]) == "final-result"
        );
        Assert.DoesNotContain(
            peer.Sent("b"),
            call => SessionWait.Text(call.Body["text"]) is "first-result" or "final-result"
        );
        Assert.Empty(peer.Sent("b", "sendPhoto"));
        Assert.NotEmpty(peer.Sent("a", "sendChatAction"));
        Assert.Empty(peer.Sent("b", "sendChatAction"));
        var history = await http.GetFromJsonAsync<JsonObject>(
            "api/sessions/" + Uri.EscapeDataString(id) + "/history"
        );
        Assert.Equal(
            2,
            history!["messages"]!.AsArray().Count(row => SessionWait.Text(row?["role"]) == "model")
        );
        Assert.Contains(
            history["messages"]!.AsArray(),
            row =>
                (row?["parts"] as JsonArray ?? []).Any(part => part?["inlineDataRef"] is not null)
        );
        // Self-restart is an actual bot command, not a call made outside the polling handler.
        var previousReplies = peer.Sent("a").Count();
        peer.Push("a", TelegramPeer.Text("-100", "11", "/channel restart alpha"));
        await TelegramChannelTests.Until(() =>
            peer.Calls.Count(call => call.Bot == "a" && call.Method == "setMyCommands") == 2
        );
        await TelegramChannelTests.Until(() =>
            peer.Sent("a").Skip(previousReplies)
                .Any(call => (SessionWait.Text(call.Body["text"]) ?? "").Contains("alpha"))
        );
        var setup = await http.PostAsJsonAsync(
            "api/setup/channels",
            new JsonObject { ["channels"] = channels.DeepClone() }
        );
        setup.EnsureSuccessStatusCode();
        var installation = (await setup.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.True(SessionCatalog.Flag(installation["reload"]!["available"]));
        Assert.Equal(2, installation["reload"]!["started"]!.AsArray().Count);
        Assert.True((await http.GetAsync("api/setup/status")).IsSuccessStatusCode);
        await host.DisposeAsync();
        var eventBody = await bodyTask.WaitAsync(TimeSpan.FromSeconds(10));
        var modelEvents = eventBody
            .Split('\n')
            .Where(line => line.StartsWith("data: {", StringComparison.Ordinal))
            .Select(line => JsonNode.Parse(line[6..])!)
            .Where(row => SessionWait.Text(row["message"]?["role"]) is "model" or "assistant")
            .ToArray();
        Assert.Equal(2, modelEvents.Length);
        Assert.All(
            modelEvents,
            row =>
                Assert.False(
                    SessionCatalog.Flag(row["message"]?["__meta"]?["isInstantNotification"])
                )
        );
    }
}
