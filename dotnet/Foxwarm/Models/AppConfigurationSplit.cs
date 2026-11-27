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
/// <summary>
/// A path of the app configuration as its actual key segments: a top-level key, or a child of
/// <c>bot</c> or <c>journal</c>. A literal top-level key that contains a dot is one segment, so it
/// never reads as a nested path. Shown as <c>key</c> or <c>key.child</c>.
/// </summary>
internal readonly record struct ConfigPath(string Key, string? Child = null)
{
    // A declared path of this file's lists, written `key` or `key.child`.
    internal static ConfigPath Declared(string path) =>
        path.IndexOf('.') is var dot and >= 0 ? new(path[..dot], path[(dot + 1)..]) : new(path);

    public override string ToString() => Child is null ? Key : Key + "." + Child;
}

internal static class AppConfigurationSplit
{
    // Whether `path` is one of the declared paths of `list`.
    internal static bool Contains(IReadOnlyList<string> list, ConfigPath path) =>
        list.Any(item => ConfigPath.Declared(item) == path);

    // Whether `path` is a deployment path, or a top-level key that holds deployment children
    // (`bot`, `journal`).
    private static bool Deployment(ConfigPath path) =>
        DeploymentPaths.Any(item =>
            ConfigPath.Declared(item) is var declared
            && (declared == path || path.Child is null && declared.Key == path.Key)
        );

    // The keys whose children are classified one by one; every other key is a whole setting.
    internal static bool Sectioned(string key) => key is "bot" or "journal";

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
        "operator",
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
            if (Contains(allowed, path))
                continue;
            if (Deployment(path))
                throw new InvalidDataException(
                    $"app config `{path}` is a deployment setting; set it in the deployment configuration."
                );
            if (Contains(UnavailablePaths, path) || Contains(OperatorTenantPaths, path))
                throw new InvalidDataException($"app config `{path}` isn't available in hosted mode.");
            throw new InvalidDataException($"app config `{path}` isn't a tenant setting.");
        }
    }

    /// <summary>
    /// A stored tenant <c>config</c> document as a runtime loads it. Deployment and unavailable
    /// paths refuse the load as they refuse an installation (P1). A path that isn't a tenant
    /// setting of any kind, such as a removed setting saved before P2's allowlist, is left out of
    /// the returned document and named in <paramref name="ignored"/>: it is never applied, and the
    /// tenant still starts. Installation refuses it (<see cref="RequireTenantDocument"/>).
    /// </summary>
    internal static JsonObject LoadTenantDocument(
        JsonObject tenant,
        TenantProfile profile,
        out IReadOnlyList<string> ignored
    )
    {
        var allowed = TenantPaths(profile);
        var unknown = Present(tenant, deployment: false)
            .Where(path =>
                !Contains(allowed, path)
                && !Deployment(path)
                && !Contains(UnavailablePaths, path)
                && !Contains(OperatorTenantPaths, path)
            )
            .ToArray();
        ignored = unknown.Select(path => path.ToString()).ToArray();
        if (unknown.Length == 0)
        {
            RequireTenantDocument(tenant, profile);
            return tenant;
        }
        var kept = (JsonObject)tenant.DeepClone();
        foreach (var path in unknown)
        {
            if (path.Child is null)
                kept.Remove(path.Key);
            else
                (kept[path.Key] as JsonObject)?.Remove(path.Child);
        }
        RequireTenantDocument(kept, profile);
        return kept;
    }

    /// <summary>The refusal of a WeWork channel with a callback listener in hosted mode.</summary>
    internal const string WeWorkCallbackUnavailable =
        "WeWork callback mode isn't available in this deployment; use WebSocket mode.";

    /// <summary>
    /// Whether a channel is a WeWork channel in callback mode: its own HTTP listener on
    /// <c>listenPort</c>/<c>listenPath</c>. In hosted mode that listener would bind a port of the
    /// replica outside the tenant's request routing; webhook (send-only) and WebSocket modes
    /// need no listener.
    /// </summary>
    internal static bool WeWorkCallbackListener(string id, JsonObject channel) =>
        Foxwarm.Channels.ManagedChannels.Type(id, channel) == "wework"
        && (
            Foxwarm.Sessions.SessionWait.Number(channel["listenPort"]) is { } port && port != 0
            || !string.IsNullOrWhiteSpace(Foxwarm.Sessions.SessionWait.Text(channel["listenPath"]))
        );

    /// <summary>Refuses channel settings hosted mode can't serve (installation and import).</summary>
    internal static void RequireHostedChannels(JsonObject tenant)
    {
        if (tenant["channels"] is not JsonObject channels)
            return;
        foreach (var (id, value) in channels)
            if (value is JsonObject channel && WeWorkCallbackListener(id, channel))
                throw new InvalidDataException(WeWorkCallbackUnavailable);
    }

    /// <summary>Refuses every path but the deployment paths in the deployment configuration.</summary>
    internal static void RequireDeploymentDocument(JsonObject deployment)
    {
        foreach (var path in Present(deployment, deployment: true))
            if (!Contains(DeploymentPaths, path))
                throw new InvalidDataException(
                    Contains(UnavailablePaths, path)
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
    private static IEnumerable<ConfigPath> Present(JsonObject document, bool deployment)
    {
        foreach (var (key, value) in document)
        {
            if ((key == "bot" || deployment && key == "journal") && value is JsonObject section)
                foreach (var (child, _) in section)
                    yield return new(key, child);
            else
                yield return new(key);
        }
    }
}
