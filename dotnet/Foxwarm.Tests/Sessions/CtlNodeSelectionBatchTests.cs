using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class CtlNodeSelectionBatchTests
{
    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static Task Respond(System.Net.Sockets.NetworkStream stream, JsonArray output) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject { ["output"] = output },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    // A failed `node select` through ctl skips the rest of the batch exactly like the builtin.
    [Theory]
    [InlineData("command")]
    [InlineData("malformed")]
    [InlineData("tool-call")]
    [InlineData("direct")]
    public async Task Failed_ctl_node_select_skips_later_calls_in_the_batch(string form)
    {
        ScriptFixture f = null!;
        var selection = form switch
        {
            "command" => Call("select", "ctl", new() { ["command"] = "node select missing-node" }),
            "malformed" => Call(
                "select",
                "ctl",
                new() { ["command"] = "node select missing-node extra" }
            ),
            "tool-call" => Call(
                "select",
                "ctl",
                CtlTestArgs.Unified(
                    new()
                    {
                        ["toolId"] = "builtin:node",
                        ["args"] = new JsonObject
                        {
                            ["action"] = "select",
                            ["nodeId"] = "missing-node",
                        },
                    }
                )
            ),
            _ => Call(
                "select",
                "node",
                new() { ["action"] = "select", ["nodeId"] = "missing-node" }
            ),
        };
        string? marker = null;
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
                await Respond(
                    stream,
                    index == 0
                        ? new JsonArray(
                            selection,
                            Call(
                                "later",
                                "write",
                                new() { ["filePath"] = marker, ["content"] = "must not run" }
                            )
                        )
                        : new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = "done" }
                                ),
                            }
                        )
                )
        );
        await using var fixture = await ScriptFixture.Create(
            suppliedOptions: new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713)
        );
        f = fixture;
        marker = Path.Combine(f.Work, "skipped.txt");
        await f.Owner.Entry.SaveLane.AdmitAsync(
            QueueItem.UserText("select and write"),
            SaveKind.Strict
        );
        await f
            .Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id)
            .WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(2, peer.RequestCount);
        Assert.False(File.Exists(marker));
        var results = f
            .Owner.History()
            .Where(row => SessionWait.Text(row["role"]) == "tool")
            .SelectMany(row => row["parts"]!.AsArray())
            .Select(part => part!["functionResponse"]!)
            .ToArray();
        Assert.NotNull(results[0]["response"]!["error"]);
        Assert.Contains(
            "Node selection failed",
            results[1]["response"]!["error"]!["message"]!.GetValue<string>()
        );
    }
}
