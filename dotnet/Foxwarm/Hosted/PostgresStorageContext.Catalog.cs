using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateCatalog(ref ISessionCatalogStore? store) =>
        store = new PgSessionCatalog(Database);
}
