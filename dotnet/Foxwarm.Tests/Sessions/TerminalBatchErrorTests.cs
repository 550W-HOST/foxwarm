using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed partial class TerminalBatchErrorTests
{
    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static JsonObject Unified(string id, string name, JsonObject args) =>
        Call(id, "call_tool", new() { ["toolId"] = "builtin:" + name, ["args"] = args });

    private static JsonObject Final() =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = "error handled" }
            ),
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

    private static ResponsesClientOptions Options(Uri uri) => new(uri, "wire", "a", "", "", 713);

    [Theory]
    [InlineData("wait", false)]
    [InlineData("wait", true)]
    [InlineData("send-wait", false)]
    [InlineData("send-wait", true)]
    [InlineData("send-finish", false)]
    [InlineData("send-finish", true)]
    [InlineData("script-wait", false)]
    [InlineData("script-finish", true)]
    [InlineData("mixed", false)]
    [InlineData("failed-send-wait", true)]
    [InlineData("failed-send-finish", false)]
    [InlineData("child-wait", true)]
    [InlineData("child-finish", false)]
    public async Task Recognized_batch_error_continues_with_all_results_and_consumes_terminal_controls(
        string mode,
        bool errorFirst
    )
    {
        ScriptFixture f = null!;
        JsonArray firstCalls = null!;
        var requests = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, request) =>
            {
                requests.Add(JsonNode.Parse(request.Body)!.AsObject());
                if (index > 0)
                {
                    Assert.Null(f.Owner.WaitSnapshot());
                    var history = f.Owner.History();
                    Assert.True(SessionContinuation.IsIncomplete(history));
                    var results = history
                        .Where(row => SessionWait.Text(row["role"]) == "tool")
                        .Select(row => row["parts"]!.AsArray())
                        .ToArray();
                    Assert.Equal(index, results.Length);
                    Assert.Equal(
                        firstCalls.Select(call => call!["call_id"]!.ToString()),
                        results[0].Select(part => part!["functionResponse"]!["tool_use_id"]!.ToString())
                    );
                    Assert.Equal(mode.StartsWith("failed-send") ? 2 : 1, results[0].Count(part => part!["functionResponse"]!["response"]?["error"] is not null));
                    var wireResults = requests[index]["input"]!.AsArray()
                        .OfType<JsonObject>()
                        .Where(item => SessionWait.Text(item["type"]) == "function_call_output")
                        .ToArray();
                    Assert.Equal(
                        firstCalls.Select(call => call!["call_id"]!.ToString()),
                        wireResults.Take(firstCalls.Count).Select(item => item["call_id"]!.ToString())
                    );
                    Assert.All(wireResults, item => Assert.NotEmpty(item["output"]!.ToJsonString()));
                }
                await Respond(
                    stream,
                    index == 0 ? (JsonArray)firstCalls.DeepClone()
                    : index == 1 ? new JsonArray(Call("follow-up", "read", new() { ["filePath"] = Path.Combine(f.Work, "known.txt") }))
                    : new JsonArray(Final())
                );
            }
        );
        await using var fixture = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        f = fixture;
        await File.WriteAllTextAsync(Path.Combine(f.Work, "known.txt"), "follow-up content");
        var target = await f.Manager.CreateNamedAsync("main", "recipient", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        var childId = f.Owner.Id + "_worker";
        f.Manager.TopologyChanged += () =>
        {
            if (f.Manager.Find(childId) is { } child)
                child.Registry.TriggerOverride = _ => Task.CompletedTask;
        };
        string? taskId = null;
        if (mode.StartsWith("child-"))
        {
            var created = await f.Manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "create", ["title"] = "complete owned assignment" },
                f.Owner.Id
            );
            taskId = SessionWait.Text(created.Payload["task"]!["id"]);
        }
        var after = mode.EndsWith("finish") ? "finish" : "wait";
        var sendArgs = new JsonObject
        {
            ["sessionId"] = mode.StartsWith("failed-send") ? "main/missing-recipient" : target.Id,
            ["message"] = "once-only delivery",
            ["afterSend"] = after,
        };
        JsonObject control = mode switch
        {
            "wait" => Call("control", "wait", new() { ["waitForInput"] = true }),
            "script-wait" => Call("control", "run_script", new()
            {
                ["code"] = "return call_tool('run_script', {'code':\"call_tool('wait', {'waitForInput':True})\\nreturn 42\"})",
            }),
            "script-finish" => Call("control", "run_script", new()
            {
                ["code"] = "call_tool('send_to_session', args)\nreturn {'__toolLoopControl':{'stopCurrentTurn':True}}",
                ["args"] = sendArgs,
            }),
            "child-wait" or "child-finish" => Call("control", "create_child_session", new()
            {
                ["suffix"] = "worker",
                ["taskId"] = taskId,
                ["afterSend"] = after,
            }),
            _ => errorFirst
                ? Unified("control", "send_to_session", sendArgs)
                : Call("control", "send_to_session", sendArgs),
        };
        var failed = Call("failed", "read", new() { ["filePath"] = "missing.txt" });
        firstCalls = errorFirst ? new JsonArray(failed, control) : new JsonArray(control, failed);
        if (mode == "mixed")
        {
            firstCalls.Insert(1, Unified("finish", "send_to_session", new()
            {
                ["sessionId"] = target.Id,
                ["message"] = "second once-only delivery",
                ["afterSend"] = "finish",
            }));
            firstCalls.Insert(2, Call("explicit-wait", "wait", new() { ["waitForInput"] = true }));
        }
        await f.Owner.Entry.SaveLane.AdmitAsync(QueueItem.UserText("handle the entire batch"), SaveKind.Strict);
        await f.Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(3, peer.RequestCount);
        Assert.Null(f.Owner.WaitSnapshot());
        Assert.Null(f.Owner.Entry.Snapshot().Meta["wait"]);
        Assert.False(f.Owner.Entry.Snapshot().Busy);
        Assert.False(SessionContinuation.IsIncomplete(f.Owner.History()));
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        if (taskId is not null)
        {
            var child = f.Manager.Find(childId)!;
            Assert.NotNull(child);
            Assert.Single(child.Entry.Snapshot().Queue);
            var task = await f.Manager.Tasks.ExecuteAsync(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, f.Owner.Id);
            Assert.Equal(childId, SessionWait.Text(task.Payload["task"]!["ownerSessionId"]));
            Assert.Equal(childId, SessionWait.Text(task.Payload["task"]!["attachedSessionId"]));
        }
        else if (mode.StartsWith("failed-send"))
            Assert.Empty(target.Entry.Snapshot().Queue);
        else if (mode.Contains("send") || mode is "mixed" or "script-finish")
            Assert.Equal(mode == "mixed" ? 2 : 1, target.Entry.Snapshot().Queue.Count);
    }
}
