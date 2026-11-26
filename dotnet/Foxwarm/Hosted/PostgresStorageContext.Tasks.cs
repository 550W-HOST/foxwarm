using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateTasks(ref ITaskRowStore? store) => store = new PgTaskRowStore(Database);
}
