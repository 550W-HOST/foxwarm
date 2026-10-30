using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionProcessorContextTests
{
    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static Task Respond(System.Net.Sockets.NetworkStream stream, JsonObject output) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject { ["output"] = new JsonArray(output) },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    [Theory]
    [InlineData("direct-create")]
    [InlineData("script-create")]
    [InlineData("script-send")]
    public async Task Child_report_starts_a_foreground_wait_with_its_own_persisted_declaration(
        string launch
    )
    {
        using var temp = new TempDirectory();
        var releaseChild = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        SessionOwner child = null!;
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (index, stream, _) =>
            {
                JsonObject output;
                if (index == 0)
                {
                    var args = launch == "script-send"
                        ? new JsonObject
                        {
                            ["sessionId"] = child.Id,
                            ["message"] = "report to parent",
                            ["afterSend"] = "finish",
                        }
                        : new JsonObject
                        {
                            ["suffix"] = "worker",
                            ["message"] = "report to parent",
                            ["afterSend"] = "finish",
                        };
                    var name = launch == "script-send" ? "send_to_session" : "create_child_session";
                    output = launch == "direct-create"
                        ? Call("launch-direct", name, args)
                        : Call(
                            "launch-script",
                            "run_script",
                            new()
                            {
                                ["code"] = "return call_tool('" + name + "', args)",
                                ["args"] = args,
                            }
                        );
                }
                else if (index == 1)
                {
                    await releaseChild.Task.WaitAsync(TimeSpan.FromSeconds(20));
                    output = Call(
                        "child-report",
                        "send_to_session",
                        new()
                        {
                            ["sessionId"] = "<parent>",
                            ["message"] = "child reporting completion",
                            ["afterSend"] = "finish",
                        }
                    );
                }
                else if (index == 2)
                {
                    output = Call(
                        "foreground-wait",
                        "wait",
                        new()
                        {
                            ["waitAnySessions"] = new JsonArray(child.Id),
                            ["wakeIfNoActivityAfterSeconds"] = 3600,
                        }
                    );
                }
                else
                {
                    output = new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["content"] = new JsonArray(
                            new JsonObject { ["type"] = "output_text", ["text"] = "unexpected continuation" }
                        ),
                    };
                }
                await Respond(stream, output);
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        var data = Path.Combine(temp.Path, "data");
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        var parent = await manager.CreateNamedAsync("main", "main", null, null);
        if (launch == "script-send")
        {
            child = (
                await manager.CreateChildAsync(parent, "worker", null, null, null, null)
            ).Child;
        }
        await parent.Entry.SaveLane.AdmitAsync(QueueItem.UserText("start child"), SaveKind.Strict);
        await parent.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));
        child ??= manager.Find("worker")!;
        Assert.NotNull(child);
        await peer.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(20));

        // Report only after the launch script and its parent processor have finished.
        // The ordinary send starts the new parent processor from the child's context.
        releaseChild.TrySetResult();
        await child.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(20));
        await parent.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(20));

        Assert.Equal(3, peer.RequestCount);
        Assert.Null(parent.Entry.LastBackgroundProcessorFailure);
        Assert.Null(child.Entry.LastBackgroundProcessorFailure);
        Assert.False(parent.Entry.Snapshot().Busy);
        var wait = parent.WaitSnapshot();
        Assert.NotNull(wait);
        Assert.False(string.IsNullOrEmpty(SessionWait.Text(wait["id"])));
        Assert.Equal(3600, SessionWait.Number(wait["timeoutSeconds"]));
        Assert.Equal(new[] { child.Id }, SessionWait.Strings(wait["waitAnySessions"]));
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", parent.Id + ".json"))
        )!["meta"]!["wait"];
        Assert.True(JsonNode.DeepEquals(wait, persisted));
        var journal = await manager.Journal.ListAsync(parent.Id, "normal-turn", null, null, 10);
        Assert.Equal(2, journal.Count);
        Assert.All(journal, request => Assert.Equal(0, request!["iteration"]!.GetValue<int>()));
        var tools = parent.History().Where(row => SessionWait.Text(row["role"]) == "tool").ToArray();
        Assert.Equal(2, tools.Length);
        var result = Assert.Single(tools[^1]["parts"]!.AsArray())!["functionResponse"]!;
        Assert.Equal("foreground-wait", SessionWait.Text(result["tool_use_id"]));
        Assert.Null(result["response"]?["error"]);
        Assert.Equal("tool", SessionWait.Text(parent.History()[^1]["role"]));
    }
}
