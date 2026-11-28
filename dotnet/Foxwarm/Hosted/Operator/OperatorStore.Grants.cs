using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Providers;
using Foxwarm.Nodes;

namespace Foxwarm.Hosted.Operator;

internal sealed partial class OperatorStore
{
    private static JsonObject Quotas(ProviderQuotas quotas) =>
        new()
        {
            ["nodes"] = quotas.Nodes,
            ["execs"] = quotas.Execs,
            ["lifecycleActionsPerHour"] = quotas.LifecycleActionsPerHour,
        };

    internal Task<JsonNode> ReadGrantsAsync(string slug, CancellationToken token) =>
        database.ClusterAsync(
            async (tx, ct) =>
            {
                // Select only the public fields. PostgreSQL's JSON text keeps a missing
                // key (SQL NULL) distinct from an invalid JSON null or quoted number.
                await using var cmd = tx.Command(
                    """
                    SELECT g.provider_id,(g.quotas->'nodes')::text,(g.quotas->'execs')::text,(g.quotas->'lifecycleActionsPerHour')::text
                    FROM tenants t LEFT JOIN provider_grants g USING(tenant_id) WHERE t.name=$1 ORDER BY g.provider_id
                    """,
                    slug
                );
                await using var row = await cmd.ExecuteReaderAsync(ct);
                if (!await row.ReadAsync(ct))
                    throw Missing();
                var result = new JsonObject();
                var defaults = new ProviderQuotas();
                do
                {
                    if (row.IsDBNull(0))
                        break;
                    var id = row.GetString(0);
                    int Count(int field, int fallback)
                    {
                        if (row.IsDBNull(field)) return fallback;
                        if (int.TryParse(row.GetString(field), NumberStyles.None, CultureInfo.InvariantCulture, out var value))
                            return value;
                        throw new OperatorProblem(409, $"Provider '{id}' has invalid stored quotas. Replace or remove its grant.");
                    }
                    result[id] = Quotas(
                        new(
                            Count(1, defaults.Nodes),
                            Count(2, defaults.Execs),
                            Count(3, defaults.LifecycleActionsPerHour)
                        )
                    );
                } while (await row.ReadAsync(ct));
                return (JsonNode)result;
            },
            token
        );

    internal Task<JsonObject> ChangeGrantAsync(
        string slug,
        string providerId,
        JsonObject? requested,
        ProviderGrants validator,
        CancellationToken token
    ) =>
        database.ClusterAsync(
            async (tx, ct) =>
            {
                int id;
                TenantProfile profile;
                await using (
                    var cmd = tx.Command(
                        "SELECT tenant_id,profile FROM tenants WHERE name=$1 AND state<>'deleting' FOR UPDATE",
                        slug
                    )
                )
                await using (var row = await cmd.ExecuteReaderAsync(ct))
                {
                    if (!await row.ReadAsync(ct))
                        throw Missing();
                    id = row.GetInt32(0);
                    profile = TenantProfiles.Parse(row.GetString(1));
                }
                // Use the stored profile inside its lock. Revocation must also work for an ID
                // removed from the current deployment, so only grant creation invokes validation.
                var changed = requested is null
                    ? await tx.ExecuteAsync(
                        "DELETE FROM provider_grants WHERE tenant_id=$1 AND provider_id=$2",
                        ct,
                        id,
                        providerId
                    )
                    : await tx.ExecuteAsync(
                        """
                        INSERT INTO provider_grants(tenant_id,provider_id,quotas) VALUES ($1,$2,$3::jsonb)
                        ON CONFLICT(tenant_id,provider_id) DO UPDATE SET quotas=excluded.quotas
                        WHERE ($4::jsonb || provider_grants.quotas) IS DISTINCT FROM excluded.quotas
                        """,
                        ct,
                        id,
                        providerId,
                        Quotas(validator.Validate(providerId, profile, requested, ct))
                            .ToJsonString(),
                        Quotas(new()).ToJsonString()
                    );
                if (changed != 0)
                {
                    await tx.ExecuteAsync(
                        "UPDATE tenants SET settings_revision=settings_revision+1 WHERE tenant_id=$1",
                        ct,
                        id
                    );
                    await tx.ExecuteAsync("SELECT pg_notify('foxwarm_tenants','')", ct);
                }
                return new JsonObject
                {
                    ["slug"] = slug,
                    ["providerId"] = providerId,
                    ["changed"] = changed != 0,
                };
            },
            token
        );
}
