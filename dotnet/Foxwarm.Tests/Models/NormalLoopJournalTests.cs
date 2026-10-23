using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class NormalLoopJournalTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Tool_continuation_records_loop_index_across_retry_and_resets_next_turn(bool retry)
    {
        var count = retry ? 4 : 3;
        await using var peer = new ScriptedResponsesSequenceServer(
            count,
            async (index, stream, _) =>
            {
                if (retry && index == 1)
                {
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream, 503, "application/json", Encoding.UTF8.GetBytes("{\"error\":{\"message\":\"synthetic failure\"}}")
                    );
                    return;
                }
                var output = index == 0
                    ? new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = "list-tasks",
                        ["name"] = "task",
                        ["arguments"] = "{\"action\":\"list\"}",
                    }
                    : new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = "done" }),
                    };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream, 200, "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject { ["output"] = new JsonArray(output) },
                    }.ToJsonString() + "\n\n")
                );
            }
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "local/wire", "", "", 1024);
        await using var manager = new SessionManager(data, Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "journal", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var task = await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "journal fixture", ["ownerSessionId"] = owner.Id }, owner.Id
        );
        async Task Run(string input)
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText(input));
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        }
        await Run("list the active task");
        var history = owner.History();
        var visible = history.Where(row => row["modelVisible"]?.GetValue<bool>() != false).ToArray();
        Assert.Equal(new[] { "user", "model", "tool", "model" }, visible.Select(row => SessionWait.Text(row["role"])));
        Assert.Equal("list-tasks", SessionWait.Text(visible[1]["parts"]![0]!["functionCall"]!["id"]));
        var response = visible[2]["parts"]![0]!["functionResponse"]!;
        Assert.Equal("list-tasks", SessionWait.Text(response["tool_use_id"]));
        Assert.Null(response["response"]?["error"]);
        Assert.Contains(task.Payload["task"]!["id"]!.GetValue<string>(), response.ToJsonString());
        Assert.Equal(retry ? 3 : 2, peer.RequestCount);
        if (!retry)
            Assert.Equal(4, history.Count);
        var journal = await manager.Journal.ListAsync(owner.Id, "normal-turn", null, null, 10);
        Assert.Equal(2, journal.Count);
        var firstId = visible[1]["__meta"]!["llmRequestId"]!.GetValue<string>();
        var secondId = visible[3]["__meta"]!["llmRequestId"]!.GetValue<string>();
        Assert.NotEqual(firstId, secondId);
        foreach (var (id, iteration, attempts) in new[] { (firstId, 0, 1), (secondId, 1, retry ? 2 : 1) })
        {
            var entry = journal.Single(row => SessionWait.Text(row!["requestId"]) == id)!;
            Assert.Equal(iteration, entry["iteration"]!.GetValue<int>());
            var reconstructed = await manager.Journal.ReconstructAsync(id);
            Assert.Equal("complete", SessionWait.Text(reconstructed["completeness"]));
            Assert.Equal(attempts, reconstructed["attempts"]!.AsArray().Count);
        }
        var second = await manager.Journal.ReconstructAsync(secondId);
        Assert.Contains("list-tasks", second["messages"]!.ToJsonString());
        var requestLogs = Directory.GetFiles(Path.Combine(data, "state", "logs", "recent"), "*_req.json");
        Assert.Single(requestLogs, path => Path.GetFileName(path).Contains("_iter1_"));
        await Run("next ordinary turn");
        Assert.Equal(count, peer.RequestCount);
        var last = owner.History()[^1];
        var nextId = last["__meta"]!["llmRequestId"]!.GetValue<string>();
        journal = await manager.Journal.ListAsync(owner.Id, "normal-turn", null, null, 10);
        Assert.Equal(3, journal.Count);
        Assert.Equal(0, journal.Single(row => SessionWait.Text(row!["requestId"]) == nextId)!["iteration"]!.GetValue<int>());
        Assert.Equal(owner.History().Select(EcmaJson.Stringify), owner.Archive.ReadMessages().Select(record => record.MessageJson));
        await manager.ShutdownAsync();
    }
}
