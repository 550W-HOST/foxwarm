using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateDocuments(ref IStateDocuments? store) => store = new PgStateDocuments(Database);
}
