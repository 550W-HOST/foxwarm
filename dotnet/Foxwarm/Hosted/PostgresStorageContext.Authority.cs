using Foxwarm.Hosted.Postgres.Authority;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    // The authority writes its Archive rows in its own transaction and exposes the Archive
    // store's view of them, so it exists only together with the PostgreSQL Archive.
    partial void CreateAuthority(ref ISessionAuthorityBackend? store)
    {
        if (archive is { } rows)
            store = new PostgresSessionAuthorityBackend(Database, rows.ForSession, ScratchRoot, imageBlobs);
    }
}
