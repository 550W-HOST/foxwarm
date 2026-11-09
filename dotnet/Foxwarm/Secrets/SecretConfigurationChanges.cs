using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

// Model-initiated configuration writes must not choose where a stored secret is sent.
// Until policy can grant that use explicitly, set_config and mcp_config may leave
// secret-bearing entries unchanged but may not add references or edit those entries.
internal static class SecretConfigurationChanges
{
    internal const string SetConfigDenied =
        "set_config cannot change {0}: it uses stored secrets. Ask the user to make this change in Setup or in the configuration file.";

    internal const string McpReferenceDenied =
        "mcp_config cannot add secret references. Ask the user to add the ${secret:NAME} reference to this server's configuration.";

    internal const string McpServerDenied =
        "MCP server \"{0}\" uses stored secrets. mcp_config can only enable or disable it or change its description or timeout; ask the user to make other changes.";

    internal static void RequireModelWritable(
        ModelConfiguration configuration,
        string target,
        string raw
    )
    {
        SecretMarkerGuard.Require(raw, configuration.Secrets.Redactor.HasLabel);
        JsonObject candidate;
        JsonObject current;
        try
        {
            if (target == "models")
            {
                candidate = ConfigurationYaml.Parse(raw, "models config");
                current = File.Exists(configuration.ActivePath)
                    ? ConfigurationYaml.Parse(
                        File.ReadAllText(configuration.ActivePath, Encoding.UTF8),
                        "models config"
                    )
                    : new JsonObject();
            }
            else
            {
                candidate = ConfigurationYaml.Parse(raw, "app config");
                current = ConfigurationYaml.Parse(configuration.ReadCurrentAppRaw(), "app config");
            }
        }
        catch (InvalidDataException)
        {
            // Installation validation reports the canonical parse error.
            return;
        }
        var app = target == "models" ? configuration.AppConfiguration : current;
        if (target != "models")
            RequireInheritedUrls(configuration, current, candidate);
        foreach (var (unit, before, after, inherited) in Units(target, current, candidate, app))
            if (
                !JsonNode.DeepEquals(before, after)
                && (
                    inherited
                    || SecretReferences.ReferencedNames(before).Count > 0
                    || SecretReferences.ReferencedNames(after).Count > 0
                )
            )
                throw new InvalidDataException(string.Format(SetConfigDenied, unit));
        if (target == "models")
            RequireDetectorRoutes(current, candidate, app);
    }

    // Detector settings inherit field by field, so an endpoint at any level can redirect a
    // referenced key from another level. Compare each concrete leaf's effective settings as
    // the catalog itself enumerates and resolves them, before and after the edit. An existing
    // leaf whose detector key is a reference must keep its endpoint, key source and
    // enablement. A new leaf (added or renamed) may use a referenced key only with an endpoint
    // that key is already paired with, so it cannot newly send the key anywhere; removing a
    // leaf sends nothing anywhere.
    private static void RequireDetectorRoutes(
        JsonObject current,
        JsonObject candidate,
        JsonObject app
    )
    {
        // A candidate the catalog rejects is refused with the catalog's own error, so no
        // leaf escapes this comparison. An unreadable current file makes every leaf new.
        var after = DetectorRoutes(HostModels.Parse(candidate, app));
        Dictionary<string, DetectorRoute> before;
        var paired = new HashSet<(string? Endpoint, string? ApiKey)>();
        try
        {
            before = DetectorRoutes(HostModels.Parse(current, app));
            foreach (var route in before.Values)
                paired.Add((route.Endpoint, route.ApiKey));
            if (current["defaults"]?["textRedaction"] is JsonObject defaults)
                paired.Add(
                    (SessionWait.Text(defaults["endpoint"]), SessionWait.Text(defaults["apiKey"]))
                );
        }
        catch (InvalidDataException)
        {
            before = [];
        }
        foreach (var (key, route) in after)
        {
            var changed = before.TryGetValue(key, out var previous)
                ? route != previous
                    && (
                        SecretReferences.Contains(route.ApiKey)
                        || SecretReferences.Contains(previous.ApiKey)
                    )
                : SecretReferences.Contains(route.ApiKey)
                    && route.Endpoint is not null
                    && !paired.Contains((route.Endpoint, route.ApiKey));
            if (changed)
                throw new InvalidDataException(
                    string.Format(SetConfigDenied, "text redaction for model " + key)
                );
        }
    }

    private sealed record DetectorRoute(bool Enabled, string? Endpoint, string? ApiKey);

