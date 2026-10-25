using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompactRetentionTests
{
    private static JsonObject Row(string role, long seq, JsonObject part, long? preserved = null) =>
        new()
        {
            ["role"] = role,
            ["__meta"] = new JsonObject
            {
                ["seq"] = seq,
                ["timestamp"] = seq,
                ["preservedFromBlockId"] = preserved,
            },
            ["parts"] = new JsonArray(part),
        };

    private static JsonObject Call(string id) =>
        new()
        {
            ["functionCall"] = new JsonObject
            {
                ["id"] = id,
                ["name"] = "read",
                ["args"] = new JsonObject { ["filePath"] = "fixture" },
            },
        };

    private static JsonObject Response(string id) =>
        new()
        {
            ["functionResponse"] = new JsonObject
            {
                ["tool_use_id"] = id,
                ["name"] = "read",
                ["response"] = new JsonObject { ["output"] = "paired response" },
            },
        };

    private static JsonObject Text() => new() { ["text"] = new string('x', 8000) };

    private static JsonObject Block(long start, long end) =>
        new()
        {
            ["level"] = 1,
            ["sourceKind"] = "message",
            ["sourceStart"] = start,
            ["sourceEnd"] = end,
            ["summary"] = "Prior work.",
        };

    [Fact]
    public void Forward_gap_admits_complete_exchange_and_ignored_notice_advances_the_next_segment()
    {
        JsonObject[] history =
        [
            Row("user", 1, Text()),
            Row("model", 4, Call("real")),
            Row("tool", 5, Response("real")),
            Row(
                "user",
                6,
                new JsonObject
                {
                    ["system"] = "<foxwarm-system kind=\"session-boundary\" event=\"notice\" />",
                }
            ),
            Row("user", 7, Text()),
            Row("model", 8, Text()),
        ];
        var candidates = CompactCandidateBuilder.Build(history, keepPercent: 0);
        var exchange = Assert.Single(candidates.Items, item => item.Start == 4);
        Assert.Equal(5, exchange.End);
        Assert.DoesNotContain(candidates.Items, item => item.Start == 6);
        Assert.NotEqual(exchange.Segment, candidates.Items.Single(item => item.Start == 7).Segment);
        Assert.Equal(
            candidates.Items.Single(item => item.Start == 7).Segment,
            candidates.Items.Single(item => item.Start == 8).Segment
        );
        var plan = CompactPlanValidator.Validate(
            new JsonObject
            {
                ["replaceAsBlocks"] = new JsonArray(Block(4, 5), Block(7, 8)),
                ["preserveMessages"] = new JsonArray(5),
            },
            candidates
        );
        Assert.Equal(new long[] { 4, 5 }, plan.Preserve.Order().ToArray());
        var quotaOnly = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(Block(4, 5)),
            ["preserveMessages"] = new JsonArray(4),
        };
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(quotaOnly, candidates)
        );
    }

    [Fact]
    public void Removing_preserved_exchanges_requires_the_real_paired_ID_members_and_does_not_group_unrelated_tools()
    {
        JsonObject[] history =
        [
            Row("model", 10, Call("real"), 1),
            Row("tool", 11, Response("real"), 1),
            Row("tool", 12, Response("other"), 1),
            Row("user", 13, Text(), 1),
        ];
        var candidates = CompactCandidateBuilder.Build(history, keepPercent: 0);
        Assert.Equal(new long[] { 10, 11 }, candidates.Preserved[0].Exchange);
        Assert.Equal(new long[] { 10, 11 }, candidates.Preserved[1].Exchange);
        Assert.Equal(new long[] { 12 }, candidates.Preserved[2].Exchange);
        var args = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(),
            ["removePreservedMessages"] = new JsonArray(10),
        };
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(args, candidates)
        );
        args["removePreservedMessages"] = new JsonArray(11);
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(args, candidates)
        );
        args["removePreservedMessages"] = new JsonArray(10, 11);
        var plan = CompactPlanValidator.Validate(args, candidates);
        Assert.Equal(new long[] { 10, 11 }, plan.Remove.Order().ToArray());
        args["removePreservedMessages"] = new JsonArray(12);
        Assert.Equal(12, Assert.Single(CompactPlanValidator.Validate(args, candidates).Remove));
    }

    private static JsonObject Display(long seq, long? preserved = null)
    {
        var row = Row(
            "model",
            seq,
            new JsonObject { ["text"] = "truncated response notice" },
            preserved
        );
        row["modelVisible"] = false;
        return row;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Display_interruption_keeps_raw_call_and_response_atomic_in_both_selection_modes(
        bool deliberate
    )
    {
        JsonObject[] history =
        [
            Row("user", 1, Text()),
            Row("model", 2, Call("real")),
            Display(3),
            Row("tool", 4, Response("real")),
            Display(5),
            Row("user", 6, Text()),
        ];
        var candidates = CompactCandidateBuilder.Build(
            history,
            keepPercent: 0,
            inContext: deliberate
        );
        var exchange = Assert.Single(candidates.Items, item => item.Start == 2);
        Assert.Equal(4, exchange.End);
        Assert.Equal(3, exchange.HistoryEnd);
        Assert.DoesNotContain(candidates.Items, item => item.Start is 3 or 4 or 5);
        foreach (var half in new[] { Block(2, 2), Block(4, 4) })
            Assert.Throws<CompactPlanInvalidException>(() =>
                CompactPlanValidator.Validate(
                    new JsonObject { ["replaceAsBlocks"] = new JsonArray(half) },
                    candidates
                )
            );
        var args = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(Block(1, 4)),
            ["preserveMessages"] = new JsonArray(4),
        };
        Assert.Equal(
            new long[] { 2, 3, 4 },
            CompactPlanValidator.Validate(args, candidates).Preserve.Order()
        );
    }

    [Theory]
    [InlineData("gap")]
    [InlineData("duplicate")]
    [InlineData("boundary")]
    [InlineData("block")]
    [InlineData("preserved")]
    [InlineData("no-response")]
    public void Transparent_lookahead_does_not_bridge_real_barriers_or_consume_a_notice_without_a_response(
        string barrier
    )
    {
        var notice = Display(3);
        var history = new List<JsonObject>
        {
            Row("user", 1, Text()),
            Row("model", 2, Call("real")),
            notice,
            Row("tool", 4, Response("real")),
            Row("user", 5, Text()),
        };
        switch (barrier)
        {
            case "gap":
                notice["__meta"]!["seq"] = 30;
                break;
            case "duplicate":
                history.Add(Row("user", 3, Text()));
                break;
            case "boundary":
                history[2] = Row(
                    "user",
                    3,
                    new JsonObject
                    {
                        ["system"] =
                            "<foxwarm-system kind=\"session-boundary\" event=\"notice\" />",
                    }
                );
                break;
            case "block":
                history[2] = new ArchiveBlockRecord(
                    "s",
                    "main",
                    9,
                    1,
                    "message",
                    3,
                    3,
                    null,
                    3,
                    3,
                    3,
                    3,
                    "Prior summary.",
                    null,
                    9
                ).ToMessage();
                history[2]["modelVisible"] = false;
                break;
            case "preserved":
                notice["__meta"]!["preservedFromBlockId"] = 1;
                break;
            case "no-response":
                history.RemoveAt(3);
                break;
        }
        var candidates = CompactCandidateBuilder.Build(history, inContext: true);
        Assert.Equal(2, candidates.Items.Single(item => item.Start == 2).End);
        if (barrier == "no-response")
        {
            Assert.Equal(2, CompactCandidateBuilder.Split(history, .5));
            CompactPlanValidator.Validate(
                new JsonObject { ["replaceAsBlocks"] = new JsonArray(Block(2, 2)) },
                candidates
            );
        }
    }

    [Fact]
    public void Preserved_members_follow_actual_IDs_across_transparent_rows_and_partial_removal_stays_invalid()
    {
        JsonObject[] history =
        [
            Row("model", 10, Call("real"), 1),
            Display(11, 1),
            Row("tool", 12, Response("real"), 1),
            Row("tool", 13, Response("other"), 1),
        ];
        var candidates = CompactCandidateBuilder.Build(history, inContext: true);
        Assert.Equal(0, CompactCandidateBuilder.Split(history, .5));
        Assert.Equal(
            new long[] { 10, 12 },
            candidates.Preserved.Single(item => item.Seq == 10).Exchange
        );
        Assert.Equal(
            new long[] { 10, 12 },
            candidates.Preserved.Single(item => item.Seq == 12).Exchange
        );
        Assert.Equal(
            new long[] { 13 },
            candidates.Preserved.Single(item => item.Seq == 13).Exchange
        );
        Assert.DoesNotContain(candidates.Preserved, item => item.Seq == 11);
        var args = new JsonObject { ["replaceAsBlocks"] = new JsonArray() };
        foreach (var member in new long[] { 10, 12 })
        {
            args["removePreservedMessages"] = new JsonArray(member);
            Assert.Throws<CompactPlanInvalidException>(() =>
                CompactPlanValidator.Validate(args, candidates)
            );
        }
        args["removePreservedMessages"] = new JsonArray(10, 12);
        Assert.Equal(
            new long[] { 10, 12 },
            CompactPlanValidator.Validate(args, candidates).Remove.Order()
        );
        history[1]["modelVisible"] = true;
        Assert.Equal(2, CompactCandidateBuilder.Split(history, .5));
        var visible = CompactCandidateBuilder.Build(history, inContext: true);
        Assert.Equal(new long[] { 12 }, visible.Preserved.Single(item => item.Seq == 12).Exchange);
    }
}
