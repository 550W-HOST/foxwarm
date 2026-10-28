using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LegacyHistoryAuthorityTests
{
    private static JsonObject Operation(long start, long end) => new()
    {
        ["level"] = 1, ["sourceKind"] = "message", ["sourceStart"] = start, ["sourceEnd"] = end,
        ["summary"] = "Retained numbered work.",
    };

    [Fact]
    public async Task Source_unsequenced_history_survives_pruning_and_compaction_while_recorded_sources_remain_usable()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var fixture = await Source(data);
        var original = SessionHistory.FromJson(fixture["history"]!.AsArray().OfType<JsonObject>());
        var unsequenced = original.Where(row => row.Sequence is null).Select(row => row.ToJsonString()).ToArray();
        await using var peer = new ScriptedResponsesSequenceServer(1, async (_, stream, captured) =>
        {
            Assert.Contains("Legacy opening", captured.Body);
            Assert.DoesNotContain("- M#10 ", captured.Body);
            await Complete(stream, new JsonObject
            {
                ["type"] = "function_call", ["call_id"] = "legacy-compact", ["name"] = "submit_compact_plan",
                ["arguments"] = new JsonObject
                {
                    ["replaceAsBlocks"] = new JsonArray(Operation(7, 7), Operation(22, 35)),
                }.ToJsonString(),
            });
        });
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 50000);
        string[] archive;
        SessionHistory committed;
        await using (var manager = new SessionManager(data, work, options, HostModels.ForTest(options)))
        {
            await manager.LoadMainHostAsync();
            var owner = await manager.RequiredAsync("legacy");
            archive = owner.Archive.ReadMessages().Select(row => row.MessageJson).ToArray();
            var candidates = CompactCandidateBuilder.Build(original.Materialize(), inContext: true);
            Assert.DoesNotContain(candidates.Items, item => item.Start is 1 or 10);
            Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(
                new JsonObject { ["replaceAsBlocks"] = new JsonArray(Operation(7, 20)) }, candidates));
            var prune = await owner.Compactor.PruneToolsManuallyAsync(keep: 0);
            Assert.True(prune.Committed);
            Assert.Equal(1, prune.ReplacedFunctionResponses);
            Assert.Equal(unsequenced, owner.Entry.Snapshot().History.Where(row => row.Sequence is null).Select(row => row.ToJsonString()));
            Assert.Contains("historical tool response pruned", owner.Entry.Snapshot().History.Single(row => row.Sequence == 21).ToJsonString());
            Assert.Equal(archive, owner.Archive.ReadMessages().Select(row => row.MessageJson));
            Assert.True((await owner.Compactor.StartManualAsync(keepPercent: 0)).Started);
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(1, peer.RequestCount);
            committed = owner.Entry.Snapshot().History;
            // Context-block rows also have no raw seq; compare retained raw records separately.
            Assert.Equal(unsequenced, committed.Where(row => row.Sequence is null && row.ToJson()["__meta"]?["contextBlock"] is null).Select(row => row.ToJsonString()));
            Assert.Contains(committed, row => row.Sequence == 10);
            Assert.DoesNotContain(committed, row => row.Sequence is 7 or >= 22 and <= 35);
            var blocks = owner.Archive.ReadBlocks();
            Assert.Equal(2, blocks.Count);
            var timeless = blocks.Single(block => block.SourceStart == 7);
            Assert.Null(timeless.RawStartTimestamp);
            Assert.Null(timeless.RawEndTimestamp);
            var reader = new ArchiveContextReader(owner.Archive);
            var expanded = reader.Expand(owner.Id, timeless.Id, 4000)!;
            Assert.Equal(7, expanded["items"]![0]!["seq"]!.GetValue<long>());
            Assert.Equal(7000, expanded["items"]![0]!["timestamp"]!.GetValue<double>());
            Assert.Null(expanded["items"]![0]!["message"]!["__meta"]!["timestamp"]);
            Assert.Equal(archive, owner.Archive.ReadMessages().Take(archive.Length).Select(row => row.MessageJson));
            await owner.Entry.SaveLane.SaveStrictAsync();
        }
        await using (var reopened = new SessionManager(data, work, options, HostModels.ForTest(options)))
        {
            await reopened.LoadMainHostAsync();
            var owner = await reopened.RequiredAsync("legacy");
            Assert.Equal(committed.Select(row => row.ToJsonString()), owner.Entry.Snapshot().History.Select(row => row.ToJsonString()));
            Assert.Equal(archive, owner.Archive.ReadMessages().Take(archive.Length).Select(row => row.MessageJson));
        }
    }

    [Theory]
    [InlineData("call", false)]
    [InlineData("response", false)]
    [InlineData("notice", false)]
    [InlineData("call", true)]
    [InlineData("response", true)]
    [InlineData("notice", true)]
    public void Partly_identifiable_exchanges_are_retained_as_local_barriers(string missing, bool preserved)
    {
        JsonObject Row(string role, long seq, JsonObject part) => new()
        {
            ["role"] = role, ["parts"] = new JsonArray(part),
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
        };
        JsonObject[] rows =
        [
            Row("user", 1, new JsonObject { ["text"] = new string('x', 7000) }),
            Row("model", 2, new JsonObject { ["functionCall"] = new JsonObject { ["id"] = "paired", ["name"] = "read", ["args"] = new JsonObject() } }),
            Row("model", 3, new JsonObject { ["text"] = "Display interruption" }),
            Row("tool", 4, new JsonObject { ["functionResponse"] = new JsonObject { ["tool_use_id"] = "paired", ["name"] = "read", ["response"] = "retained" } }),
            Row("user", 5, new JsonObject { ["text"] = new string('y', 7000) }),
        ];
        rows[2]["modelVisible"] = false;
        if (preserved)
            for (var index = 1; index <= 3; index++)
                rows[index]["__meta"]!["preservedFromBlockId"] = 1;
        var missingIndex = missing == "call" ? 1 : missing == "notice" ? 2 : 3;
        rows[missingIndex]["__meta"]!.AsObject().Remove("seq");
        foreach (var inContext in new[] { false, true })
        {
            var candidates = CompactCandidateBuilder.Build(rows, keepPercent: 0, inContext: inContext);
            Assert.Equal(new long[] { 1, 5 }, candidates.Items.Select(item => item.Start));
            Assert.Empty(candidates.Preserved);
            Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(
                new JsonObject { ["replaceAsBlocks"] = new JsonArray(Operation(1, 5)) }, candidates));
            var plan = CompactPlanValidator.Validate(new JsonObject
            {
                ["replaceAsBlocks"] = new JsonArray(Operation(1, 1), Operation(5, 5)),
            }, candidates);
            Assert.Equal(2, plan.Operations.Count);
        }
    }

    [Fact]
    public async Task Unsequenced_display_only_history_is_not_discarded_by_provider_free_cleanup()
    {
        using var temp = new TempDirectory();
        await SessionUpgradeCompatibilityTests.Seed(temp.Path, "legacy");
        var file = Authority(temp.Path);
        var root = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        root["history"] = new JsonArray(new JsonObject
        {
            ["role"] = "model", ["modelVisible"] = false,
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "Only retained historical diagnostic" }),
        });
        root["meta"]!["messageCount"] = 1;
        await File.WriteAllTextAsync(file, root.ToJsonString());
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        await using var manager = new SessionManager(temp.Path, Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("legacy");
        Assert.True((await owner.Compactor.StartManualAsync(keepPercent: 0)).Started);
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
        EqualHistory(root["history"]!.AsArray(), owner.Entry.Snapshot().History);
        Assert.Empty(owner.Archive.ReadMessages());
        Assert.Empty(owner.Archive.ReadBlocks());
    }
}
