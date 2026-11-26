using System.Text.Json.Nodes;

namespace Foxwarm.Models;

/// <summary>
/// The split of the app configuration in hosted mode. The operator's deployment configuration
/// holds the deployment paths; the tenant's <c>config</c> document holds only the paths its
/// profile allows (<see cref="TenantPaths"/>). The two key sets are disjoint, so the effective
/// app configuration is the tenant document with the deployment values laid over it. Settings
/// of features hosted mode doesn't have are accepted by neither side. File mode reads one app
/// file and never uses this split.
/// </summary>
internal static class AppConfigurationSplit
{
    /// <summary>The paths the deployment configuration holds, as <c>key</c> or <c>key.child</c>.</summary>
    internal static readonly IReadOnlyList<string> DeploymentPaths =
    [
        "url",
        "bot.httpHost",
        "bot.httpPort",
        "bot.enableWebUI",
        "asrService",
        "nodeProviders",
        "blobs",
        "journal.retentionDays",
        "health",
        "egress",
    ];

    /// <summary>
    /// Paths of settings hosted mode has no feature for: removed or paused features, those it
    /// forbids, and installation-local paths. Hosted mode refuses them in either document.
    /// </summary>
    internal static readonly IReadOnlyList<string> UnavailablePaths =
    [
        "paths",
        "sessionWorkers",
        "dbWorkers",
        "vector",
        "vectorMaintenance",
        "claudeCode",
        "bot.enableTUI",
        "bot.enableTrigger",
    ];

    /// <summary>
    /// The paths a hosted tenant's <c>config</c> document may hold, as <c>key</c> or
    /// <c>bot.child</c>; a key's own children are validated by the app rules.
    /// </summary>
    private static readonly IReadOnlyList<string> HostedTenantPaths =
    [
        "access",
        "agentDefaultNode",
        "agentTree",
        "bot.name",
        "channels",
        "llm",
        "nodeTree",
        "sessionAutoTitle",
    ];

    /// <summary>The operator profile adds the settings of the features only it has.</summary>
    private static readonly IReadOnlyList<string> OperatorTenantPaths =
    [
        .. HostedTenantPaths,
        "claudeCode",
    ];

    /// <summary>The paths a tenant <c>config</c> document of <paramref name="profile"/> may hold.</summary>
    internal static IReadOnlyList<string> TenantPaths(TenantProfile profile) =>
        profile == TenantProfile.Operator ? OperatorTenantPaths : HostedTenantPaths;

    /// <summary>
    /// Refuses every path of a tenant <c>config</c> document that its profile doesn't allow,
    /// naming it: deployment paths, paths of features the profile doesn't have, and unknown paths.
    /// </summary>
    internal static void RequireTenantDocument(
        JsonObject tenant,
        TenantProfile profile = TenantProfile.Hosted
    )
    {
        var allowed = TenantPaths(profile);
        foreach (var path in Present(tenant, deployment: false))
        {
            if (allowed.Contains(path))
                continue;
            if (
                DeploymentPaths.Any(item =>
                    item == path || item.StartsWith(path + ".", StringComparison.Ordinal)
                )
            )
                throw new InvalidDataException(
                    $"app config `{path}` is a deployment setting; set it in the deployment configuration."
                );
            if (UnavailablePaths.Contains(path) || OperatorTenantPaths.Contains(path))
                throw new InvalidDataException($"app config `{path}` isn't available in hosted mode.");
            throw new InvalidDataException($"app config `{path}` isn't a tenant setting.");
        }
    }

    /// <summary>Refuses every path but the deployment paths in the deployment configuration.</summary>
    internal static void RequireDeploymentDocument(JsonObject deployment)
    {
        foreach (var path in Present(deployment, deployment: true))
            if (!DeploymentPaths.Contains(path))
                throw new InvalidDataException(
                    UnavailablePaths.Contains(path)
                        ? $"deployment configuration `{path}` isn't available in hosted mode."
                        : $"deployment configuration `{path}` isn't a deployment setting; tenant settings belong in the tenant configuration."
                );
    }

    /// <summary>The effective app configuration: <paramref name="tenant"/> with the deployment values.</summary>
    internal static JsonObject Merge(JsonObject deployment, JsonObject tenant)
    {
        var effective = (JsonObject)tenant.DeepClone();
        foreach (var (key, value) in deployment)
        {
            if (key != "bot")
            {
                effective[key] = value?.DeepClone();
                continue;
            }
            if (value is not JsonObject bot)
                throw new InvalidDataException("deployment configuration `bot` must be a mapping.");
            var target = effective["bot"] switch
            {
                null => (JsonObject)(effective["bot"] = new JsonObject()),
                JsonObject existing => existing,
                _ => throw new InvalidDataException("app config `bot` must be a mapping."),
            };
            foreach (var (child, setting) in bot)
                target[child] = setting?.DeepClone();
        }
        return effective;
    }

    // The top-level keys of a document, with `bot` listed by its children: `bot` mixes tenant
    // (`bot.name`) and deployment (`bot.httpPort`) settings. The deployment side also lists
    // `journal` by its children, which only some are settings of.
    private static IEnumerable<string> Present(JsonObject document, bool deployment)
    {
        foreach (var (key, value) in document)
        {
            if ((key == "bot" || deployment && key == "journal") && value is JsonObject section)
                foreach (var (child, _) in section)
                    yield return key + "." + child;
            else
                yield return key;
        }
    }
}
