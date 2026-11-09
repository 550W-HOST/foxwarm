using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

// Which stored secrets a model-initiated configuration change would send somewhere new: the
// `secrets` authorization facts of set_config and mcp_config. Tool policy decides whether the
// caller may make the change.
//
// Each Main-owned consumer contributes routes, read the way the consumer reads its own
// configuration: where it sends a secret (destination), in which field, and the secret name. A
// route present after the change and absent before is a fact. Edits that change neither a
// destination nor where a reference is placed add no route, so model lists, context limits,
// feature flags, timeouts, descriptions, enablement and removals produce no fact.
internal static class SecretConfigurationChanges
{
    // Refusal when the secret part of a decision denies and its rule gives no reason.
    internal const string Denied =
        "Tool authorization rules don't allow this call to send stored secrets ({0}) to a new destination. Ask the user to make this change in Setup or in the configuration file.";

    internal static string DeniedMessage(IEnumerable<string> names) =>
        string.Format(Denied, string.Join(", ", names.Select(name => "`" + name + "`")));

    private readonly record struct Route(string Destination, string Field, string Name);

    // A set_config candidate for target models or config, compared with the files it replaces
    // as they are now. Installation calls this inside its serialized lane with the exact bytes
    // it installs.
    internal static IReadOnlyList<string> ForConfiguration(
        ModelConfiguration configuration,
        string target,
        string raw
    )
    {
        JsonObject candidate;
        try
        {
            candidate = ConfigurationYaml.Parse(
                raw,
                target == "models" ? "models config" : "app config"
            );
        }
        catch (Exception)
        {
            // Installation rejects the candidate; until then every reference in it counts.
            return SecretReferences.Scan(raw);
        }
        var models = Read(configuration.ReadCurrentModelsRaw, "models config");
        // The running catalog combines models with the app settings captured at startup; a
        // saved app file takes effect on restart. Routes under either count as existing, and a
        // models candidate is resolved under both, so a pending llm base URL cannot be adopted
        // later without a fact.
        JsonObject?[] apps =
        [
            configuration.AppConfiguration,
            Read(configuration.ReadCurrentAppRaw, "app config"),
        ];
        var before = new HashSet<Route>();
        foreach (var app in apps.OfType<JsonObject>())
        {
            Include(before, () => ModelRoutes(models, app));
            Include(before, () => AppRoutes(app));
        }
        var after = new HashSet<Route>();
        try
        {
            if (target == "models")
                foreach (var app in apps.OfType<JsonObject>())
                    after.UnionWith(ModelRoutes(candidate, app));
            else
            {
                after.UnionWith(ModelRoutes(models, candidate));
                after.UnionWith(AppRoutes(candidate));
            }
        }
        catch (Exception)
        {
            // Nothing can say where an unresolvable catalog sends its secrets: all of them count.
            // Installation rejects the same candidate.
            return Sorted(
                SecretReferences
                    .ReferencedNames(candidate)
                    .Concat(target == "models" ? [] : SecretReferences.ReferencedNames(models))
            );
        }
        return Added(before, after);
    }

    // A current document the catalog cannot resolve contributes no existing routes.
    private static void Include(HashSet<Route> routes, Func<HashSet<Route>> read)
    {
        try
        {
            routes.UnionWith(read());
        }
        catch (Exception) { }
    }

    // One mcp_config call: the patch merged into the server as the configuration owner merges it.
    internal static IReadOnlyList<string> ForMcpServer(
        JsonObject servers,
        string name,
        JsonObject patch
    )
    {
        var merged = servers[name] is JsonObject existing
            ? (JsonObject)existing.DeepClone()
            : new JsonObject();
        foreach (var (key, value) in patch)
            merged[key] = value?.DeepClone();
        var after = (JsonObject)servers.DeepClone();
        try
        {
            after[name] = McpConfiguration.Normalize(merged, managed: true);
        }
        catch (Exception)
        {
            // The update is rejected; until then every reference in the server counts.
            return Sorted(SecretReferences.ReferencedNames(merged));
        }
        return ForMcp(servers, after);
    }

    internal static IReadOnlyList<string> ForMcp(JsonObject before, JsonObject after) =>
        Added(McpRoutes(before), McpRoutes(after));

    private static IReadOnlyList<string> Added(HashSet<Route> before, HashSet<Route> after) =>
        Sorted(after.Where(route => !before.Contains(route)).Select(route => route.Name));

    private static IReadOnlyList<string> Sorted(IEnumerable<string> names) =>
        names.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();

