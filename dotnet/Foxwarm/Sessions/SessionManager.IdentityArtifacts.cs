using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Only the immutable Archive reservation graph proves a historical artifact's lifetime.
    // Main's optional metadata aliases do not authorize adopting another execution.
    private string ResolveExecLifetime(string recorded)
    {
        if (!File.Exists(ArchiveDatabase))
            return recorded;
        using var db = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = ArchiveDatabase,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        db.Open();
        var canonical = SqliteArchiveMessageStore.ResolveReadOnly(db, recorded);
        if (canonical != recorded && Catalog.Get(recorded) is not null)
            throw new InvalidDataException(
                "Historical execution identity conflicts with an exact Main lifetime."
            );
        return canonical;
    }

}
