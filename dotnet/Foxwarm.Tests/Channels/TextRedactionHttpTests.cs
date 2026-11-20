using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class TextRedactionHttpTests
{
    private const string Reply =
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}],\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":0},\"output_tokens\":5}}}\n\n";

    [Fact]
    public async Task Sent_version_usage_and_turn_summary_respect_session_scope()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice Zhang");
        detector.Labels["Alice Zhang"] = "private_person";
        await using var provider = new ScriptedResponsesSequenceServer(
            4,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Reply)
                )
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            """
            access:
              identities:
                reader:
                  token: synthetic-redaction-reader
                  surfaces:
                    webui: {sessions: [lead]}
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            $"""
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: {provider.BaseUri}
                models: [wire]
                textRedaction: {"{"}enabled: true, endpoint: '{detector.Endpoint}'{"}"}
              plain:
                providerType: openai-responses
                baseUrl: {provider.BaseUri}
                models: [open]
            """
        );
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-redaction-reader");
        foreach (var name in new[] { "lead", "other" })
        {
            var created = await admin.PostAsJsonAsync(
                "api/sessions",
                new { agentId = "main", sessionId = name }
            );
            Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        }
        var state = JsonNode.Parse(await admin.GetStringAsync("api/sessions/lead/state"))!;
        Assert.True(state["session"]!["textRedaction"]!.GetValue<bool>());

        var sent = await admin.PostAsJsonAsync(
            "api/sessions/lead/message",
            new { text = "Please greet Alice Zhang" }
        );
        Assert.Equal(HttpStatusCode.Accepted, sent.StatusCode);
        JsonObject? reply = null;
        long userSeq = 0;
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (reply is null && DateTime.UtcNow < deadline)
        {
            var history = JsonNode.Parse(await admin.GetStringAsync("api/sessions/lead/history"))!;
            foreach (var message in history["messages"]!.AsArray().OfType<JsonObject>())
            {
                if (
                    message["role"]?.GetValue<string>() == "user"
                    && message.ToJsonString().Contains("Alice Zhang", StringComparison.Ordinal)
                )
                    userSeq = message["__meta"]!["seq"]!.GetValue<long>();
                if (message["__meta"]?["textRedaction"] is JsonObject)
                    reply = message;
            }
            if (reply is null)
                await Task.Delay(50);
        }
        Assert.NotNull(reply);
        Assert.True(userSeq > 0);
        var summary = reply!["__meta"]!["textRedaction"]!;
        Assert.Equal(1, summary["labels"]!["private_person"]!["detected"]!.GetValue<int>());
        Assert.True(summary["slots"]!.GetValue<int>() > 1);

        var calls = detector.Texts.Count;
        var route = $"api/sessions/lead/messages/{userSeq}/redaction";
        var view = JsonNode.Parse(await admin.GetStringAsync(route))!.AsObject();
        Assert.True(view["enabled"]!.GetValue<bool>());
        var slot = view["slots"]!
            .AsArray()
            .Single(item =>
                item!["text"]!.GetValue<string>().Contains("Alice Zhang", StringComparison.Ordinal)
            )!;
        Assert.True(slot["available"]!.GetValue<bool>());
        var range = slot["ranges"]![0]!;
        Assert.Equal(
            "Alice Zhang",
            slot["text"]!
                .GetValue<string>()
                .Substring(range["start"]!.GetValue<int>(), range["length"]!.GetValue<int>())
        );
        Assert.Equal(calls, detector.Texts.Count);

        // Scoped identities see their own Session only.
        Assert.Equal(HttpStatusCode.OK, (await scoped.GetAsync(route)).StatusCode);
        var otherSeq = JsonNode.Parse(await admin.GetStringAsync("api/sessions/other/history"))![
            "messages"
        ]!
            .AsArray()
            .Select(item => item?["__meta"]?["seq"]?.GetValue<long>())
            .FirstOrDefault(value => value is not null);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await scoped.GetAsync($"api/sessions/other/messages/{otherSeq ?? 1}/redaction")
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await admin.GetAsync("api/sessions/lead/messages/999999/redaction")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await admin.GetAsync("api/sessions/lead/messages/x/redaction")).StatusCode
        );

        // Installation usage carries the same counts; a Session on a plain model has none.
        var usage = JsonNode
            .Parse(
                await admin.GetStringAsync("api/usage?boundaries=0,9999999999999&groupBy=model")
            )!
            .AsObject();
        var redaction = usage["total"]!["redaction"]!;
        Assert.True(redaction["attempts"]!.GetValue<long>() >= 1);
        Assert.True(redaction["labels"]!["private_person"]!.GetValue<long>() >= 1);
        Assert.Empty(redaction["failures"]!.AsObject());
        Assert.NotNull(
            usage["groups"]!
                .AsArray()
                .Single(group => group!["key"]!.GetValue<string>() == "local/wire")!["usage"]![
                "redaction"
            ]
        );
        var plain = await admin.PostAsJsonAsync(
            "api/sessions/other/model",
            new { model = "plain/open" }
        );
        Assert.True(plain.IsSuccessStatusCode, await plain.Content.ReadAsStringAsync());
        var otherState = JsonNode.Parse(await admin.GetStringAsync("api/sessions/other/state"))!;
        Assert.Null(otherState["session"]!["textRedaction"]);
    }
}
