using Foxwarm.Hosted.Postgres;
using Foxwarm.Tools;

namespace Foxwarm.Hosted;

/// <summary>
/// The operator ceiling documents in <c>operator_documents</c>: one per profile
/// (<c>scope = 'global'</c>, name <c>ceiling.&lt;profile&gt;</c>) and an optional per-tenant
/// override (<c>scope = 'tenant'</c>, name <c>ceiling</c>). A tenant's override replaces its
/// profile's document; without either, no ceiling applies. The operator role writes them and
/// validates them with <see cref="OperatorCeiling.Parse"/>; a change signals
/// <c>NOTIFY foxwarm_operator</c>, on which the owner invalidates the tenant's policy cache.
/// </summary>
internal sealed class OperatorCeilingDocuments(TenantDb database, TenantProfile profile) : IOperatorCeilingSource
{
    internal const string TenantDocument = "ceiling";

    internal static string ProfileDocument(TenantProfile profile) => "ceiling." + TenantProfiles.Name(profile);

    /// <summary>
    /// The document that applies to this tenant now: its override when present, else its
    /// profile's. Read in one statement, so an override replaced concurrently never mixes with
    /// the profile document.
    /// </summary>
    public OperatorCeilingDocument? Read() =>
        database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT scope, text FROM operator_documents"
                    + " WHERE (scope = 'tenant' AND tenant_id = $1 AND name = $2)"
                    + " OR (scope = 'global' AND name = $3)"
                    + " ORDER BY scope = 'tenant' DESC LIMIT 1",
                tx.TenantId,
                TenantDocument,
                ProfileDocument(profile)
            );
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                return null;
            return new OperatorCeilingDocument(
                reader.GetString(0) == "tenant" ? "tenant" : "profile:" + TenantProfiles.Name(profile),
                reader.GetString(1)
            );
        });
}
