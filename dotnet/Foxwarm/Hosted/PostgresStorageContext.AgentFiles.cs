using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    private IBlobStore? agentFileBlobs;

    /// <summary>
    /// The tenant's Agent store limits; read at every write admission. The defaults are plan
    /// §7.2's; per-tenant settings replace them.
    /// </summary>
    internal Func<AgentStoreLimits> AgentStoreLimits { get; set; } = () => Sessions.AgentStoreLimits.Default;

    /// <summary>Large Agent file contents, on the deployment's blob backend.</summary>
    internal IBlobStore AgentFileBlobs => Require(agentFileBlobs);

    partial void CreateAgentFiles(ref IAgentStore? store)
    {
        agentFileBlobs ??= new PgBlobStore(Database, PgAgentFileStore.BlobStoreName);
        store = new PgAgentFileStore(Database, agentFileBlobs, () => AgentStoreLimits());
    }
}
