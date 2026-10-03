using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Only the immutable Archive reservation graph proves a historical artifact's lifetime.
    // Main's optional metadata aliases do not authorize adopting another execution.
    private string ResolveExecLifetime(string recorded)
    {
        if (!File.Exists(ArchiveDatabase)) return recorded;
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = ArchiveDatabase, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()); db.Open();
        var canonical = SqliteArchiveMessageStore.ResolveReadOnly(db, recorded);
        if (canonical != recorded && Catalog.Get(recorded) is not null)
            throw new InvalidDataException("Historical execution identity conflicts with an exact Main lifetime.");
        return canonical;
    }
    private string[] HistoricalExecOwners(string current)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal) { current };
        if (!File.Exists(ArchiveDatabase)) return ids.ToArray();
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = ArchiveDatabase, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()); db.Open();
        if (!SqliteArchiveMessageStore.HasReservationTable(db)) return ids.ToArray();
        using var command = db.CreateCommand(); command.CommandText = "SELECT session_id FROM archive_session_id_reservations";
        var keys = new List<string>(); using (var reader = command.ExecuteReader()) while (reader.Read()) keys.Add(reader.GetString(0));
        foreach (var id in keys)
            if (SqliteArchiveMessageStore.ResolveReadOnly(db, id) == current)
            {
                if (id != current && Catalog.Get(id) is not null) throw new InvalidDataException("Historical execution identity conflicts with an exact Main lifetime.");
                ids.Add(id);
            }
        return ids.ToArray();
    }
}
