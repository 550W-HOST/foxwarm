using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactRetentionTests
{
    // Block i covers raw messages 10i+1..10i+10; raw messages after the region start at 500.
    private static JsonObject Ctx(long id, int level, int summaryChars)
    {
        var raw = id * 10;
        return new ArchiveBlockRecord(
            "retention",
            "main",
            id,
            level,
            level == 1 ? "message" : "block",
            level == 1 ? raw + 1 : 1000 + id,
            level == 1 ? raw + 10 : 1000 + id,
            level == 1 ? null : new JsonArray(1000 + id),
            raw + 1,
            raw + 10,
            null,
            null,
            new string('s', summaryChars),
            null,
            1
        ).ToMessage();
    }

    private static List<JsonObject> RegionRows(
        int[] levels,
        bool raw = true,
        int summaryChars = 600
    )
    {
        var rows = levels.Select((level, index) => Ctx(index + 1, level, summaryChars)).ToList();
        if (raw)
        {
            rows.Add(Row("user", 500, Text()));
            rows.Add(Row("model", 501, Text()));
        }
        return rows;
    }

    private static CompactCandidates Region(
        int[] levels,
        bool raw = true,
        int summaryChars = 600
    ) => CompactCandidateBuilder.Build(RegionRows(levels, raw, summaryChars), keepTokens: 0);

    private static string Ops(CompactCandidates candidates) =>
        string.Join(
            " ",
            candidates.Retention.Select(op =>
                op.Kind == "message"
                    ? $"M{op.SourceStart}-{op.SourceEnd}:L{op.Level}"
                    : $"B{op.SourceStart}-{op.SourceEnd}:L{op.Level}"
            )
        );

    private static JsonObject Entry(
        string kind,
        long start,
        long end,
        int level,
        int chars = 400
    ) =>
        new()
        {
            ["level"] = level,
            ["sourceKind"] = kind,
            ["sourceStart"] = start,
            ["sourceEnd"] = end,
            ["summary"] = new string('x', chars),
        };

    [Theory]
    // A new level-1 block overflows level 1; the merged level-2 block overflows level 2.
    [InlineData(new[] { 3, 3, 2, 2, 2, 1, 1, 1 }, true, "B3-4:L3 B6-7:L2 M500-501:L1")]
    [InlineData(new[] { 3, 2, 1, 1 }, true, "M500-501:L1")]
    [InlineData(new[] { 1, 1, 1 }, false, "")]
    [InlineData(new[] { 1, 1, 1, 1 }, false, "B1-2:L2")]
    // An older block below a younger, higher block joins it without raising its level.
    [InlineData(new[] { 1, 3, 2 }, true, "B1-2:L3 M500-501:L1")]
    [InlineData(new[] { 2, 1, 1, 3, 1 }, true, "B1-4:L3 M500-501:L1")]
    // Normalization is applied oldest first, at most three block operations per run.
    [InlineData(
        new[] { 1, 2, 1, 2, 1, 2, 1, 2, 1, 2 },
        true,
        "B1-4:L3 B5-6:L2 B7-8:L2 M500-501:L1"
    )]
    public void Retention_requires_log_compressed_operations(
        int[] levels,
        bool raw,
        string expected
    )
    {
        var candidates = Region(levels, raw);
        Assert.Equal(expected, Ops(candidates));
        Assert.Equal(expected.Length > 0, candidates.HasWork);
    }

    [Fact]
    public void Region_backstop_merges_the_oldest_blocks_at_the_oldest_level()
    {
        // Twenty ~6k-token blocks far exceed 24k; the oldest absorbs its neighbours at level 7
        // until the projected region fits.
        var candidates = Region(
            [7, 7, 7, 6, 6, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1],
            summaryChars: 18000
        );
        Assert.Equal("B1-17:L7 M500-501:L1", Ops(candidates));
    }

    [Fact]
    public void Region_backstop_measures_actual_block_sizes()
    {
        // Five ~6k-token blocks and the new block's projected 1,800 exceed 24k.
        Assert.Equal("B1-2:L5 M500-501:L1", Ops(Region([5, 4, 3, 2, 1], summaryChars: 18000)));
        Assert.Equal("M500-501:L1", Ops(Region([5, 4, 3, 2, 1], summaryChars: 6000)));
    }

    [Fact]
    public void Region_backstop_waits_until_the_layout_is_normalized()
    {
        // The trailing level-1 block joins the younger level-2 block; no backstop in this run.
        Assert.Equal("B5-6:L2 M500-501:L1", Ops(Region([5, 4, 3, 2, 1, 2], summaryChars: 18000)));
    }

    [Fact]
    public void A_capped_cascade_keeps_older_blocks_at_or_above_younger_levels()
    {
        // Level 1 is far over: the three oldest pairs merge now, the rest in later runs.
        Assert.Equal(
            "B5-6:L2 B7-8:L2 B9-10:L2 M500-501:L1",
            Ops(Region([2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]))
        );
    }

    [Theory]
    [InlineData(new[] { 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 }, 600)]
    [InlineData(new[] { 5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1 }, 600)]
    [InlineData(new[] { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 }, 9000)]
    [InlineData(
        new[]
        {
            8,
            7,
            5,
            4,
            1,
            4,
            2,
            7,
            4,
            2,
            6,
            5,
            3,
            7,
            1,
            5,
            4,
            2,
            6,
            4,
            3,
            1,
            3,
            2,
            1,
            1,
            1,
            1,
            1,
        },
        3000
    )]
    [InlineData(new[] { 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 3, 1, 4, 1 }, 9000)]
    public void Repeated_compactions_keep_the_level_order_once_normalized(
        int[] levels,
        int summaryChars
    )
    {
        var layout = levels.ToList();
        var normalized = false;
        var orderedRuns = 0;
        for (var run = 0; run < 60; run++)
        {
            var candidates = Region([.. layout], summaryChars: summaryChars);
            var merges = candidates.Retention.Where(op => op.Kind == "block").ToArray();
            Assert.True(merges.Length <= CompactRetention.MaxMergesPerRun);
            // Block i of the region has ID i + 1; apply merges from the newest backwards.
            foreach (var op in merges.OrderByDescending(op => op.SourceStart))
            {
                var first = (int)op.SourceStart - 1;
                var count = (int)op.SourceEnd - first;
                layout.RemoveRange(first, count);
                layout.Insert(first, op.Level);
            }
            layout.Add(1);
            var ordered = layout.Zip(layout.Skip(1)).All(pair => pair.First >= pair.Second);
            if (normalized)
                Assert.True(ordered, $"run {run}: {string.Join(",", layout)}");
            normalized |= ordered;
            orderedRuns += normalized ? 1 : 0;
            // An over-full layout drains within a few capped runs; afterwards a level holds at
            // most one deferred block more than k.
            if (orderedRuns > 10)
                Assert.All(
                    layout.GroupBy(level => level),
                    group => Assert.True(group.Count() <= CompactRetention.SlotsPerLevel + 1)
                );
        }
        Assert.True(normalized);
        Assert.True(layout.Count <= 25, string.Join(",", layout));
    }

    [Fact]
    public void Cascade_merges_run_lowest_level_first_when_capped()
    {
        // A new level-1 block cascades through five full levels; the three lowest merges run now.
        var candidates = Region([5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1]);
        Assert.Equal("B7-8:L4 B10-11:L3 B13-14:L2 M500-501:L1", Ops(candidates));
    }

    [Fact]
    public void Raw_messages_older_than_the_newest_block_are_not_new_block_sources()
    {
        var rows = RegionRows([2, 1], raw: true);
        rows.Insert(1, Row("user", 15, Text()));
        var candidates = CompactCandidateBuilder.Build(rows, keepTokens: 0);
        Assert.Equal("M500-501:L1", Ops(candidates));
        Assert.Contains(candidates.Items, item => item.Kind == "message" && item.Start == 15);
    }

    [Fact]
    public void Validator_accepts_exactly_the_required_operations()
    {
        var candidates = Region([3, 3, 2, 2, 2, 1, 1, 1]);
        JsonObject Plan(params JsonObject[] entries) =>
            new() { ["replaceAsBlocks"] = new JsonArray(entries) };
        var plan = CompactPlanValidator.Validate(
            Plan(Entry("message", 500, 501, 1), Entry("block", 3, 4, 3), Entry("block", 6, 7, 2)),
            candidates
        );
        Assert.Equal(
            new[] { ("block", 3), ("block", 2), ("message", 1) },
            plan.Operations.Select(op => (op.Kind, op.Level)).ToArray()
        );
        Assert.Null(plan.OverBudget);

        var missing = Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(
                Plan(Entry("block", 3, 4, 3), Entry("block", 6, 7, 2)),
                candidates
            )
        );
        Assert.Contains("sourceStart=500", missing.Message);
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(
                Plan(
                    Entry("message", 500, 501, 1),
                    Entry("block", 3, 4, 3),
                    Entry("block", 6, 8, 2)
                ),
                candidates
            )
        );
        Assert.Throws<CompactPlanInvalidException>(() =>
            CompactPlanValidator.Validate(
                Plan(
                    Entry("message", 500, 501, 1),
                    Entry("block", 3, 4, 4),
                    Entry("block", 6, 7, 2)
                ),
                candidates
            )
        );
    }

    [Fact]
    public void Over_budget_summaries_are_rejected_until_accepted_and_recorded()
    {
        var candidates = Region([2, 1, 1, 1]);
        var args = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(
                Entry("message", 500, 501, 1),
                // ~2,000 estimated tokens against a 1,500-token merge budget.
                Entry("block", 2, 3, 2, chars: 6100)
            ),
        };
        var rejected = Assert.Throws<CompactPlanBudgetException>(() =>
            CompactPlanValidator.Validate(args, candidates)
        );
        Assert.Contains("budget 1500", rejected.Message);
        var accepted = CompactPlanValidator.Validate(args, candidates, acceptOverBudget: true);
        var overrun = Assert.Single(accepted.OverBudget!).AsObject();
        Assert.Equal(2, overrun["sourceStart"]!.GetValue<long>());
        Assert.Equal(1500, overrun["budget"]!.GetValue<int>());
    }

    [Fact]
    public void Memory_facts_count_toward_the_summary_budget()
    {
        var candidates = Region([2, 1, 1, 1]);
        // ~1,350 tokens of summary alone fit the 1,500 budget; with the facts section they don't.
        var merge = Entry("block", 2, 3, 2, chars: 4100);
        merge["memoryFacts"] = new JsonArray(
            Enumerable
                .Range(0, 10)
                .Select(n =>
                    (JsonNode?)
                        new JsonObject
                        {
                            ["kind"] = "fact",
                            ["text"] = $"Fact {n}: " + new string('f', 180),
                        }
                )
                .ToArray()
        );
        var args = new JsonObject
        {
            ["replaceAsBlocks"] = new JsonArray(Entry("message", 500, 501, 1), merge),
        };
        Assert.Throws<CompactPlanBudgetException>(() =>
            CompactPlanValidator.Validate(args, candidates)
        );
        merge.Remove("memoryFacts");
        Assert.Null(CompactPlanValidator.Validate(args, candidates).OverBudget);
    }

    [Fact]
    public void Prompt_marks_preserved_messages_that_a_merge_removes()
    {
        var rows = RegionRows([2, 1, 1, 1]);
        JsonObject Kept(long seq, long block)
        {
            var row = Row("user", seq, new JsonObject { ["text"] = $"kept {seq}" });
            row["__meta"]!["preservedFromBlockId"] = block;
            return row;
        }
        rows.Insert(2, Kept(25, 2));
        rows.Insert(5, Kept(45, 4));
        var prompt = CompactPrompt.Build(CompactCandidateBuilder.Build(rows, keepTokens: 0));
        Assert.Contains("- M#25 preserved from B#2 (removed by operation 1): kept 25", prompt);
        Assert.Contains("- M#45 preserved from B#4: kept 45", prompt);
        Assert.Contains(
            "Preserved messages inside merged blocks are removed from history by this merge",
            prompt
        );
    }
}
