using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Providers;

internal sealed class ProviderGrants(DeploymentConfiguration deployment, Action<string>? diagnostic = null)
{
    // The operator checks the deployment declaration, never an assertion supplied by the
    // caller or a subprocess started by the operator.
    internal ProviderQuotas Validate(
        string providerId, TenantProfile profile, JsonNode? quotas, CancellationToken token
    )
    {
        token.ThrowIfCancellationRequested();
        if (deployment.Root["nodeProviders"]?[providerId] is not JsonObject definition
            || providerId is "master" or "authenticated-remote")
            throw new InvalidDataException($"Provider '{providerId}' is not configured in this deployment.");
        if (profile == TenantProfile.Hosted && SessionWait.Text(definition["tenancy"]) != "per-tenant")
            throw new InvalidDataException($"Provider '{providerId}' doesn't support per-tenant use.");
        if (quotas is not JsonObject values)
            throw new InvalidDataException("Provider quotas must be an object.");
        foreach (var (key, _) in values)
            if (key is not ("nodes" or "execs" or "lifecycleActionsPerHour"))
                throw new InvalidDataException($"Unknown Provider quota '{key}'.");

        int Count(string name, int fallback)
        {
            if (!values.ContainsKey(name)) return fallback;
            if (values[name] is JsonValue number && number.GetValueKind() == JsonValueKind.Number
                && int.TryParse(number.ToJsonString(), NumberStyles.None, CultureInfo.InvariantCulture, out var count))
                return count;
            throw new InvalidDataException($"Provider quota '{name}' must be a non-negative integer.");
        }

        var defaults = new ProviderQuotas();
        return new(
            Count("nodes", defaults.Nodes),
            Count("execs", defaults.Execs),
            Count("lifecycleActionsPerHour", defaults.LifecycleActionsPerHour)
        );
    }

    internal async Task<TenantProviders> LoadAsync(
        TenantDb database, string slug, TenantProfile profile, CancellationToken token, bool applyGrants = true
    )
    {
        var grants = await database.ReadAsync(async (tx, ct) =>
        {
            var rows = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
            if (!applyGrants)
            {
                using var any = tx.Command("SELECT 1 FROM provider_grants WHERE tenant_id=$1 LIMIT 1", database.TenantId);
                if (await any.ExecuteScalarAsync(ct).ConfigureAwait(false) is not null)
                    (diagnostic ?? Console.Error.WriteLine)("Provider grants aren't applied in single-tenant hosted mode.");
                return rows;
            }
            using var cmd = tx.Command(
                "SELECT provider_id, quotas::text FROM provider_grants WHERE tenant_id=$1", database.TenantId
            );
            await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
                rows.Add(reader.GetString(0), JsonNode.Parse(reader.GetString(1)));
            return rows;
        }, token: token).ConfigureAwait(false);

        var selected = new TenantProviders();
        var definitions = deployment.Root["nodeProviders"] as JsonObject ?? new();
        foreach (var id in grants.Keys.Where(id => !definitions.ContainsKey(id)))
            selected.Problems[id] = "tenancy-mismatch";
        foreach (var (id, raw) in definitions)
        {
            bool granted = grants.TryGetValue(id, out var quotas);
            if (!granted && profile == TenantProfile.Hosted) continue;
            var definition = (JsonObject)raw!;
            ProviderQuotas? limits;
            try
            {
                limits = granted ? Validate(id, profile, quotas, token) : null;
            }
            catch (InvalidDataException)
            {
                selected.Problems[id] = "tenancy-mismatch";
                continue;
            }
            var extended = SessionWait.Text(definition["tenancy"]) == "per-tenant";
            var driver = new ExecutableNodeProvider(id, definition)
            {
                TenantId = extended ? database.TenantId : null,
                Quotas = limits,
                Stderr = line => (diagnostic ?? Console.Error.WriteLine)($"[provider:{id}] [tenant:{slug}] {line}"),
                ChargeLifecycle = limits is null ? null
                    : ct => ChargeLifecycleAsync(database, id, limits.LifecycleActionsPerHour, ct),
            };
            try
            {
                var actual = await driver.DescribeAsync(token).ConfigureAwait(false);
                if ((SessionWait.Text(actual["tenancy"]) == "per-tenant") != extended)
                    selected.Problems[id] = "tenancy-mismatch";
                else
                    selected.Drivers.Add(id, driver);
            }
            catch (Exception error) when (!token.IsCancellationRequested
                && error is IOException or InvalidOperationException or JsonException)
            {
                selected.Problems[id] = error is NodeProviderException
                    { Code: "NODE_PROVIDER_TENANT_MISMATCH" or "NODE_PROVIDER_TENANCY_MISMATCH" }
                    ? "tenancy-mismatch" : "describe-failed";
            }
        }
        // A qualified child cannot stand in for an unavailable Provider parent. Remove the
        // affected subtree before the Node registry validates the remaining inventory.
        bool removed;
        do
        {
            removed = false;
            foreach (var (id, driver) in selected.Drivers.ToArray())
            {
                if (driver.ParentNode is not { } parent) continue;
                var slash = parent.IndexOf('/');
                if (slash < 0 || selected.Drivers.ContainsKey(parent[..slash])) continue;
                selected.Drivers.Remove(id);
                selected.Problems[id] = "parent-not-granted";
                removed = true;
            }
        } while (removed);
        return selected;
    }

    // Persist before dispatch: losing the driver's response still consumes a lifecycle action.
    // The tenant store fences writers across moves; row locking serializes concurrent inspections.
    private static Task ChargeLifecycleAsync(TenantDb database, string id, int limit, CancellationToken token) =>
        database.WriteAsync(async (tx, ct) =>
        {
            const string key = "provider-lifecycle";
            await tx.ExecuteAsync(
                "INSERT INTO state_documents(tenant_id,name,text) VALUES($1,$2,'{}') ON CONFLICT DO NOTHING",
                ct, database.TenantId, key
            );
            using var read = tx.Command(
                "SELECT text,(extract(epoch FROM clock_timestamp())*1000)::bigint FROM state_documents WHERE name=$1 FOR UPDATE", key
            );
            JsonObject history;
            long now;
            await using (var row = await read.ExecuteReaderAsync(ct))
            {
                await row.ReadAsync(ct);
                history = JsonNode.Parse(row.GetString(0))!.AsObject();
                now = row.GetInt64(1);
            }
            var recent = new JsonArray();
            foreach (var time in history[id] as JsonArray ?? [])
                if (time!.GetValue<long>() > now - 3_600_000) recent.Add(time.DeepClone());
            if (recent.Count >= limit)
                throw new NodeProviderException(
                    "NODE_PROVIDER_LIFECYCLE_LIMIT",
                    $"This tenant has reached its limit of {limit} Node lifecycle actions per hour on Provider '{id}'. Try again later."
                );
            recent.Add(JsonValue.Create(now));
            history[id] = recent;
            return await tx.ExecuteAsync(
                "UPDATE state_documents SET text=$2,generation=generation+1,updated_at=now() WHERE name=$1",
                ct, key, history.ToJsonString()
            );
        }, token: token);
}
