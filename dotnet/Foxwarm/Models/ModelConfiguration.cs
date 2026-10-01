using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    private readonly object gate = new();
    private readonly SemaphoreSlim mutation = new(1);
    private readonly JsonObject app;
    private HostModels? catalog;
    private string? cachedRaw;
    public string ActivePath { get; }
    public string TemplatePath { get; }
    public string AppPath { get; }
    public string AppRaw { get; }
    internal JsonObject ConfigDiagnostics()
    {
        var configured = app["channels"] as JsonObject ?? new JsonObject();
        return new JsonObject { ["appConfigPath"] = AppPath, ["rawYaml"] = AppRaw,
            ["channelsYaml"] = configured.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) + "\n", ["channelCount"] = configured.Count };
    }
    public HostModels Models { get; }
    public int MaxOutput { get; }
    public double CompactKeep { get; }
    public double CompactThreshold { get; }
    internal ModelConfiguration(string dataRoot)
    {
        ActivePath = Path.Combine(dataRoot, "state", "models.yaml"); TemplatePath = Path.Combine(AppContext.BaseDirectory, "templates", "models.example.yaml");
        AppPath = Environment.GetEnvironmentVariable("FOXWARM_CONFIG_PATH") ?? Environment.GetEnvironmentVariable("CONFIG_PATH") ?? Path.Combine(dataRoot, "state", "config.yaml");
        AppRaw = File.Exists(AppPath) ? File.ReadAllText(AppPath, Encoding.UTF8) : "";
        app = ConfigurationYaml.Parse(AppRaw, "app config"); var llm = app["llm"] as JsonObject;
        MaxOutput = HostModels.Positive(llm?["maxOutput"], 32768, "llm.maxOutput");
        double Fraction(string key, double fallback)
        {
            var raw = llm?[key]; if (raw is null && key == "compactKeepPercent") raw = llm?["compactPercent"];
            if (raw is null) return fallback; var value = SessionWait.Number(raw);
            return value is > 0 and <= 1 && double.IsFinite(value.Value) ? value.Value : throw new InvalidDataException("Invalid llm." + key + ".");
        }
        CompactKeep = Fraction("compactKeepPercent", .3); CompactThreshold = Fraction("compactThresholdPercent", .85);
        Models = new HostModels(this);
    }
    internal HostModels Capture()
    {
        lock (gate)
        {
            var read = File.Exists(ActivePath) ? ActivePath : TemplatePath;
            if (!File.Exists(read)) throw new InvalidDataException("Models configuration is missing.");
            var raw = File.ReadAllText(read, Encoding.UTF8);
            if (catalog is not null && raw == cachedRaw) return catalog;
            var next = Validate(raw); catalog = next; cachedRaw = raw; return next;
        }
    }
    private HostModels Validate(string raw) => HostModels.Parse(ConfigurationYaml.Parse(raw, "models config"), app);
    internal async Task SaveAsync(JsonObject input)
    {
        await mutation.WaitAsync();
        try
        {
            string raw;
            if (input.ContainsKey("yaml")) raw = JsString(input["yaml"]);
            else raw = BuildForm(input);
            var next = Validate(raw);
            lock (gate)
            {
                var directory = Path.GetDirectoryName(ActivePath)!; Directory.CreateDirectory(directory);
                var temporary = ActivePath + ".tmp-" + Guid.NewGuid().ToString("N"); var renamed = false;
                try
                {
                    var bytes = new UTF8Encoding(false).GetBytes(raw);
                    using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { file.Write(bytes); file.Flush(true); }
                    File.Move(temporary, ActivePath, true); renamed = true; catalog = next; cachedRaw = raw;
                    LinuxAtomicJsonFile.LinuxDirectorySync.Sync(directory);
                }
                catch (Exception error)
                {
                    if (renamed) throw new AuthorityCommittedException("Models configuration committed but final durability failed.", error);
                    try { File.Delete(temporary); } catch { }
                    throw;
                }
            }
        }
        finally { mutation.Release(); }
    }
    internal JsonObject Diagnostics()
    {
        lock (gate)
        {
            var exists = File.Exists(ActivePath); var raw = exists ? File.ReadAllText(ActivePath, Encoding.UTF8) : "";
            var parsed = ConfigurationYaml.Parse(raw, "models config"); var providers = (parsed["providers"] ?? parsed["models"]) as JsonObject ?? new JsonObject();
            var defaultModel = SessionWait.Text(parsed["default"]); var placeholder = new JsonArray(); var drafts = new JsonArray();
            foreach (var (key, value) in providers)
            {
                var config = value is JsonObject obj ? obj : new JsonObject { ["providerType"] = "session-hash", ["targets"] = new JsonArray(SessionWait.Text(value)?.Trim()) };
                var type = HostModels.Text(config, "providerType") ?? HostModels.Text(config, "provider") ?? "openai-completions"; var virtualModel = type is "session-hash" or "failover";
                var secret = SessionWait.Text(config["apiKey"]) ?? "";
                if (System.Text.RegularExpressions.Regex.IsMatch(secret.Trim(), "^(your-|sk-\\.\\.\\.|changeme|replace-me)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) placeholder.Add(key);
                var members = config["models"] as JsonArray ?? config["model"] as JsonArray ?? (config["model"] is not null ? new JsonArray(config["model"]!.DeepClone()) : new JsonArray());
                drafts.Add(new JsonObject
                {
                    ["id"] = key, ["providerType"] = type, ["isVirtual"] = virtualModel,
                    ["baseUrl"] = config["baseUrl"]?.DeepClone() ?? JsonValue.Create(""), ["apiKey"] = secret,
                    ["models"] = string.Join("\n", members.Select(member => SessionWait.Text(member) ?? SessionWait.Text(member?["id"])).Where(id => !string.IsNullOrWhiteSpace(id))),
                    ["targets"] = config["targets"] is JsonArray targets ? targets.DeepClone() : new JsonArray(),
                    ["failureThreshold"] = config["failureThreshold"]?.DeepClone() ?? (type == "failover" ? JsonValue.Create(5) : null),
                    ["cooldownMs"] = config["cooldownMs"]?.DeepClone() ?? (type == "failover" ? JsonValue.Create(600000) : null),
                    ["defaultModel"] = defaultModel?.StartsWith(key + "/", StringComparison.Ordinal) == true ? defaultModel[(key.Length + 1)..] : ""
                });
            }
            return new JsonObject { ["path"] = ActivePath, ["templatePath"] = TemplatePath, ["exists"] = exists, ["providerCount"] = providers.Count, ["defaultModel"] = defaultModel, ["rawYaml"] = raw, ["providers"] = drafts, ["hasPlaceholderSecrets"] = placeholder.Count > 0, ["placeholderProviders"] = placeholder, ["oobe"] = !exists };
        }
    }
    internal string SafeError(Exception error, JsonObject? incoming = null)
    {
        var message = error is InvalidDataException or AuthorityCommittedException ? error.Message : "Configuration operation failed.";
        if (message.Contains("YAML at line", StringComparison.Ordinal)) return message;
        try
        {
            var secrets = Capture().All.SelectMany(model => new[] { model.Token }.Concat((model.Configuration["extraHeaders"] as JsonObject ?? new JsonObject()).Select(pair => SessionWait.Text(pair.Value) ?? "")));
            var incomingSecrets = new List<string>();
            void Collect(JsonNode? node)
            {
                if (node is JsonArray list) { foreach (var child in list) Collect(child); return; }
                if (node is not JsonObject obj) return;
                foreach (var (key, value) in obj)
                {
                    if (key == "apiKey" && SessionWait.Text(value) is string token) incomingSecrets.Add(token);
                    if (key == "extraHeaders" && value is JsonObject headers) incomingSecrets.AddRange(headers.Select(pair => SessionWait.Text(pair.Value) ?? ""));
                    Collect(value);
                }
            }
            if (incoming?["yaml"] is JsonValue yaml && yaml.TryGetValue<string>(out var text)) Collect(ConfigurationYaml.Parse(text, "models config")); else Collect(incoming);
            if (secrets.Concat(incomingSecrets).Any(secret => secret.Length > 0 && message.Contains(secret, StringComparison.Ordinal))) return "Models configuration validation failed.";
        }
        catch { return "Models configuration validation failed."; }
        return message;
    }
    private static string JsString(JsonNode? value) => value is null ? "" : value is JsonObject ? "[object Object]" : value is JsonArray array ? string.Join(",", array.Select(JsString)) : value.ToString();
}
