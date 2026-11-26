using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateArchive(ref IArchiveStore? store) => store = new PgArchiveStore(Database);
}
