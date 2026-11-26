using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using static Foxwarm.Tests.SessionAuthorityContractTests;

namespace Foxwarm.Tests;

/// <summary>The segment policy of the shared delta planner, independent of any store.</summary>
public sealed class SessionSegmentPlannerTests
{
    private static SessionHistory Records(int count, int from = 1) =>
        SessionHistory.FromJson(Enumerable.Range(from, count).Select(seq => Message(seq, "r" + seq)));

    private static SessionSegment[] Layout(params (int Count, int Bytes)[] segments) =>
        segments.Select((segment, index) => new SessionSegment(index + 1, segment.Count, segment.Bytes)).ToArray();

    [Fact]
    public void An_unknown_root_writes_everything()
    {
        Assert.Equal(new SessionSegmentPlan(0, 0), SessionSegmentPlanner.Plan(null, [], Records(3)));
    }

    [Fact]
    public void Unchanged_history_keeps_every_segment_and_writes_nothing()
    {
        var history = Records(4);
        var layout = Layout((2, 100), (2, 100));
        Assert.Equal(new SessionSegmentPlan(2, 4), SessionSegmentPlanner.Plan(history, layout, history));
    }

    [Fact]
    public void Appends_keep_the_committed_segments_and_write_the_tail()
    {
        var history = Records(4);
        var appended = history.AppendJson([Message(5, "five")]);
        Assert.Equal(new SessionSegmentPlan(2, 4), SessionSegmentPlanner.Plan(history, Layout((2, 100), (2, 100)), appended));
    }

    [Fact]
    public void A_change_rewrites_from_the_segment_holding_it_and_a_truncation_drops_whole_segments()
    {
        var history = Records(6);
        var layout = Layout((2, 100), (2, 100), (2, 100));
        var changed = history.Replace(3, HistoryMessage.FromJson(Message(4, "changed")));
        Assert.Equal(new SessionSegmentPlan(1, 2), SessionSegmentPlanner.Plan(history, layout, changed));
        var truncated = SessionHistory.FromMessages(history.Take(4).ToArray());
        Assert.Equal(new SessionSegmentPlan(2, 4), SessionSegmentPlanner.Plan(history, layout, truncated));
        Assert.Equal(new SessionSegmentPlan(0, 0), SessionSegmentPlanner.Plan(history, layout, SessionHistory.Empty));
    }

    [Fact]
    public void Sixteen_small_trailing_segments_merge_into_the_next_write()
    {
        var history = Records(17);
        var small = Enumerable.Repeat((1, SessionSegmentPlanner.SmallSegmentBytes - 1), 16).ToArray();
        var appended = history.AppendJson([Message(18, "next")]);
        // One large segment, then sixteen small ones: the small run joins the appended record.
        var layout = Layout([(1, SessionSegmentPlanner.SmallSegmentBytes), .. small]);
        Assert.Equal(new SessionSegmentPlan(1, 1), SessionSegmentPlanner.Plan(history, layout, appended));
        // Fifteen small ones aren't merged, and a save without history changes merges nothing.
        var fifteen = Layout([(2, SessionSegmentPlanner.SmallSegmentBytes), .. small[..15]]);
        Assert.Equal(new SessionSegmentPlan(16, 17), SessionSegmentPlanner.Plan(history, fifteen, appended));
        Assert.Equal(new SessionSegmentPlan(17, 17), SessionSegmentPlanner.Plan(history, layout, history));
    }

    [Fact]
    public void Cut_pieces_close_at_about_256_KiB_and_hold_the_records_as_written()
    {
        var text = new string('x', 100 * 1024);
        var history = SessionHistory.FromJson(Enumerable.Range(1, 7).Select(seq => Message(seq, text)));
        var pieces = SessionSegmentPlanner.Cut(history, 1).ToArray();
        Assert.Equal([3, 3], pieces.Select(piece => piece.Count));
        Assert.True(pieces[0].Records.Length >= SessionSegmentPlanner.PieceBytes);
        var records = pieces.SelectMany(piece => JsonNode.Parse(piece.Records)!.AsArray()).ToArray();
        Assert.Equal(history.Skip(1).Select(message => message.ToJsonString()), records.Select(node => node!.ToJsonString()));
    }

    [Fact]
    public void Cut_validates_records_like_the_document_writer()
    {
        var invalid = SessionHistory.FromJson([new JsonObject { ["role"] = "nobody", ["parts"] = new JsonArray() }]);
        Assert.Throws<InvalidDataException>(() => SessionSegmentPlanner.Cut(invalid, 0).ToArray());
    }
}
