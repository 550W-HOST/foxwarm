using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ResponsesPrefixCommitTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Redaction_restores_live_prefix_and_real_tool_execution_while_replay_keeps_wire_text(
        bool websocket
    )
    {
        const string secret = "Ada \"Quoted\" \\path\n私😀";
        const string untouched = "opaque-secret";
        await using var detector = await TextDetectionPeer.StartAsync(secret, untouched);
        var committed = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var progress = new List<ResponsesStreamProgress>();
        string? placeholder = null;
        Exception? peerFailure = null;
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                try
                {
                    if (number == 1)
                    {
                        var input = context.Request["input"]!.AsArray();
                        placeholder = input
                            .OfType<JsonObject>()
                            .Single(item => SessionWait.Text(item["role"]) == "user")["content"]!
                            .AsArray()
                            .Last()!["text"]!.GetValue<string>();
                        Assert.StartsWith("[[FW_PRIVATE_", placeholder);
                        Assert.Equal(untouched, context.Request["opaque"]!.GetValue<string>());
                        var text = "Sending to " + placeholder;
                        var originalReasoning = Reasoning(untouched);
                        originalReasoning["summary"]![0]!["text"] = placeholder;
                        await context.Send(Done(0, originalReasoning));
                        await context.Send(
                            new JsonObject
                            {
                                ["type"] = "response.output_item.added",
                                ["output_index"] = 1,
                                ["item"] = Commentary(""),
                            }
                        );
                        foreach (
                            var piece in new[]
                            {
                                "Sending to ",
                                placeholder[..9],
                                placeholder[9..40],
                                placeholder[40..],
                            }
                        )
                            await context.Send(
                                new JsonObject
                                {
                                    ["type"] = "response.output_text.delta",
                                    ["output_index"] = 1,
                                    ["content_index"] = 0,
                                    ["delta"] = piece,
                                }
                            );
                        await context.Send(Done(1, Commentary(text)));
                        await committed.Task.WaitAsync(TimeSpan.FromSeconds(5));
                        var call = new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = "c",
                            ["name"] = "echo",
                            ["arguments"] =
                                " { \"value\": "
                                + System.Text.Json.JsonSerializer.Serialize(placeholder)
                                + ", \"nested\": ["
                                + System.Text.Json.JsonSerializer.Serialize(placeholder)
                                + "] } ",
                        };
                        await context.Send(Done(2, (JsonObject)call.DeepClone()));
                        var reasoning = Reasoning(untouched);
                        reasoning["summary"]![0]!["text"] = placeholder;
                        // This final-only summary must remain a placeholder, never restored.
                        await context.Send(Completed(reasoning, Commentary(text), call));
                    }
                    else
                    {
                        if (websocket)
                        {
                            Assert.NotNull(context.Request["previous_response_id"]);
                            Assert.DoesNotContain(
                                "Sending to ",
                                context.Request["input"]!.ToJsonString()
                            );
                        }
                        else
                        {
                            Assert.Contains(placeholder!, context.Request["input"]!.ToJsonString());
                            Assert.DoesNotContain(secret, context.Request["input"]!.ToJsonString());
                        }
                        await context.Send(
                            Completed(Commentary("Finished " + placeholder, "final_answer"))
                        );
                    }
                }
                catch (Exception error)
                {
                    peerFailure ??= error;
                    throw;
                }
            }
        );
        await using var owner = new Owner(
            peer.Uri,
            websocket,
            observed: progress.Add,
            providerFields: new JsonObject
            {
                ["textRedaction"] = TextRedactionTests.Settings(detector.Endpoint),
                ["extraFields"] = new JsonObject { ["opaque"] = untouched },
            }
        );
        owner.Entry.AssistantCommitted = row =>
        {
            if (row["__meta"]?["llmSegment"]?["complete"]?.GetValue<bool>() == false)
            {
                Assert.Contains(
                    "Sending to " + secret,
                    string.Concat(
                        row["parts"]!.AsArray().Select(part => SessionWait.Text(part?["text"]))
                    )
                );
                committed.TrySetResult();
            }
            return Task.CompletedTask;
        };
        await owner.Run(secret);
        Assert.Null(peerFailure);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(2, peer.Requests.Count);
        var executed = Assert.Single(owner.Tools.Calls);
        Assert.Equal(secret, executed["args"]!["value"]!.GetValue<string>());
        Assert.Equal(
            secret,
            JsonNode.Parse(executed["rawArgsText"]!.GetValue<string>())![
                "value"
            ]!.GetValue<string>()
        );
        Assert.Equal(secret, executed["args"]!["nested"]![0]!.GetValue<string>());
        Assert.Contains(
            progress,
            update => update.Text.Contains("Sending to " + secret, StringComparison.Ordinal)
        );
        Assert.All(progress, update => Assert.DoesNotContain("[[FW_PRIVATE_", update.Text));
        Assert.DoesNotContain(untouched, detector.Texts);
        var disk = (await owner.Store.LoadAsync("s"))!.History.Materialize();
        Assert.Contains(
            disk.SelectMany(row => row["parts"]!.AsArray()),
            part => SessionWait.Text(part?["text"]) == "Finished " + secret
        );
        Assert.Contains(
            disk.SelectMany(row => row["parts"]!.AsArray()),
            part => SessionWait.Text(part?["text"]) == secret
        );
        Assert.Contains(
            disk.SelectMany(row => row["parts"]!.AsArray()),
            part => SessionWait.Text(part?["thinking"]) == placeholder
        );
        await owner.Run("next");
        Assert.Null(peerFailure);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(3, peer.Requests.Count);
        if (websocket)
            Assert.NotNull(peer.Requests[2]["previous_response_id"]);
    }
}
