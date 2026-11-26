using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TextRedactionNativeTests
{
    [Fact]
    public async Task Native_text_runs_restore_split_placeholders_and_replay_redacted_after_restart()
    {
        const string original = "ExamplePerson";
        await using var detector = await TextDetectionPeer.StartAsync(original);
        var requests = new List<JsonObject>();
        string? key = null;
        await using var provider = new ScriptedResponsesSequenceServer(
            3,
            async (_, connection, request) =>
            {
                var body = JsonNode.Parse(request.Body)!.AsObject();
                requests.Add(body);
                JsonArray output;
                if (requests.Count == 1)
                {
                    key = Regex
                        .Match(body["messages"]!.ToJsonString(), @"\[\[PRIVATE_[0-9a-f]{16}\]\]")
                        .Value;
                    output = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "text",
                            ["text"] = "Report " + key[..13],
                            ["citations"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "web_search_result_location",
                                    ["url"] = "https://example.test/page",
                                    ["title"] = "Source",
                                    ["encrypted_index"] = "opaque-index",
                                }
                            ),
                        },
                        new JsonObject { ["type"] = "text", ["text"] = key[13..] + " done." }
                    );
                }
                else
                {
                    var assistant = body["messages"]!
                        .AsArray()
                        .Single(message => SessionWait.Text(message?["role"]) == "assistant")!;
                    var blocks = assistant["content"]!.AsArray().OfType<JsonObject>().ToArray();
                    var text = string.Concat(
                        blocks
                            .Where(block => SessionWait.Text(block["type"]) == "text")
                            .Select(block => SessionWait.Text(block["text"]))
                    );
                    Assert.DoesNotContain(original, text);
                    Assert.Equal("Report " + key + " done.", text);
                    Assert.Equal(
                        "opaque-index",
                        blocks[0]["citations"]![0]!["encrypted_index"]!.GetValue<string>()
                    );
                    output = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = key });
                }
                await LoopbackResponsesServer.WriteResponseAsync(
                    connection,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        new JsonObject
                        {
                            ["content"] = output,
                            ["stop_reason"] = "end_turn",
                        }.ToJsonString()
                    )
                );
            }
        );
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["defaults"] = new JsonObject
                {
                    ["textRedaction"] = new JsonObject { ["knownLabels"] = "all" },
                },
                ["providers"] = new JsonObject
                {
                    ["p"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = provider.BaseUri.ToString(),
                        ["models"] = new JsonArray("m"),
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                        ["textRedaction"] = TextRedactionTests.Settings(detector.Endpoint),
                    },
                },
            },
            new()
        );
        using var root = new TempDirectory();
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        async Task<ChatResult> Request(InstanceSecrets secrets, JsonObject[] history)
        {
            var owner = new ModelRequestOwner(
                http,
                new(provider.BaseUri, "m", "p/m", "", "", 100, null),
                new(),
                secrets: secrets
            );
            return await owner.RequestAsync(
                "s",
                owner.Capture(catalog, "p/m", null),
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult("instructions"),
                null,
                null,
                null,
                null,
                default,
                maxAttempts: 1
            );
        }
        static JsonObject User(string text) =>
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            };
        JsonObject[] replay;
        using (var secrets = TextRedactionKeys.AllLabels(root.Path))
        {
            var first = await Request(secrets, [User(original)]);
            var assistant = first.AssistantMessage!;
            Assert.Equal(
                "Report " + original + " done.",
                SessionWait.Text(assistant["parts"]![0]!["text"])
            );
            var native = assistant["parts"]![0]!["providerMeta"]!["anthropic"]![
                "contentBlocks"
            ]!.AsArray();
            Assert.Equal("Report " + original, SessionWait.Text(native[0]!["text"]));
            Assert.Equal(" done.", SessionWait.Text(native[1]!["text"]));
            native[0]!["text"] = "Report " + original[..5];
            native[1]!["text"] = original[5..] + " done.";
            replay = [assistant, User("continue")];
            var preserved = new JsonArray(replay.Select(row => row.DeepClone()).ToArray());
            detector.Transform = response =>
            {
                response["entities"] = new JsonArray();
                return response;
            };
            var second = await Request(secrets, replay);
            Assert.Equal(
                original,
                SessionWait.Text(second.AssistantMessage!["parts"]![0]!["text"])
            );
            Assert.True(
                JsonNode.DeepEquals(
                    preserved,
                    new JsonArray(replay.Select(row => row.DeepClone()).ToArray())
                )
            );
        }
        var calls = detector.Texts.Count;
        using (var restarted = TextRedactionKeys.AllLabels(root.Path))
        {
            var third = await Request(restarted, replay);
            Assert.Equal(original, SessionWait.Text(third.AssistantMessage!["parts"]![0]!["text"]));
        }
        Assert.Equal(calls, detector.Texts.Count);
        Assert.True(JsonNode.DeepEquals(requests[1], requests[2]));
    }
}
