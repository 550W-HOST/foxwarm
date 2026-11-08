using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    internal InstanceSecrets Secrets { get; }

    private void RegisterSecretSources()
    {
        Secrets.AddSource(
            "models",
            () =>
                File.Exists(ActivePath)
                    ? ModelLiterals(
                        ConfigurationYaml.Parse(
                            File.ReadAllText(ActivePath, Encoding.UTF8),
                            "models config"
                        )
                    )
                    : []
        );
        Secrets.AddSource(
            "config",
            () =>
                AppLiterals(ConfigurationYaml.Parse(ReadCurrentAppRaw(), "app config"))
                    .Concat(
                        Access.Snapshot.Select(pair => new KnownSecret(
                            "access." + pair.Key,
                            pair.Value.Token
                        ))
                    )
        );
        Secrets.AddSource(
            "instance",
            () =>
            {
                var values = new List<KnownSecret>();
                if (Access.ReservedInstanceToken is { Length: > 0 } token)
                    values.Add(new KnownSecret("instance-token", token));
                var capability = Path.Combine(
                    Paths.DataRoot,
                    "state",
                    "node_event_capability_secret"
                );
                if (File.Exists(capability))
                    values.Add(
                        new KnownSecret("node-event-secret", File.ReadAllText(capability).Trim())
                    );
                return values;
            }
        );
    }

    // Where each secret name is referenced, for Setup. Unreadable files contribute nothing.
    internal IReadOnlyDictionary<string, List<JsonObject>> SecretUsages(JsonObject mcpServers)
    {
        var usages = new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal);
        void Add(JsonNode? node, string kind, string id)
        {
            foreach (var name in SecretReferences.ReferencedNames(node))
            {
                if (!usages.TryGetValue(name, out var list))
                    usages[name] = list = [];
                if (
                    !list.Any(item =>
                        SessionWait.Text(item["kind"]) == kind && SessionWait.Text(item["id"]) == id
                    )
                )
                    list.Add(new JsonObject { ["kind"] = kind, ["id"] = id });
            }
        }
        try
        {
            if (File.Exists(ActivePath))
            {
                var root = ConfigurationYaml.Parse(
                    File.ReadAllText(ActivePath, Encoding.UTF8),
                    "models config"
                );
                if ((root["providers"] ?? root["models"]) is JsonObject providers)
                    foreach (var (key, provider) in providers)
                        Add(provider, "provider", key);
            }
        }
        catch (Exception error) when (error is IOException or InvalidDataException) { }
        try
        {
            var current = ConfigurationYaml.Parse(ReadCurrentAppRaw(), "app config");
            if (current["channels"] is JsonObject channels)
                foreach (var (id, channel) in channels)
                    Add(channel, "channel", id);
            if (current["llm"] is JsonObject llm)
                foreach (var (key, value) in llm)
                    Add(value, "setting", "llm." + key);
            Add(current["asrService"], "setting", "asrService.key");
        }
        catch (Exception error) when (error is IOException or InvalidDataException) { }
        foreach (var (name, server) in mcpServers)
            Add(server, "mcp", name);
        return usages;
    }

    internal static IEnumerable<KnownSecret> ModelLiterals(JsonObject root) =>
        InstanceSecrets.Literals(
            SecretSinks.Models,
            root,
            path =>
                "models."
                + (
                    path.StartsWith("providers.", StringComparison.Ordinal)
                        ? path["providers.".Length..]
                    : path.StartsWith("models.", StringComparison.Ordinal)
                        ? path["models.".Length..]
                    : path
                )
        );

    internal static IEnumerable<KnownSecret> AppLiterals(JsonObject app) =>
        InstanceSecrets.Literals(SecretSinks.App, app, path => "config." + path);

    // Resolves sink references for one catalog generation. Missing names are recorded per
    // provider (including a legacy llm fallback key the provider would use), so only the
    // affected providers fail; the rest of the catalog stays usable.
    private (
        JsonObject Root,
        JsonObject App,
        IReadOnlyDictionary<string, IReadOnlyList<string>> Missing
    ) ResolveModelSecrets(JsonObject root)
    {
        SecretReferences.Validate(root, SecretSinks.Models, "Models configuration");
        string? Lookup(string name)
        {
            try
            {
                return Secrets.Lookup(name);
            }
            catch (SecretStoreLockedException)
            {
                return null;
            }
        }
        var resolvedApp = app;
        var fallback = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        if (app["llm"] is JsonObject llm)
            foreach (var family in new[] { "openai", "anthropic" })
                if (
                    SessionWait.Text(llm[family + "ApiKey"]) is string text
                    && SecretReferences.Contains(text)
                )
                {
                    if (ReferenceEquals(resolvedApp, app))
                        resolvedApp = (JsonObject)app.DeepClone();
                    var names = new List<string>();
                    resolvedApp["llm"]![family + "ApiKey"] = SecretReferences.Resolve(
                        text,
                        Lookup,
                        names
                    );
                    fallback[family] = names;
                }
        var missing = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var resolved = (JsonObject)root.DeepClone();
        var mapName = resolved["providers"] is not null ? "providers" : "models";
        if (resolved[mapName] is JsonObject providers)
            foreach (var key in providers.Select(pair => pair.Key).ToArray())
            {
                if (providers[key] is not JsonObject provider)
                    continue;
                var names = new List<string>();
                var wrapped = new JsonObject
                {
                    [mapName] = new JsonObject { [key] = provider.DeepClone() },
                };
                var result = SecretReferences.Resolve(
                    wrapped,
                    SecretSinks.Models,
                    "Models configuration",
                    Lookup,
                    names
                );
                providers[key] = result[mapName]![key]!.DeepClone();
                var type =
                    HostModels.Text(provider, "providerType")
                    ?? HostModels.Text(provider, "provider")
                    ?? "openai-completions";
                var family =
                    type == "anthropic" ? "anthropic"
                    : type is "openai" or "openai-responses" or "openai-ws" or "openai-completions"
                        ? "openai"
                    : null;
                if (
                    HostModels.Text(provider, "apiKey") is null
                    && family is not null
                    && fallback.TryGetValue(family, out var inherited)
                )
                    names.AddRange(inherited.Where(name => !names.Contains(name)));
                if (names.Count > 0)
                    missing[key] = names;
            }
        return (resolved, resolvedApp, missing);
    }
}
