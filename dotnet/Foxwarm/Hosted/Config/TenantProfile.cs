using Foxwarm.Hosted.Postgres;

namespace Foxwarm.Hosted;

/// <summary>Reads a tenant's stored <see cref="TenantProfile"/>.</summary>
internal static class TenantProfileStore
{
    /// <summary>
    /// The transaction tenant's stored profile. Runtime construction reads it here; acquisition,
    /// which reads the same <c>tenants</c> row for its state check, can read it with this too
    /// (the operator profile is valid only on a master-host replica).
    /// </summary>
    internal static TenantProfile Read(PgTx tx) =>
        TenantProfiles.Parse(tx.Scalar("SELECT profile FROM tenants WHERE tenant_id = $1", tx.TenantId) as string);

    /// <summary>The stored profile of <paramref name="database"/>'s tenant.</summary>
    internal static Task<TenantProfile> ReadAsync(TenantDb database, CancellationToken token = default) =>
        database.ReadAsync((tx, _) => Task.FromResult(Read(tx)), token: token);
}
