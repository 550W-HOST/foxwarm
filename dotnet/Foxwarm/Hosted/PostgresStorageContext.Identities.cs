using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateIdentities(ref IIdentityLedger? store) => store = new PgIdentityLedger(Database);
}
