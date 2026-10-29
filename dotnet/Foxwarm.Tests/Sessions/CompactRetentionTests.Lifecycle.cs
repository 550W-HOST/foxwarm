using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactRetentionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Completion_cleanup_leaves_a_sparse_exchange_that_can_be_compacted_preserved_and_removed(
        bool deliberate
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        JsonObject pending = new();
        var requests = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(
            deliberate ? 5 : 4,
            async (index, stream, captured) =>
            {
                requests.Add(JsonNode.Parse(captured.Body)!.AsObject());
                var output = deliberate && index == 3
                    ? new JsonArray(new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["content"] = new JsonArray(new JsonObject
                        {
                            ["type"] = "output_text", ["text"] = "Done.",
                        }),
                    })
                    : new JsonArray(new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = "plan-" + index,
                        ["name"] = "submit_compact_plan",
                        ["arguments"] = pending.ToJsonString(),
                    });
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "sparse-" + index,
                        ["output"] = output,
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream, 200, "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        var models = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["contextLimit"] = 200000,
                        ["asyncCompact"] = false,
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            data, work, options, models, Path.Combine(temp.Path, "skills")
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "sparse-exchange", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        async Task<long> Append(string role, params JsonObject[] parts)
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.Prebuilt(new JsonObject
            {
                ["role"] = role,
                ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray()),
            }) with { Trigger = false });
            await owner.Registry.HostFor(owner.Id).AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
            return owner.Entry.Snapshot().History.Last().Sequence!.Value;
        }
        async Task Compact(long first, long last, double keep)
        {
            pending = new JsonObject { ["replaceAsBlocks"] = new JsonArray(Block(first, last)) };
            var admission = await owner.Compactor.StartManualAsync(keepPercent: keep);
            var state = owner.Entry.Snapshot();
            Assert.True(admission.Started, $"{admission}; busy={state.Busy}; stopping={state.Stopping}; queued={state.Queue.Count}; claims={owner.Entry.ProcessorClaimCount}");
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, owner.Entry.BestEffortFailureCount);
        }
        async Task ApplyPending()
        {
            Assert.True((await owner.Compactor.StartManualAsync(keepPercent: 0)).Started);
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(0, owner.Entry.BestEffortFailureCount);
        }

        var inputs = new List<long>();
        for (var index = 0; index < 10; index++)
            inputs.Add(await Append("user", Text()));
        var call = await Append("model", Call("first"), Call("second"));
        await Compact(inputs[0], inputs[6], .3);
        var removedCompletion = owner.Entry.Snapshot().History.Last().Sequence!.Value;
        var firstResponse = await Append("tool", Response("first"));
        var secondResponse = await Append("tool", Response("second"));
        var archiveBefore = owner.Archive.ReadMessages().ToDictionary(row => row.Seq, row => row.Message.ToJsonString());
        await Compact(inputs[7], inputs[9], .5);
        Assert.Equal(2, peer.RequestCount);
        var sparse = owner.History();
        Assert.DoesNotContain(sparse, row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) == removedCompletion);
        Assert.Equal(call + 2, firstResponse);
        var callIndex = sparse.ToList().FindIndex(row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) == call);
        Assert.Equal(firstResponse, CompactCandidateBuilder.Number(sparse[callIndex + 1]["__meta"]?["seq"]));
        // The ordinary recent-tail split lands inside the now-sparse exchange and retreats to its call.
        Assert.Equal(callIndex, CompactCandidateBuilder.Split(sparse, .4));

        await Append("user", Text());
        var end = await Append("user", Text());
        var candidates = CompactCandidateBuilder.Build(owner.History(), keepPercent: 0, inContext: deliberate);
        var exchange = Assert.Single(candidates.Items, item => item.Start == call);
        Assert.Equal(secondResponse, exchange.End);
        Assert.Equal(
            candidates.Items.Where(item => item.Kind == "message").Sum(item => item.Tokens),
            candidates.EligibleRawTokens
        );
        Assert.Equal(deliberate ? 0 : (int)Math.Ceiling(candidates.EligibleRawTokens * .2), candidates.RequiredRawTokens);
        pending = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(Block(call, end)),
            ["preserveMessages"] = new JsonArray(firstResponse),
        };
        var validated = CompactPlanValidator.Validate(pending, candidates);
        var actualMembers = new[] { call, firstResponse, secondResponse };
        Assert.Equal(actualMembers, validated.Preserve.Order());
        var invalid = (JsonObject)pending.DeepClone();
        invalid["preserveMessages"] = new JsonArray(removedCompletion);
        Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(invalid, candidates));
        invalid = new JsonObject { ["replaceAsBlocks"] = new JsonArray(Block(firstResponse, end)) };
        Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(invalid, candidates));
        // Preserving the exchange cannot satisfy the ordinary raw-token replacement quota.
        if (!deliberate)
            Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(
                new JsonObject
                {
                    ["replaceAsBlocks"] = new JsonArray(Block(call, secondResponse)),
                    ["preserveMessages"] = new JsonArray(firstResponse),
                }, candidates));
        if (deliberate)
        {
            pending["inContext"] = true;
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Apply the selected compact plan."));
            await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Single(requests[3]["input"]!.AsArray().OfType<JsonObject>(),
                row => SessionWait.Text(row["type"]) == "function_call_output"
                    && SessionWait.Text(row["call_id"]) == "plan-2");
            var receipt = owner.History().SelectMany(row => row["parts"]!.AsArray().OfType<JsonObject>())
                .Select(part => part["functionResponse"] as JsonObject).OfType<JsonObject>()
                .Single(response => SessionWait.Text(response["tool_use_id"]) == "plan-2");
            Assert.True(receipt["response"]!["accepted"]!.GetValue<bool>());
        }
        else
            await ApplyPending();
        Assert.Equal(3, owner.Archive.ReadBlocks().Count);
        Assert.Equal(call, owner.Archive.ReadBlocks().Last().SourceStart);
        Assert.Equal(end, owner.Archive.ReadBlocks().Last().SourceEnd);
        foreach (var seq in actualMembers)
        {
            var retained = Assert.Single(owner.History(), row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) == seq);
            Assert.NotNull(retained["__meta"]?["preservedFromBlockId"]);
            retained["__meta"]!.AsObject().Remove("preservedFromBlockId");
            Assert.Equal(archiveBefore[seq], retained.ToJsonString());
        }
        var preserved = CompactCandidateBuilder.Build(owner.History(), keepPercent: 0);
        Assert.All(preserved.Preserved, item => Assert.Equal(actualMembers, item.Exchange));
        pending = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(),
            ["removePreservedMessages"] = new JsonArray(firstResponse),
        };
        Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(pending, preserved));
        pending["removePreservedMessages"] = new JsonArray(actualMembers.Select(seq => (JsonNode?)JsonValue.Create(seq)).ToArray());
        await ApplyPending();
        Assert.DoesNotContain(owner.History(), row => actualMembers.Contains(CompactCandidateBuilder.Number(row["__meta"]?["seq"]) ?? -1));
        Assert.Equal(3, owner.Archive.ReadBlocks().Count);
        Assert.Equal(deliberate ? 5 : 4, peer.RequestCount);
        foreach (var row in owner.Archive.ReadMessages().Where(row => archiveBefore.ContainsKey(row.Seq)))
            Assert.Equal(archiveBefore[row.Seq], row.Message.ToJsonString());
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
    }
}
