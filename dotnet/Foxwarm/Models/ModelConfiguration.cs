using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using YamlDotNet.Serialization;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    private readonly object gate = new();
    private readonly SemaphoreSlim mutation = new(1);
    private readonly JsonObject app;
    private HostModels? catalog;
    private string? cachedRaw;
    internal HostPaths Paths { get; }
    public string ActivePath { get; }
    public string TemplatePath { get; }
    public string AppPath { get; }
    public string AppRaw { get; }
    internal AccessConfiguration Access { get; }

    internal JsonObject ConfigDiagnostics()
    {
        var raw = ReadCurrentAppRaw();
        var current = ConfigurationYaml.Parse(raw, "app config");
        AppConfigurationRules.Validate(current);
        var configured = current["channels"] as JsonObject ?? new JsonObject();
        return new JsonObject
        {
            ["appConfigPath"] = AppPath,
            ["rawYaml"] = raw,
            ["channelsYaml"] = ChannelsYamlForResponse(current),
            ["channelCount"] = configured.Count,
        };
    }

    internal static string ChannelsYamlForResponse(JsonObject current) =>
        ChannelsYamlForObject(current["channels"] as JsonObject ?? new JsonObject());

    internal static string ChannelsYamlForObject(JsonObject channels) =>
        new SerializerBuilder().Build().Serialize(JsonNodeToObject(channels));

    internal JsonArray ChannelDiagnostics(bool webUiRunning)
    {
        var current = ConfigurationYaml.Parse(ReadCurrentAppRaw(), "app config");
        var channels = current["channels"] as JsonObject ?? new JsonObject();
        var result = new JsonArray();
        foreach (var (channelId, raw) in channels)
        {
            var config = raw as JsonObject ?? new JsonObject();
            var type = SessionWait.Text(config["type"])?.Trim();
            type = string.IsNullOrEmpty(type) ? channelId : type;
            var enabled =
                config["enabled"] is not JsonValue value
                || !value.TryGetValue<bool>(out var configuredEnabled)
                || configuredEnabled;
            var webUiIdConflict = channelId == "webui" && type != "webui";
            var isWebUi = channelId == "webui";
            var configured = isWebUi || IsConfigured(type, config);
            result.Add(
                new JsonObject
                {
                    ["channelId"] = channelId,
                    ["type"] = isWebUi ? "webui" : type,
                    ["managed"] = false,
                    ["running"] = isWebUi && webUiRunning,
                    ["configured"] = configured,
                    ["enabled"] = enabled,
                    ["details"] = new JsonArray(
                        webUiIdConflict ? "Main WebUI; This channel ID is already used by WebUI."
                        : isWebUi ? "Main WebUI"
                        : "External chat channels are unavailable on this server."
                    ),
                    ["lastError"] =
                        webUiIdConflict ? "This channel ID is already used by WebUI."
                        : isWebUi || !enabled ? null
                        : "External chat channels are unavailable on this server.",
                }
            );
        }
        if (webUiRunning && !channels.ContainsKey("webui"))
        {
            result.Add(
                new JsonObject
                {
                    ["channelId"] = "webui",
                    ["type"] = "webui",
                    ["managed"] = false,
                    ["running"] = true,
                    ["configured"] = true,
                    ["enabled"] = true,
                    ["details"] = new JsonArray("Main WebUI"),
                    ["lastError"] = null,
                }
            );
        }
        return result;
    }

    private static bool IsConfigured(string type, JsonObject config) =>
        type switch
        {
            "telegram" => !string.IsNullOrWhiteSpace(SessionWait.Text(config["botToken"])),
            "matrix" => !string.IsNullOrWhiteSpace(SessionWait.Text(config["homeserver"]))
                && !string.IsNullOrWhiteSpace(SessionWait.Text(config["accessToken"]))
                && !string.IsNullOrWhiteSpace(SessionWait.Text(config["botUserId"])),
            "weixin" => !string.IsNullOrWhiteSpace(SessionWait.Text(config["token"])),
            "qqbot" => !string.IsNullOrWhiteSpace(SessionWait.Text(config["appId"]))
                && !string.IsNullOrWhiteSpace(SessionWait.Text(config["clientSecret"])),
            "wework" => !string.IsNullOrWhiteSpace(SessionWait.Text(config["webhookUrl"]))
                || (
                    config["listenPort"] is not null
                    && !string.IsNullOrWhiteSpace(SessionWait.Text(config["listenPath"]))
                    && !string.IsNullOrWhiteSpace(SessionWait.Text(config["token"]))
                    && !string.IsNullOrWhiteSpace(SessionWait.Text(config["encodingAESKey"]))
                )
                || (
                    config["aibot"] is JsonObject aibot
                    && aibot["websocket"] is JsonObject websocket
                    && websocket["enabled"] is JsonValue enabled
                    && enabled.TryGetValue<bool>(out var active)
                    && active
                    && !string.IsNullOrWhiteSpace(SessionWait.Text(websocket["botId"]))
                    && !string.IsNullOrWhiteSpace(SessionWait.Text(websocket["secret"]))
                ),
            _ => false,
        };

    public HostModels Models { get; }
    internal JsonObject AppConfiguration => (JsonObject)app.DeepClone();
    internal bool HandoffConfirmationEnabled { get; }
    internal string ProviderImageOutputFormat { get; }
    public double MaxOutput { get; }
    public double CompactKeep { get; }
    public double CompactThreshold { get; }

    internal ModelConfiguration(string dataRoot) : this(HostPaths.ForDataRoot(dataRoot)) { }

    internal ModelConfiguration(HostPaths paths)
    {
        ActivePath = paths.ModelsPath;
        TemplatePath = Path.Combine(paths.ResourceRoot, "templates", "models.example.yaml");
        AppPath = paths.ConfigPath;
        AppRaw = File.Exists(AppPath) ? File.ReadAllText(AppPath, Encoding.UTF8) : "";
        app = ConfigurationYaml.Parse(AppRaw, "app config");
        AppConfigurationRules.Validate(app);
        Paths = paths.WithConfiguration(app);
        Access = new(app);
        HandoffConfirmationEnabled = Foxwarm.Tools.HandoffConfirmation.Enabled(app);
        var llm = app["llm"] as JsonObject;
        MaxOutput = HostModels.PositiveSetting(llm?["maxOutput"], 32768, "llm.maxOutput");
        var imageOutput = llm?["providerImageOutputFormat"];
        ProviderImageOutputFormat =
            llm?.ContainsKey("providerImageOutputFormat") != true ? "webp"
            : SessionWait.Text(imageOutput) is "webp" or "jpeg" ? SessionWait.Text(imageOutput)!
            : throw new InvalidDataException("llm.providerImageOutputFormat must be webp or jpeg.");
        double Fraction(string key, double fallback)
        {
            var raw = llm?[key];
            if (raw is null && key == "compactKeepPercent")
                raw = llm?["compactPercent"];
            if (raw is null)
                return fallback;
            var value = SessionWait.Number(raw);
            return value is > 0 and <= 1 && double.IsFinite(value.Value)
                ? value.Value
                : throw new InvalidDataException("Invalid llm." + key + ".");
        }
        CompactKeep = Fraction("compactKeepPercent", .3);
        CompactThreshold = Fraction("compactThresholdPercent", .85);
        Models = new HostModels(this);
    }

    internal HostModels Capture()
    {
        lock (gate)
        {
            var read = File.Exists(ActivePath) ? ActivePath : TemplatePath;
            if (!File.Exists(read))
                throw new InvalidDataException("Models configuration is missing.");
            var raw = File.ReadAllText(read, Encoding.UTF8);
            if (catalog is not null && raw == cachedRaw)
                return catalog;
            var next = Validate(raw);
            catalog = next;
            cachedRaw = raw;
            return next;
        }
    }

    private HostModels Validate(string raw) =>
        HostModels.Parse(ConfigurationYaml.Parse(raw, "models config"), app);

    private static object? JsonNodeToObject(JsonNode? node)
    {
        if (node is null)
            return null;
        if (node is JsonObject obj)
            return obj.ToDictionary(pair => pair.Key, pair => JsonNodeToObject(pair.Value));
        if (node is JsonArray array)
            return array.Select(JsonNodeToObject).ToList();
        if (node is JsonValue value)
        {
            if (value.TryGetValue<string>(out var text))
                return text;
            if (value.TryGetValue<bool>(out var boolean))
                return boolean;
            if (value.TryGetValue<double>(out var number))
                return number;
        }
        return null;
    }

    private static string ReplaceTopLevelSection(string raw, string key, string replacement)
    {
        var hasNewline = raw.EndsWith('\n');
        var lines = raw.Split('\n').ToList();
        if (hasNewline)
            lines.RemoveAt(lines.Count - 1);
        var start = lines.FindIndex(line =>
        {
            if (line.Length != line.TrimStart().Length)
                return false;
            var colon = line.IndexOf(':');
            return colon >= 0 && line[..colon].Trim() == key;
        });
        if (start < 0)
        {
            var prefix = raw.TrimEnd();
            return prefix.Length == 0 ? replacement + "\n" : prefix + "\n\n" + replacement + "\n";
        }
        var end = lines.Count;
        for (var index = start + 1; index < lines.Count; index++)
        {
            if (lines[index].Length > 0 && !char.IsWhiteSpace(lines[index][0]))
            {
                end = index;
                break;
            }
        }
        var next = lines.Take(start).Concat(replacement.Split('\n')).Concat(lines.Skip(end));
        return string.Join('\n', next) + (hasNewline ? "\n" : "");
    }

    internal string ReadCurrentAppRaw() =>
        File.Exists(AppPath) ? File.ReadAllText(AppPath, Encoding.UTF8) : "";

    internal JsonObject Diagnostics()
    {
        lock (gate)
        {
            var exists = File.Exists(ActivePath);
            var raw = exists ? File.ReadAllText(ActivePath, Encoding.UTF8) : "";
            var parsed = ConfigurationYaml.Parse(raw, "models config");
            var providers =
                (parsed["providers"] ?? parsed["models"]) as JsonObject ?? new JsonObject();
            var defaultModel = SessionWait.Text(parsed["default"]);
            var placeholder = new JsonArray();
            var drafts = new JsonArray();
            foreach (var (key, value) in providers)
            {
                var config = value is JsonObject obj
                    ? obj
                    : new JsonObject
                    {
                        ["providerType"] = "session-hash",
                        ["targets"] = new JsonArray(SessionWait.Text(value)?.Trim()),
                    };
                var type =
                    HostModels.Text(config, "providerType")
                    ?? HostModels.Text(config, "provider")
                    ?? "openai-completions";
                var virtualModel = type is "session-hash" or "failover";
                var secret = SessionWait.Text(config["apiKey"]) ?? "";
                if (
                    System.Text.RegularExpressions.Regex.IsMatch(
                        secret.Trim(),
                        "^(your-|sk-\\.\\.\\.|changeme|replace-me)$",
                        System.Text.RegularExpressions.RegexOptions.IgnoreCase
                    )
                )
                    placeholder.Add(key);
                var members =
                    config["models"] as JsonArray
                    ?? config["model"] as JsonArray
                    ?? (
                        config["model"] is not null
                            ? new JsonArray(config["model"]!.DeepClone())
                            : new JsonArray()
                    );
                drafts.Add(
                    new JsonObject
                    {
                        ["id"] = key,
                        ["providerType"] = type,
                        ["isVirtual"] = virtualModel,
                        ["baseUrl"] = config["baseUrl"]?.DeepClone() ?? JsonValue.Create(""),
                        ["apiKey"] = secret,
                        ["models"] = string.Join(
                            "\n",
                            members
                                .Select(member =>
                                    SessionWait.Text(member) ?? SessionWait.Text(member?["id"])
                                )
                                .Where(id => !string.IsNullOrWhiteSpace(id))
                        ),
                        ["targets"] = config["targets"] is JsonArray targets
                            ? targets.DeepClone()
                            : new JsonArray(),
                        ["failureThreshold"] =
                            config["failureThreshold"]?.DeepClone()
                            ?? (type == "failover" ? JsonValue.Create(5) : null),
                        ["cooldownMs"] =
                            config["cooldownMs"]?.DeepClone()
                            ?? (type == "failover" ? JsonValue.Create(600000) : null),
                        ["defaultModel"] =
                            defaultModel?.StartsWith(key + "/", StringComparison.Ordinal) == true
                                ? defaultModel[(key.Length + 1)..]
                                : "",
                    }
                );
            }
            return new JsonObject
            {
                ["path"] = ActivePath,
                ["templatePath"] = TemplatePath,
                ["exists"] = exists,
                ["providerCount"] = providers.Count,
                ["defaultModel"] = defaultModel,
                ["rawYaml"] = raw,
                ["providers"] = drafts,
                ["hasPlaceholderSecrets"] = placeholder.Count > 0,
                ["placeholderProviders"] = placeholder,
                ["oobe"] = !exists,
            };
        }
    }

    internal string SafeAppError(Exception error) =>
        error is InvalidDataException or AuthorityCommittedException
            ? error.Message
            : "Configuration operation failed.";

    internal string SafeError(Exception error, JsonObject? incoming = null)
    {
        var message = error is InvalidDataException or AuthorityCommittedException
            ? error.Message
            : "Configuration operation failed.";
        if (message.Contains("YAML at line", StringComparison.Ordinal))
            return message;
        try
        {
            var secrets = Capture()
                .All.SelectMany(model =>
                    new[] { model.Token }.Concat(
                        (
                            model.Configuration["extraHeaders"] as JsonObject ?? new JsonObject()
                        ).Select(pair => SessionWait.Text(pair.Value) ?? "")
                    )
                );
            var incomingSecrets = new List<string>();
            void Collect(JsonNode? node)
            {
                if (node is JsonArray list)
                {
                    foreach (var child in list)
                        Collect(child);
                    return;
                }
                if (node is not JsonObject obj)
                    return;
                foreach (var (key, value) in obj)
                {
                    if (key == "apiKey" && SessionWait.Text(value) is string token)
                        incomingSecrets.Add(token);
                    if (key == "extraHeaders" && value is JsonObject headers)
                        incomingSecrets.AddRange(
                            headers.Select(pair => SessionWait.Text(pair.Value) ?? "")
                        );
                    Collect(value);
                }
            }
            if (incoming?["yaml"] is JsonValue yaml && yaml.TryGetValue<string>(out var text))
                Collect(ConfigurationYaml.Parse(text, "models config"));
            else
                Collect(incoming);
            if (
                secrets
                    .Concat(incomingSecrets)
                    .Any(secret =>
                        secret.Length > 0 && message.Contains(secret, StringComparison.Ordinal)
                    )
            )
                return "Models configuration validation failed.";
        }
        catch
        {
            return "Models configuration validation failed.";
        }
        return message;
    }

    private static string JsString(JsonNode? value) =>
        value is null ? ""
        : value is JsonObject ? "[object Object]"
        : value is JsonArray array ? string.Join(",", array.Select(JsString))
        : value.ToString();
}
