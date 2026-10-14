using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompactRetentionTests
{
    private static JsonObject Row(string role, long seq, JsonObject part, long? preserved = null) => new()
    {
        ["role"] = role,
        ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq, ["preservedFromBlockId"] = preserved },
        ["parts"] = new JsonArray(part),
    };

    private static JsonObject Call(string id) => new() { ["functionCall"] = new JsonObject { ["id"] = id, ["name"] = "read", ["args"] = new JsonObject { ["filePath"] = "fixture" } } };
    private static JsonObject Response(string id) => new() { ["functionResponse"] = new JsonObject { ["tool_use_id"] = id, ["name"] = "read", ["response"] = new JsonObject { ["output"] = "paired response" } } };
    private static JsonObject Text() => new() { ["text"] = new string('x', 8000) };
    private static JsonObject Block(long start, long end) => new() { ["level"] = 1, ["sourceKind"] = "message", ["sourceStart"] = start, ["sourceEnd"] = end, ["summary"] = "Prior work." };

    [Fact]
    public void Forward_gap_admits_complete_exchange_and_ignored_notice_advances_the_next_segment()
    {
        JsonObject[] history = [Row("user", 1, Text()), Row("model", 4, Call("real")), Row("tool", 5, Response("real")),
            Row("user", 6, new JsonObject { ["system"] = "<foxwarm-system kind=\"session-boundary\" event=\"notice\" />" }),
            Row("user", 7, Text()), Row("model", 8, Text())];
        var candidates = CompactCandidateBuilder.Build(history, keepPercent: 0);
        var exchange = Assert.Single(candidates.Items, item => item.Start == 4);
        Assert.Equal(5, exchange.End);
        Assert.DoesNotContain(candidates.Items, item => item.Start == 6);
        Assert.NotEqual(exchange.Segment, candidates.Items.Single(item => item.Start == 7).Segment);
        Assert.Equal(candidates.Items.Single(item => item.Start == 7).Segment, candidates.Items.Single(item => item.Start == 8).Segment);
        var plan = CompactPlanValidator.Validate(new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(Block(4, 5), Block(7, 8)),
            ["preserveMessages"] = new JsonArray(5),
        }, candidates);
        Assert.Equal(new long[] { 4, 5 }, plan.Preserve.Order().ToArray());
        var quotaOnly = new JsonObject { ["replaceAsBlocks"] = new JsonArray(Block(4, 5)), ["preserveMessages"] = new JsonArray(4) };
        Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(quotaOnly, candidates));
    }

    [Fact]
    public void Removing_preserved_exchanges_requires_the_real_paired_ID_members_and_does_not_group_unrelated_tools()
    {
        JsonObject[] history = [Row("model", 10, Call("real"), 1), Row("tool", 11, Response("real"), 1),
            Row("tool", 12, Response("other"), 1), Row("user", 13, Text(), 1)];
        var candidates = CompactCandidateBuilder.Build(history, keepPercent: 0);
        Assert.Equal(new long[] { 10, 11 }, candidates.Preserved[0].Exchange);
        Assert.Equal(new long[] { 10, 11 }, candidates.Preserved[1].Exchange);
        Assert.Equal(new long[] { 12 }, candidates.Preserved[2].Exchange);
        var args = new JsonObject { ["replaceAsBlocks"] = new JsonArray(), ["removePreservedMessages"] = new JsonArray(10) };
        Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(args, candidates));
        args["removePreservedMessages"] = new JsonArray(11);
        Assert.Throws<CompactPlanInvalidException>(() => CompactPlanValidator.Validate(args, candidates));
        args["removePreservedMessages"] = new JsonArray(10, 11);
        var plan = CompactPlanValidator.Validate(args, candidates);
        Assert.Equal(new long[] { 10, 11 }, plan.Remove.Order().ToArray());
        args["removePreservedMessages"] = new JsonArray(12);
        Assert.Equal(12, Assert.Single(CompactPlanValidator.Validate(args, candidates).Remove));
    }
}
