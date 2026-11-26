using Foxwarm.Hosted.Postgres;
using Foxwarm.ToolScript;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    partial void CreateToolScriptRuns(ref IToolScriptRunStore? store) =>
        store = new PgToolScriptRunStore(Database, ScratchRoot);
}
