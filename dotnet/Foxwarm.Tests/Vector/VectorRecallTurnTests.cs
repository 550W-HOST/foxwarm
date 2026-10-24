using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorRecallTurnTests
{
    [Theory]
    [InlineData(false, true)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(true, false)]
    public async Task Recall_result_is_paired_and_sent_to_the_next_model_request(
        bool child,
        bool embeddingFails
    )
    {
        await using var model = ModelPeer(2);
        await using var fixture = await VectorFixture.CreateAsync();
        await using var manager = await fixture.ManagerAsync(child, modelPeer: model.BaseUri);
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "recall-turn", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            VectorFixture.Message("violet archived context")
        );
        await manager.ForceVectorIndexAsync(owner);
        var embeddingRequestsBefore = fixture.Peer.Requests.Count;
        fixture.Peer.Fail = embeddingFails;
        fixture.Peer.FailureMessage =
            "synthetic embeddings failure " + new string('x', 2000) + "omitted tail";

        await new SessionRuntime(manager).SubmitAndRunAsync(
            owner.Id,
            QueueItem.UserText("Use recall to retrieve context.")
        );
        await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));

        Assert.False(owner.Metadata().Busy);
        Assert.Equal(2, model.RequestCount);
        Assert.Equal(embeddingRequestsBefore + 1, fixture.Peer.Requests.Count);
        var history = owner.History();
        var parts = history
            .SelectMany(row => row["parts"]!.AsArray().OfType<JsonObject>())
            .ToArray();
        var call = Assert.Single(parts, part => part["functionCall"] is not null)["functionCall"]!;
        var response = Assert.Single(parts, part => part["functionResponse"] is not null)[
            "functionResponse"
        ]!;
        Assert.Equal("recall-query", call["id"]!.GetValue<string>());
        Assert.Equal("recall-query", response["tool_use_id"]!.GetValue<string>());
        var result = response["response"]!;
        if (embeddingFails)
        {
            Assert.Equal("VECTOR_OPERATION_FAILED", result["code"]!.GetValue<string>());
            Assert.Equal("VECTOR_OPERATION_FAILED", result["error"]!["type"]!.GetValue<string>());
            var errorMessage = result["error"]!["message"]!.GetValue<string>();
            Assert.StartsWith(
                "Embedding request failed (503): synthetic embeddings failure",
                errorMessage
            );
            Assert.True(errorMessage.Length <= "Embedding request failed (503): ".Length + 500);
            Assert.DoesNotContain("omitted tail", errorMessage);
            Assert.Null(result["retryable"]);
        }
        else
        {
            Assert.Null(result["error"]);
            Assert.Contains("violet archived context", result["output"]!.GetValue<string>());
        }
        var continuation = JsonNode.Parse((await model.RequestAt(1)).Body)!;
        var output = Assert.Single(
            continuation["input"]!.AsArray().OfType<JsonObject>(),
            row => row["type"]?.GetValue<string>() == "function_call_output"
        );
        Assert.Equal("recall-query", output["call_id"]!.GetValue<string>());
        Assert.Contains(
            embeddingFails ? "VECTOR_OPERATION_FAILED" : "violet archived context",
            output["output"]!.ToJsonString()
        );
        Assert.Contains(
            parts,
            part => part["text"]?.GetValue<string>() == "Handled the recall result."
        );
        var stored = owner
            .Archive.ReadMessages()
            .SelectMany(row => row.Message["parts"]!.AsArray().OfType<JsonObject>())
            .ToArray();
        Assert.Single(stored, part => part["functionCall"] is not null);
        Assert.Single(stored, part => part["functionResponse"] is not null);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_during_recall_settles_the_dispatched_call_without_continuation_or_replay(
        bool child
    )
    {
        await using var model = ModelPeer(1);
        await using var fixture = await VectorFixture.CreateAsync();
        await using var manager = await fixture.ManagerAsync(child, modelPeer: model.BaseUri);
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "stop-recall", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Peer.Fail = true;
        fixture.Peer.BeforeResponse = async _ =>
        {
            entered.TrySetResult();
            await release.Task;
        };
        try
        {
            await new SessionRuntime(manager).SubmitAndRunAsync(
                owner.Id,
                QueueItem.UserText("Retrieve context.")
            );
            var running = owner.StartProcessing();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var stop = await owner.Registry.Control.StopAsync(owner.Id);
            Assert.True(stop.AbortedInFlight);
            release.TrySetResult();
            await running.WaitAsync(TimeSpan.FromSeconds(20));
            Assert.False(owner.Metadata().Busy);
            Assert.False(owner.Entry.Snapshot().Stopping);
            Assert.Equal(1, model.RequestCount);
            Assert.Single(fixture.Peer.Requests);
            var parts = owner
                .History()
                .SelectMany(row => row["parts"]!.AsArray().OfType<JsonObject>())
                .ToArray();
            Assert.Single(parts, part => part["functionCall"] is not null);
            var response = Assert.Single(parts, part => part["functionResponse"] is not null)[
                "functionResponse"
            ]!;
            Assert.Equal("recall-query", response["tool_use_id"]!.GetValue<string>());
            Assert.Equal(
                "VECTOR_OPERATION_FAILED",
                response["response"]!["code"]!.GetValue<string>()
            );
            Assert.DoesNotContain(
                parts,
                part => part["text"]?.GetValue<string>() == "Handled the recall result."
            );
        }
        finally
        {
            release.TrySetResult();
        }
    }

    private static ScriptedResponsesSequenceServer ModelPeer(int requests) =>
        new(
            requests,
            async (index, stream, _) =>
            {
                var item =
                    index == 0
                        ? new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = "recall-query",
                            ["name"] = "recall",
                            ["arguments"] = new JsonObject
                            {
                                ["vector_query"] = "violet query",
                                ["scope"] = "current-session",
                                ["limit"] = 5,
                            }.ToJsonString(),
                        }
                        : new JsonObject
                        {
                            ["type"] = "message",
                            ["id"] = "recall-answer",
                            ["role"] = "assistant",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "Handled the recall result.",
                                    ["annotations"] = new JsonArray(),
                                }
                            ),
                        };
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "recall-response-" + index,
                        ["status"] = "completed",
                        ["output"] = new JsonArray(item),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                );
            }
        );
}
