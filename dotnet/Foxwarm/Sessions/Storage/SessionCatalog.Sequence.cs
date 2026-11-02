namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    internal sealed record SequenceSession(
        string Id,
        string? Parent,
        double LastMessageTime,
        bool Busy,
        long MessageCount
    );

    /// <summary>
    /// Every Session with the fields that tell whether its cached Archive span may have changed.
    /// The sequence view chooses Sessions by their own Archive rows, because the catalog's
    /// last-message time marks input and a turn's later rows can follow it by hours.
    /// </summary>
    internal IReadOnlyList<SequenceSession> SequenceSessions()
    {
        using var connection = OpenReader();
        using var command = Command(
            connection,
            "SELECT session_id,parent_session_id,last_message_time,busy,message_count FROM session_catalog"
        );
        using var reader = command.ExecuteReader();
        var rows = new List<SequenceSession>();
        while (reader.Read())
            rows.Add(
                new(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.GetDouble(2),
                    reader.GetInt64(3) == 1,
                    reader.GetInt64(4)
                )
            );
        QueryObserved?.Invoke("sequence-sessions", rows.Count);
        return rows;
    }
}
