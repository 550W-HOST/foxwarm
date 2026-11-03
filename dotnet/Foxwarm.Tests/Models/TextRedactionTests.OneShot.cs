using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    [Fact]
    public async Task ToolScript_requests_in_distinct_sessions_share_keys_and_restore_their_results()
    {
        const string secret = "shared-private-value";
        await using var detector = await TextDetectionPeer.StartAsync(secret);
        var keys = new List<string>();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (_, stream, request) =>
            {
                var body = JsonNode.Parse(request.Body)!;
                var key = body["input"]![0]!["content"]![0]!["text"]!.GetValue<string>();
                keys.Add(key);
                var response = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = key }
                                ),
                            }
                        ),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + response.ToJsonString() + "\n\n")
                );
            }
        );
        using var temp = new TempDirectory();
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.BaseUri, "unused", "unused", "", "", 100),
            Catalog(detector.Endpoint, peer.BaseUri)
        );
        await manager.LoadMainHostAsync();
        foreach (var name in new[] { "first", "second" })
        {
            var owner = await manager.CreateNamedAsync("main", name, null, null);
            var result = await manager.RequestToolScriptModelAsync(
                owner,
                secret,
                "p/m",
                new Foxwarm.ToolScript.ToolScriptDataBudget(),
                default
            );
            Assert.Equal(secret, SessionWait.Text(result["text"]));
        }
        Assert.StartsWith("[[FW_PRIVATE_", keys[0]);
        Assert.Equal(keys[0], keys[1]);
        Assert.Single(detector.Texts);
    }
}
