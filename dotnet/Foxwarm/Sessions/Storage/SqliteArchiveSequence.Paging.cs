using System.Collections.Concurrent;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>Seq and timestamp range of one Session's own Archive rows.</summary>
internal sealed record ArchiveSpan(
    string Canonical,
    long FirstSeq,
    double First,
    long LastSeq,
    double Last
);

/// <summary>
/// Position in the newest-first merge of all Sessions' rows. Rows order by
/// (timestamp, Session ID, seq); a cursor excludes itself and everything newer. Pages normally
/// end on a minute boundary, where only <see cref="At"/> is set.
/// </summary>
internal sealed record ArchiveSequenceCursor(double At, string? SessionId = null, long? Seq = null)
{
    /// <summary>True when the row sorts strictly before (older than) this cursor.</summary>
    internal bool Includes(double timestamp, string sessionId, long seq)
    {
        if (timestamp != At)
            return timestamp < At;
        if (SessionId is null)
            return false;
        var order = string.CompareOrdinal(sessionId, SessionId);
        return order < 0 || order == 0 && seq < Seq;
    }
}

internal static partial class SqliteArchiveSequence
{
    private sealed record SpanEntry(
        ArchiveSpan? Span,
        double LastMessageTime,
        bool Busy,
        long MessageCount
    );

    // Main-memory span cache. The first own row never changes; the last row only changes while
    // a Session runs or receives input, which the catalog's last-message time, busy flag and
    // message count reveal, so an unchanged idle entry needs no Archive read.
    private static readonly ConcurrentDictionary<(string, string), SpanEntry> Spans = new();

    internal static ArchiveSpan? Span(
        SqliteConnection connection,
        string databasePath,
        SessionCatalog.SequenceSession session
    )
    {
        var key = (databasePath, session.Id);
        if (
            Spans.TryGetValue(key, out var cached)
            && !session.Busy
            && !cached.Busy
            && cached.LastMessageTime == session.LastMessageTime
            && cached.MessageCount == session.MessageCount
        )
            return cached.Span;
        var canonical =
            cached?.Span?.Canonical
            ?? SqliteArchiveMessageStore.ResolveReadOnly(connection, session.Id);
        ArchiveSpan? span = null;
        if (Edge(connection, canonical, last: true) is { } last)
        {
            var first = cached?.Span is { } known
                ? (known.FirstSeq, known.First)
                : Edge(connection, canonical, last: false)!.Value;
            span = new(canonical, first.Item1, first.Item2, last.Seq, last.Timestamp);
        }
        Spans[key] = new(span, session.LastMessageTime, session.Busy, session.MessageCount);
        return span;
    }

    private static (long Seq, double Timestamp)? Edge(
        SqliteConnection connection,
        string canonical,
        bool last
    )
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT seq,timestamp FROM archive_messages WHERE session_id=$s ORDER BY seq "
            + (last ? "DESC" : "ASC")
            + " LIMIT 1";
        command.Parameters.AddWithValue("$s", canonical);
        using var reader = command.ExecuteReader();
        return reader.Read() ? (reader.GetInt64(0), reader.GetDouble(1)) : null;
    }

    /// <summary>Highest own seq that sorts before <paramref name="cursor"/>; below FirstSeq when none.</summary>
    internal static long SeqBefore(
        SqliteConnection connection,
        string sessionId,
        ArchiveSpan span,
        ArchiveSequenceCursor? cursor
    )
    {
        if (cursor is null || span.Last < cursor.At)
            return span.LastSeq;
        if (span.First > cursor.At)
            return span.FirstSeq - 1;
        if (cursor.SessionId is { } tieSession)
        {
            var order = string.CompareOrdinal(sessionId, tieSession);
            if (order == 0)
                return Math.Min(span.LastSeq, (cursor.Seq ?? span.FirstSeq) - 1);
            if (order < 0)
                // Archive timestamps are whole milliseconds: rows at the cursor time are included.
                return WindowStart(
                        connection,
                        span.Canonical,
                        Math.Floor(cursor.At) + 1,
                        span.FirstSeq,
                        span.LastSeq
                    ) - 1;
        }
        return WindowStart(connection, span.Canonical, cursor.At, span.FirstSeq, span.LastSeq) - 1;
    }

    /// <summary>Seq/timestamp pairs at or below <paramref name="high"/>, newest first.</summary>
    internal static List<(long Seq, double Timestamp)> Positions(
        SqliteConnection connection,
        ArchiveSpan span,
        long high,
        int count
    )
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT seq,timestamp FROM archive_messages WHERE session_id=$s AND seq<=$high ORDER BY seq DESC LIMIT $n";
        command.Parameters.AddWithValue("$s", span.Canonical);
        command.Parameters.AddWithValue("$high", high);
        command.Parameters.AddWithValue("$n", count);
        using var reader = command.ExecuteReader();
        var rows = new List<(long, double)>(count);
        while (reader.Read())
            rows.Add((reader.GetInt64(0), reader.GetDouble(1)));
        return rows;
    }

    /// <summary>Rows <paramref name="low"/>..<paramref name="high"/> of one Session, ascending.</summary>
    internal static ArchiveSequencePage ReadRange(
        SqliteConnection connection,
        string sessionId,
        ArchiveSpan span,
        long low,
        long high
    )
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            Select + " WHERE session_id=$s AND seq>=$low AND seq<=$high ORDER BY seq ASC";
        command.Parameters.AddWithValue("$s", span.Canonical);
        command.Parameters.AddWithValue("$low", low);
        command.Parameters.AddWithValue("$high", high);
        var rows = ReadRows(command);
        return new(
            sessionId,
            rows,
            span.LastSeq,
            false,
            false,
            Context(connection, span.Canonical, rows)
        );
    }
}
