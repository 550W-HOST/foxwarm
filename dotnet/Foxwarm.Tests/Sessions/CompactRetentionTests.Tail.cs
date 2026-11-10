using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactRetentionTests
{
    private static JsonObject Sized(long seq, int characters) =>
        Row("user", seq, new JsonObject { ["text"] = new string('x', characters) });

    private static JsonObject SummaryBlock(long id, long seq) =>
        new ArchiveBlockRecord(
            "s",
            "main",
            id,
            1,
            "message",
            seq,
            seq,
            null,
            seq,
            seq,
            seq,
            seq,
            "Prior summary.",
            null,
            seq
        ).ToMessage();

    [Fact]
    public void Recent_tail_keeps_the_newest_raw_rows_within_the_token_budget()
    {
        JsonObject[] history = [Sized(1, 3000), Sized(2, 3000), Sized(3, 3000), Sized(4, 3000)];
        var row = CompactCandidateBuilder.RowTokens(history[0]);
        Assert.True(row > 900);
        Assert.Equal(2, CompactCandidateBuilder.Split(history, 2 * row));
        Assert.Equal(2, CompactCandidateBuilder.Split(history, 3 * row - 1));
        Assert.Equal(0, CompactCandidateBuilder.Split(history, 10 * row));
        // The newest row stays even when it alone exceeds the budget; zero keeps nothing.
        Assert.Equal(3, CompactCandidateBuilder.Split(history, 1));
        Assert.Equal(4, CompactCandidateBuilder.Split(history, 0));
    }

    [Fact]
    public void Recent_tail_ignores_row_counts_and_never_covers_a_summary_block()
    {
        JsonObject[] tail = [Sized(50, 3000), Sized(51, 300), Sized(52, 300)];
        var budget =
            CompactCandidateBuilder.RowTokens(tail[1]) + CompactCandidateBuilder.RowTokens(tail[2]);
        foreach (var blocks in new[] { 1, 20 })
        {
            var history = Enumerable
                .Range(1, blocks)
                .Select(id => SummaryBlock(id, id))
                .Concat(tail.Select(row => (JsonObject)row.DeepClone()))
                .ToArray();
            Assert.Equal(history.Length - 2, CompactCandidateBuilder.Split(history, budget));
            Assert.Equal(blocks, CompactCandidateBuilder.Split(history, 1_000_000));
        }
    }

    [Fact]
    public void Recent_tail_budget_is_a_share_of_the_threshold_or_of_the_raw_region_present()
    {
        // Only the raw rows after the newest block count.
        var raw = Enumerable.Range(10, 10).Select(seq => Sized(seq, 3000)).ToArray();
        JsonObject[] history = [Sized(1, 30000), SummaryBlock(5, 1), .. raw];
        var present = raw.Sum(CompactCandidateBuilder.RowTokens);
        Assert.InRange(present, 9900, 10000);
        Assert.Equal(
            Math.Floor(.5 * present),
            CompactCandidateBuilder.KeepTokens(.5, 170_000, history)
        );
        Assert.Equal(2000, CompactCandidateBuilder.KeepTokens(.5, 4000, history));
        Assert.Equal(1, CompactCandidateBuilder.KeepTokens(.3, 170_000, [SummaryBlock(5, 1)]));
        Assert.Equal(0, CompactCandidateBuilder.KeepTokens(0, 170_000, history));
    }
}
