namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    internal sealed record SequenceCandidate(
        string Id,
        string? Parent,
        double LastMessageTime,
        bool Busy
    );

    /// <summary>
    /// Sessions with activity since <paramref name="since"/> or currently busy, newest first.
    /// Uses the recent-rank index; the busy branch uses its partial index.
    /// </summary>
    internal IReadOnlyList<SequenceCandidate> SequenceCandidates(double since, int limit)
    {
        using var connection = OpenReader();
        using var command = Command(
            connection,
            "SELECT session_id,parent_session_id,last_message_time,busy FROM session_catalog "
                + "WHERE recent_rank<=$p0 UNION SELECT session_id,parent_session_id,last_message_time,busy "
                + "FROM session_catalog WHERE busy=1 ORDER BY 3 DESC,1 LIMIT $p1",
            -since,
            limit
        );
        using var reader = command.ExecuteReader();
        var rows = new List<SequenceCandidate>();
        while (reader.Read())
            rows.Add(
                new(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.GetDouble(2),
                    reader.GetInt64(3) == 1
                )
            );
        QueryObserved?.Invoke("sequence-candidates", rows.Count);
        return rows;
    }
}
