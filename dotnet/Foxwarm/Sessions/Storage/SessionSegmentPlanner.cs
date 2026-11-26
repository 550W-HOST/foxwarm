using System.Buffers;
using System.Text.Json;

namespace Foxwarm.Sessions;

/// <summary>One stored history segment of a segmented authority: its key, record count and size.</summary>
internal readonly record struct SessionSegment(long Id, int Count, int Bytes);

/// <summary>
/// What a commit keeps and writes: the first <see cref="KeptSegments"/> segments of the
/// committed layout stay, and the staged records from <see cref="Start"/> on are written as
/// new segments. Every other committed segment is replaced.
/// </summary>
internal readonly record struct SessionSegmentPlan(int KeptSegments, int Start);

/// <summary>A new segment: a JSON array of <see cref="Count"/> records.</summary>
internal sealed record SessionSegmentPiece(int Count, byte[] Records);

/// <summary>
/// The delta planner of a head-plus-segments Session authority, and its segment policy.
/// Callers pass complete staged snapshots; the planner derives the delta from record identity,
/// because <see cref="SessionHistory"/> shares unchanged records with the root it was derived
/// from. Reference identity is sufficient, not necessary, for equality, so the worst case only
/// rewrites more.
/// </summary>
internal static class SessionSegmentPlanner
{
    /// <summary>A segment below this size is small; a run of small trailing segments is merged.</summary>
    internal const int SmallSegmentBytes = 64 * 1024;

    /// <summary>The number of small trailing segments at which the next write merges them.</summary>
    internal const int MergeRunLength = 16;

    /// <summary>Written records are cut into segments of about this size.</summary>
    internal const int PieceBytes = 256 * 1024;

    /// <summary>
    /// Plans a commit of <paramref name="staged"/> over the committed root
    /// <paramref name="committed"/> stored as <paramref name="layout"/>. Without a known root
    /// (null) everything is written.
    /// </summary>
    internal static SessionSegmentPlan Plan(
        SessionHistory? committed,
        IReadOnlyList<SessionSegment> layout,
        SessionHistory staged
    )
    {
        if (committed is null)
            return new(0, 0);
        // k: the longest prefix whose records are the committed records themselves.
        var prefix = 0;
        while (
            prefix < committed.Count
            && prefix < staged.Count
            && ReferenceEquals(committed[prefix], staged[prefix])
        )
            prefix++;
        // Keep whole segments inside [0, k); rewrite from the first segment that isn't.
        var kept = 0;
        var start = 0;
        while (kept < layout.Count && start + layout[kept].Count <= prefix)
        {
            start += layout[kept].Count;
            kept++;
        }
        if (start >= staged.Count)
            return new(kept, start);
        // The commit writes records: a run of small trailing kept segments joins them.
        var run = 0;
        while (run < kept && layout[kept - 1 - run].Bytes < SmallSegmentBytes)
            run++;
        if (run >= MergeRunLength)
            for (; run > 0; run--)
                start -= layout[--kept].Count;
        return new(kept, start);
    }

    /// <summary>
    /// Cuts <paramref name="count"/> records into segments of about <see cref="PieceBytes"/>,
    /// each materialized before it is returned. <paramref name="writeRecord"/> writes the record
    /// at an index; the writer has the authority writer options.
    /// </summary>
    internal static IEnumerable<SessionSegmentPiece> Cut(
        int start,
        int count,
        Action<Utf8JsonWriter, int> writeRecord
    )
    {
        var buffer = new ArrayBufferWriter<byte>();
        var writer = new Utf8JsonWriter(
            buffer,
            SessionAuthorityDocument.WriterOptions(indented: false)
        );
        var records = 0;
        for (var index = start; index < start + count; index++)
        {
            if (records == 0)
                writer.WriteStartArray();
            writeRecord(writer, index);
            records++;
            if (writer.BytesCommitted + writer.BytesPending >= PieceBytes)
            {
                yield return Finish();
            }
        }
        if (records > 0)
            yield return Finish();
        writer.Dispose();

        SessionSegmentPiece Finish()
        {
            writer.WriteEndArray();
            writer.Flush();
            var piece = new SessionSegmentPiece(records, buffer.WrittenSpan.ToArray());
            buffer.ResetWrittenCount();
            writer.Reset(buffer);
            records = 0;
            return piece;
        }
    }

    /// <summary>
    /// Cuts the records of <paramref name="history"/> from <paramref name="start"/> on, written
    /// and validated as the document writer writes them.
    /// </summary>
    internal static IEnumerable<SessionSegmentPiece> Cut(SessionHistory history, int start) =>
        Cut(
            start,
            history.Count - start,
            (writer, index) => SessionAuthorityDocument.WriteRecord(writer, history[index], index)
        );
}