    private static JsonObject? Read(Func<string?> raw, string label)
    {
        try
        {
            return raw() is { } text ? ConfigurationYaml.Parse(text, label) : null;
        }
        catch (Exception error)
            when (error is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static void Add(HashSet<Route> routes, string destination, string field, string? text)
    {
        if (!SecretReferences.Contains(text))
            return;
        IReadOnlyList<string> names;
        try
        {
            names = SecretReferences.Names(text!);
        }
        catch (InvalidDataException)
        {
            return;
        }
        foreach (var name in names)
            routes.Add(new(destination, field, name));
    }

    // Model providers, through the catalog's own resolution of each concrete model: the
    // provider protocol and effective base URL (its own, or the inherited llm base URL of its
    // family) receive the effective API key (its own, or the inherited llm key) and the merged
    // extra headers. Text redaction sends its key to the detector endpoint, resolved field by
    // field from defaults, provider and model.
    private static HashSet<Route> ModelRoutes(JsonObject? models, JsonObject app)
    {
        var routes = new HashSet<Route>();
        if (models is null)
            return routes;
        foreach (var (_, leaf) in HostModels.Parse(models, app).Entries)
        {
            if (leaf.IsVirtual)
                continue;
            if (leaf.BaseUrl is { } url)
            {
                var destination = "model " + leaf.ProviderType + " " + url;
                Add(routes, destination, "apiKey", leaf.Token);
                if (leaf.Configuration["extraHeaders"] is JsonObject headers)
                    foreach (var (header, value) in headers)
                        Add(
                            routes,
                            destination,
                            "header " + header.ToLowerInvariant(),
                            SessionWait.Text(value)
                        );
            }
            DetectorRoute(routes, leaf.Configuration["textRedaction"]);
        }
        return routes;
    }

    private static void DetectorRoute(HashSet<Route> routes, JsonNode? settings)
    {
        if (
            settings is JsonObject detector
            && SessionWait.Text(detector["endpoint"]) is { } endpoint
        )
            Add(
                routes,
                "text-redaction " + endpoint,
                "apiKey",
                SessionWait.Text(detector["apiKey"])
            );
    }

    // ASR sends its key to the service URL. The channel type picks the client, which sends its
    // credential to a fixed service host (Telegram, QQ Bot) or to a configured server: Matrix
    // `homeserver`, Weixin `baseUrl`, the WeWork bot `aibot.websocket.url`. WeWork `webhookUrl`
    // is its own destination, and WeWork `token`/`encodingAESKey` only verify and decrypt
    // inbound callbacks. llm keys and base URLs reach providers through the catalog.
    private static HashSet<Route> AppRoutes(JsonObject app)
    {
        var routes = new HashSet<Route>();
        if (
            app["asrService"] is JsonObject asr
            && SessionWait.Text(asr["url"])?.Trim().TrimEnd('/') is { Length: > 0 } service
        )
            Add(routes, "asr " + service, "key", SessionWait.Text(asr["key"]));
        if (app["channels"] is not JsonObject channels)
            return routes;
        foreach (var (id, value) in channels)
        {
            if (value is not JsonObject channel)
                continue;
            var type = SessionWait.Text(channel["type"])?.Trim() is { Length: > 0 } named
                ? named
                : id;
            string Setting(JsonNode? node) => SessionWait.Text(node)?.Trim() ?? "";
            var prefix = "channels." + id + ".";
            var wrapped = new JsonObject
            {
                ["channels"] = new JsonObject { [id] = channel.DeepClone() },
            };
            foreach (var field in SecretSinks.App.Fields(wrapped))
            {
                var name = Field(field, prefix);
                var destination =
                    "channel "
                    + type
                    + " "
                    + (type, name) switch
                    {
                        ("matrix", _) => Setting(channel["homeserver"]),
                        ("weixin", _) => Setting(channel["baseUrl"]),
                        ("wework", "aibot.websocket.secret") => Setting(
                            channel["aibot"]?["websocket"]?["url"]
                        ),
                        _ => "",
                    };
                Add(routes, destination, name, field.Value);
            }
        }
        return routes;
    }

    // An MCP stdio server is the process its command, arguments, working directory and
    // environment start; any of them decides which code receives the secret. An HTTP server
    // sends its token, headers and OAuth client secret to its URL.
    private static HashSet<Route> McpRoutes(JsonObject servers)
    {
        var routes = new HashSet<Route>();
        foreach (var (_, value) in servers)
        {
            if (value is not JsonObject server)
                continue;
            var transport = SessionWait.Text(server["transport"]) ?? "auto";
            var destination =
                transport == "stdio"
                    ? "mcp stdio "
                        + new JsonObject
                        {
                            ["command"] = server["command"]?.DeepClone(),
                            ["args"] = server["args"]?.DeepClone(),
                            ["cwd"] = server["cwd"]?.DeepClone(),
                            ["env"] = server["env"]?.DeepClone(),
                        }.ToJsonString()
                    : "mcp " + transport + " " + SessionWait.Text(server["url"]);
            foreach (var field in SecretSinks.McpServer.Fields(server))
                Add(routes, destination, Field(field, ""), field.Value);
        }
        return routes;
    }

    // Header names are case-insensitive; a URL field is also where its reference is sent.
    private static string Field(SecretSinkField field, string prefix)
    {
        var path = field.Path.StartsWith(prefix, StringComparison.Ordinal)
            ? field.Path[prefix.Length..]
            : field.Path;
        return field.Kind switch
        {
            SecretSinkKind.Header => path.ToLowerInvariant(),
            SecretSinkKind.Url => path + " " + field.Value,
            _ => path,
        };
    }
}