    // Raw documents keep reference text, so ApiKey is the configured key source.
    private static Dictionary<string, DetectorRoute> DetectorRoutes(HostModels catalog)
    {
        var routes = new Dictionary<string, DetectorRoute>(StringComparer.Ordinal);
        foreach (var (key, model) in catalog.Entries)
        {
            if (model.IsVirtual || model.Configuration["textRedaction"] is not JsonObject settings)
                continue;
            routes[key] = new(
                settings["enabled"]?.GetValue<bool>() == true,
                SessionWait.Text(settings["endpoint"]),
                SessionWait.Text(settings["apiKey"])
            );
        }
        return routes;
    }

    internal static void RequireMcpWritable(string name, JsonObject? existing, JsonObject patch)
    {
        if (SecretReferences.ReferencedNames(patch).Count > 0)
            throw new InvalidDataException(McpReferenceDenied);
        if (
            existing is not null
            && SecretReferences.ReferencedNames(existing).Count > 0
            && patch.Any(pair => pair.Key is not ("enable" or "description" or "timeoutSeconds"))
        )
            throw new InvalidDataException(string.Format(McpServerDenied, name));
    }

    private static IEnumerable<(
        string Unit,
        JsonNode? Before,
        JsonNode? After,
        bool Inherited
    )> Units(string target, JsonObject current, JsonObject candidate, JsonObject app)
    {
        if (target == "models")
        {
            var before =
                (current["providers"] ?? current["models"]) as JsonObject ?? new JsonObject();
            var after =
                (candidate["providers"] ?? candidate["models"]) as JsonObject ?? new JsonObject();
            foreach (
                var key in before.Select(pair => pair.Key).Union(after.Select(pair => pair.Key))
            )
                yield return (
                    "provider " + key,
                    before[key],
                    after[key],
                    UsesReferencedFallback(before[key], app)
                        || UsesReferencedFallback(after[key], app)
                );
            yield break;
        }
        var channelsBefore = current["channels"] as JsonObject ?? new JsonObject();
        var channelsAfter = candidate["channels"] as JsonObject ?? new JsonObject();
        foreach (
            var id in channelsBefore
                .Select(pair => pair.Key)
                .Union(channelsAfter.Select(pair => pair.Key))
        )
            yield return ("channel " + id, channelsBefore[id], channelsAfter[id], false);
        yield return ("llm", current["llm"], candidate["llm"], false);
        yield return ("asrService", current["asrService"], candidate["asrService"], false);
    }

    // A provider without its own key uses the legacy llm key of its protocol family.
    private static bool UsesReferencedFallback(JsonNode? provider, JsonObject app)
    {
        if (provider is not JsonObject value || HostModels.Text(value, "apiKey") is not null)
            return false;
        return Family(value) is { } family
            && SecretReferences.Contains(SessionWait.Text(app["llm"]?[family + "ApiKey"]));
    }

    // A provider without its own baseUrl sends its requests, and therefore any stored
    // secret it uses, to the llm base URL of its protocol family.
    private static void RequireInheritedUrls(
        ModelConfiguration configuration,
        JsonObject current,
        JsonObject candidate
    )
    {
        JsonObject models;
        try
        {
            models = File.Exists(configuration.ActivePath)
                ? ConfigurationYaml.Parse(
                    File.ReadAllText(configuration.ActivePath, Encoding.UTF8),
                    "models config"
                )
                : new JsonObject();
        }
        catch (InvalidDataException)
        {
            return;
        }
        var providers = (models["providers"] ?? models["models"]) as JsonObject ?? new JsonObject();
        foreach (var family in new[] { "openai", "anthropic" })
        {
            var field = family + "BaseUrl";
            if (JsonNode.DeepEquals(current["llm"]?[field], candidate["llm"]?[field]))
                continue;
            if (
                providers.Any(pair =>
                    pair.Value is JsonObject provider
                    && HostModels.Text(provider, "baseUrl") is null
                    && Family(provider) == family
                    && (
                        SecretReferences.ReferencedNames(provider).Count > 0
                        || UsesReferencedFallback(provider, current)
                        || UsesReferencedFallback(provider, candidate)
                    )
                )
            )
                throw new InvalidDataException(string.Format(SetConfigDenied, "llm." + field));
        }
    }

    private static string? Family(JsonObject provider)
    {
        var type =
            HostModels.Text(provider, "providerType")
            ?? HostModels.Text(provider, "provider")
            ?? "openai-completions";
        return type == "anthropic" ? "anthropic"
            : type is "openai" or "openai-responses" or "openai-ws" or "openai-completions"
                ? "openai"
            : null;
    }
}
