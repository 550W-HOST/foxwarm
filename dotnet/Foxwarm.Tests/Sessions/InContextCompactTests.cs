using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Foreground_direct_and_unified_batches_apply_after_real_pairing_and_before_next_request(bool unified)
    {
        await using var fixture = await Fixture.CreateAsync(2, (f, index, request) =>
        {
            if (index == 1)
            {
                var input = request["input"]!.ToJsonString();
                Assert.Contains("Selected work is complete.", input);
                Assert.Contains("Newest input is summarized.", input);
                Assert.Contains("Keep the beginning.", input);
                Assert.Contains("Keep the later context.", input);
                Assert.Contains("correction during the batch", input);
                Assert.Contains("real sibling file", input);
                Assert.DoesNotContain("Completed middle detail.", input);
                Assert.Equal(1, f.Owner.Entry.Snapshot().HistoryVersion);
                f.InputTokens = 50;
                return Task.FromResult(Final());
            }
            var args = Plan();
            args["replaceAsBlocks"]!.AsArray().Add(new JsonObject
            {
                ["level"] = 1, ["sourceKind"] = "message", ["sourceStart"] = 4,
                ["sourceEnd"] = 4, ["summary"] = "Newest input is summarized.",
            });
            var call = unified
                ? Call("plan", "call_tool", new JsonObject { ["toolId"] = "builtin:submit_compact_plan", ["args"] = args })
                : Call("plan", "submit_compact_plan", args);
            return Task.FromResult(new JsonArray(call, Call("sibling", "read", new JsonObject
            {
                ["filePath"] = Path.Combine(f.Work, "sibling.txt"),
            })));
        });
        await File.WriteAllTextAsync(Path.Combine(fixture.Work, "sibling.txt"), "real sibling file");
        fixture.InputTokens = 21000;
        var observed = false;
        fixture.Owner.Entry.BeforeCanonicalNotification = async () =>
        {
            var snapshot = fixture.Owner.Entry.Snapshot();
            if (observed || SessionWait.Text(snapshot.History.Last().ToJson()["role"]) != "tool")
                return;
            observed = true;
            Assert.Equal(0, snapshot.HistoryVersion);
            Assert.True(fixture.Owner.Compactor.Active);
            Assert.True(fixture.ToolResponse("plan")["response"]!["accepted"]!.GetValue<bool>());
            Assert.False(fixture.ToolResponse("plan")["response"]!["applied"]!.GetValue<bool>());
            await fixture.Owner.Registry.Ingress.EnqueueAsync(fixture.Owner.Id,
                QueueItem.UserText("correction during the batch", clientMessageId: "during-batch"));
        };
        var original = fixture.Owner.Archive!.ReadMessages().Select(row => row.MessageJson).ToArray();
        await fixture.RunAsync();
        Assert.True(observed);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(2, fixture.Peer.RequestCount);
        Assert.Equal(original, fixture.Owner.Archive.ReadMessages().Take(3).Select(row => row.MessageJson));
        var rows = fixture.Owner.History();
        var callRow = rows.Single(row => row["parts"]!.AsArray().Any(part => SessionWait.Text(part?["functionCall"]?["id"]) == "plan"));
        var toolRow = rows.Single(row => row["parts"]!.AsArray().Any(part => SessionWait.Text(part?["functionResponse"]?["tool_use_id"]) == "plan"));
        Assert.Equal(2, toolRow["parts"]!.AsArray().Count);
        Assert.True(CompactCandidateBuilder.Number(toolRow["__meta"]?["seq"]) > CompactCandidateBuilder.Number(callRow["__meta"]?["seq"]));
        var toolSeq = CompactCandidateBuilder.Number(toolRow["__meta"]?["seq"]);
        var outputs = fixture.Requests[1]["input"]!.AsArray().OfType<JsonObject>()
            .Where(row => SessionWait.Text(row["type"]) == "function_call_output").ToArray();
        Assert.Equal(2, outputs.Length);
        Assert.All(outputs, output => Assert.Contains("seq=\"" + toolSeq + "\"", output["output"]!.AsArray()[0]!["text"]!.GetValue<string>()));
        var saved = (await fixture.Owner.AuthorityStore.LoadAsync(fixture.Owner.Id))!;
        Assert.Equal(1, saved.HistoryVersion);
        Assert.Empty(saved.Queue);
    }

    [Fact]
    public async Task One_child_rewrite_creates_the_next_level_without_replacing_archived_sources()
    {
        await using var fixture = await Fixture.CreateAsync(3, (f, index, request) =>
        {
            if (index == 0)
                return Task.FromResult(new JsonArray(Call("raw", "submit_compact_plan", Plan())));
            if (index == 1)
            {
                Assert.Contains("CTX-BLOCK L1 B#1", request.ToJsonString());
                var args = Plan();
                args["replaceAsBlocks"] = new JsonArray(new JsonObject
                {
                    ["level"] = 2, ["sourceKind"] = "block", ["sourceStart"] = 1,
                    ["sourceEnd"] = 1, ["summary"] = "Shortened single block.",
                });
                return Task.FromResult(new JsonArray(Call("block", "submit_compact_plan", args)));
            }
            Assert.Contains("CTX-BLOCK L2 B#2", request.ToJsonString());
            Assert.DoesNotContain("CTX-BLOCK L1 B#1", request.ToJsonString());
            return Task.FromResult(Final());
        });
        await fixture.RunAsync();
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(2, fixture.Owner.Entry.Snapshot().HistoryVersion);
        var blocks = fixture.Owner.Archive!.ReadBlocks();
        Assert.Equal(2, blocks.Count);
        Assert.Equal("Selected work is complete.", blocks[0].Summary);
        Assert.Equal(2, blocks[1].Level);
        Assert.Equal(1, blocks[1].SourceStart);
        Assert.Equal(1, Assert.Single(blocks[1].SourceBlockIds!)!.GetValue<long>());
        Assert.Contains(fixture.Owner.Archive.ReadMessages(), row => row.Seq == 2 && row.MessageJson.Contains("Completed middle detail."));
    }

    [Theory]
    [InlineData("wait")]
    [InlineData("finish")]
    [InlineData("stop")]
    public async Task Paired_plan_preserves_terminal_batch_controls_without_an_extra_planner(string control)
    {
        string? receiver = null;
        await using var fixture = await Fixture.CreateAsync(1, (f, _, _) =>
        {
            var sibling = control switch
            {
                "wait" => Call("control", "wait", new JsonObject { ["waitForInput"] = true }),
                "finish" => Call("control", "send_to_session", new JsonObject
                {
                    ["sessionId"] = receiver, ["message"] = "complete", ["afterSend"] = "finish",
                }),
                _ => Call("control", "stop_session", new JsonObject { ["sessionId"] = f.Owner.Id }),
            };
            return Task.FromResult(new JsonArray(Call("plan", "submit_compact_plan", Plan()), sibling));
        });
        if (control == "finish")
        {
            var target = await fixture.Manager.CreateNamedAsync("main", "receiver", null, null);
            target.Registry.TriggerOverride = _ => Task.CompletedTask;
            receiver = target.Id;
        }
        fixture.InputTokens = 21000;
        await fixture.RunAsync();
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.False(fixture.Owner.Entry.Snapshot().Busy);
        Assert.Equal(control == "wait", fixture.Owner.WaitSnapshot() is not null);
        Assert.Equal(1, fixture.Peer.RequestCount);
    }

    [Fact]
    public async Task Existing_compaction_excludes_a_second_plan_and_ordinary_invalid_arguments_do_not_admit_work()
    {
        await using var fixture = await Fixture.CreateAsync(2, (f, index, _) =>
        {
            if (index > 0)
                return Task.FromResult(Final());
            var invalid = Plan();
            invalid["argsFilePath"] = Path.Combine(f.Work, "not-a-repair-file");
            return Task.FromResult(new JsonArray(
                Call("bad-file", "submit_compact_plan", invalid),
                Call("plan", "submit_compact_plan", Plan()),
                Call("conflict", "submit_compact_plan", Plan())));
        });
        await fixture.RunAsync();
        Assert.NotNull(fixture.ToolResponse("bad-file")["response"]!["error"]);
        Assert.NotNull(fixture.ToolResponse("conflict")["response"]!["error"]);
        Assert.True(fixture.ToolResponse("plan")["response"]!["accepted"]!.GetValue<bool>());
        Assert.Equal(1, fixture.Owner.Entry.Snapshot().HistoryVersion);
        Assert.False(Directory.Exists(Path.Combine(fixture.Work, ".temp")));
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
    }
}
