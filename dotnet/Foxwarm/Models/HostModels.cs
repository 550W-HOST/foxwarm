using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record ConcreteHostModel(
    string Key, string ProviderKey, string ModelId, Uri BaseUri, string Token, int ContextLimit,
    string[] AllowedEfforts, string DefaultEffort);

internal sealed class HostModels
{
    private static readonly string[] Efforts = ["none", "low", "medium", "high", "xhigh", "max"];
    private readonly Dictionary<string, ConcreteHostModel> entries;
    private readonly string[] displayKeys;
    public string DefaultKey { get; }
    private HostModels(string defaultKey, Dictionary<string, ConcreteHostModel> entries, string[] displayKeys)
    {
        DefaultKey = defaultKey;
        this.entries = entries;
        this.displayKeys = displayKeys;
    }

    public static HostModels Load(string? filePath, ResponsesClientOptions fallback)
    {
        if (string.IsNullOrEmpty(filePath))
        {
            var key = fallback.RequestModel;
            var entry = new ConcreteHostModel(key, key.Split('/')[0], fallback.ConcreteModelId,
                fallback.BaseUri, fallback.Token, 122880, [.. Efforts], "high");
            return new HostModels(key, new Dictionary<string, ConcreteHostModel>(StringComparer.Ordinal) { [key] = entry }, [key]);
        }
        var root = JsonNode.Parse(File.ReadAllText(filePath)) as JsonObject
            ?? throw new InvalidDataException("Experiment models file must be a JSON object.");
        Allow(root, "models file", "default", "providers");
        var providers = root["providers"] as JsonObject
            ?? throw new InvalidDataException("Experiment models file requires providers object.");
        var models = new Dictionary<string, ConcreteHostModel>(StringComparer.Ordinal);
        var display = new List<string>();
        foreach (var (providerKey, value) in providers)
        {
            if (string.IsNullOrWhiteSpace(providerKey) || providerKey.Contains('/'))
                throw new InvalidDataException("Provider key must be a nonempty unqualified name.");
            var provider = value as JsonObject ?? throw new InvalidDataException($"Provider {providerKey} must be an object.");
            Allow(provider, $"provider {providerKey}", "providerType", "models", "baseUrl", "apiKeyEnv", "contextLimit", "effort");
            var providerType = Text(provider, "providerType") ?? "openai";
            if (providerType is not ("openai" or "openai-responses"))
                throw new InvalidDataException($"Unsupported experiment providerType '{providerType}'.");
            var baseUri = new Uri(Required(provider, "baseUrl"), UriKind.Absolute);
            if (baseUri.Scheme != Uri.UriSchemeHttp || !baseUri.IsLoopback)
                throw new InvalidDataException("Experiment provider baseUrl must be loopback HTTP.");
            var secretName = Required(provider, "apiKeyEnv");
            var token = Environment.GetEnvironmentVariable(secretName);
            if (string.IsNullOrEmpty(token)) throw new InvalidDataException($"Missing provider credential environment variable {secretName}.");
            var context = Positive(provider["contextLimit"], 122880, $"{providerKey}.contextLimit");
            var (allowed, defaultEffort) = Effort(provider["effort"], [.. Efforts], "high", providerKey);
            var members = provider["models"] as JsonArray
                ?? throw new InvalidDataException($"Provider {providerKey} needs models array.");
            if (members.Count == 0) throw new InvalidDataException($"Provider {providerKey} models array is empty.");
            foreach (var member in members)
            {
                var item = member as JsonObject;
                if (item is not null) Allow(item, $"model {providerKey}", "id", "contextLimit", "effort");
                var id = item is null ? member is JsonValue text && text.TryGetValue<string>(out var name) ? name : null
                    : Required(item, "id");
                if (string.IsNullOrWhiteSpace(id) || id.Contains('/'))
                    throw new InvalidDataException($"Invalid model id under {providerKey}.");
                var key = providerKey + "/" + id;
                var limit = Positive(item?["contextLimit"], context, $"{key}.contextLimit");
                var (modelAllowed, modelDefault) = Effort(item?["effort"], allowed, defaultEffort, key);
                var leaf = new ConcreteHostModel(key, providerKey, id, baseUri, token, limit, modelAllowed, modelDefault);
                if (!models.TryAdd(key, leaf)) throw new InvalidDataException($"Duplicate model {key}.");
                display.Add(key);
            }
        }
        if (display.Count == 0) throw new InvalidDataException("Experiment models file has no concrete models.");
        var defaultKey = Required(root, "default");
        // The canonical Foxwarm provider-only lookup is accepted for a single-model provider;
        // the UI still lists its stable provider/model key.
        foreach (var group in models.Values.GroupBy(model => model.ProviderKey))
            if (group.Count() == 1) models.TryAdd(group.Key, group.Single());
        if (!models.TryGetValue(defaultKey, out var selectedDefault))
            throw new InvalidDataException($"Unknown default model {defaultKey}.");
        return new HostModels(selectedDefault.Key, models, [.. display]);
    }

    public ConcreteHostModel Resolve(string? rawKey) =>
        rawKey is not null && entries.TryGetValue(rawKey, out var selected) ? selected : entries[DefaultKey];

    public bool Contains(string key) => entries.ContainsKey(key);

    public (ConcreteHostModel Model, string? RawModel, string? RawEffort, string EffectiveEffort) Select(SessionSnapshot snapshot)
    {
        var rawModel = snapshot.AuthorityEnvelope["model"]?.GetValue<string>();
        var rawEffort = snapshot.AuthorityEnvelope["effort"]?.GetValue<string>();
        var model = Resolve(rawModel);
        var effective = rawEffort is not null && model.AllowedEfforts.Contains(rawEffort, StringComparer.Ordinal)
            ? rawEffort : model.DefaultEffort;
        return (model, rawModel, rawEffort, effective);
    }

    public JsonObject ToWebUiPayload() => new()
    {
        ["defaultKey"] = DefaultKey,
        ["currentKey"] = DefaultKey,
        ["models"] = new JsonArray(displayKeys.Select(key =>
        {
            var model = entries[key];
            return (JsonNode?)new JsonObject
            {
                ["key"] = key, ["label"] = key, ["isDefault"] = key == DefaultKey,
                ["contextLimit"] = model.ContextLimit, ["providerKey"] = model.ProviderKey,
                ["modelId"] = model.ModelId, ["providerType"] = "openai-responses",
                ["isVirtual"] = false, ["targets"] = new JsonArray(),
                ["allowedEfforts"] = new JsonArray(model.AllowedEfforts.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray()),
                ["defaultEffort"] = model.DefaultEffort
            };
        }).ToArray())
    };

    private static void Allow(JsonObject obj, string label, params string[] names)
    {
        foreach (var name in obj.Select(pair => pair.Key))
            if (!names.Contains(name, StringComparer.Ordinal)) throw new InvalidDataException($"{label} field '{name}' is unsupported.");
    }
    private static string? Text(JsonObject obj, string name) =>
        obj[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private static string Required(JsonObject obj, string name) =>
        !string.IsNullOrWhiteSpace(Text(obj, name)) ? Text(obj, name)! : throw new InvalidDataException($"{name} must be a nonempty string.");
    private static int Positive(JsonNode? node, int fallback, string label)
    {
        if (node is null) return fallback;
        if (node is JsonValue value && value.TryGetValue<double>(out var positive)
            && double.IsFinite(positive) && positive >= 1 && positive <= int.MaxValue
            && Math.Truncate(positive) == positive) return (int)positive;
        throw new InvalidDataException($"{label} must be a positive integer.");
    }
    private static (string[] Allowed, string Default) Effort(JsonNode? raw, string[] inherited, string fallback, string label)
    {
        if (raw is null) return ([.. inherited], fallback);
        var data = raw as JsonObject ?? throw new InvalidDataException($"{label}.effort must be an object.");
        Allow(data, $"{label}.effort", "allowed", "default");
        var allowed = inherited;
        if (data["allowed"] is JsonNode rawAllowed)
        {
            var array = rawAllowed as JsonArray ?? throw new InvalidDataException($"{label}.effort.allowed must be an array.");
            var selected = array.Select(item => item is JsonValue value && value.TryGetValue<string>(out var text) ? text : "").ToArray();
            if (selected.Length == 0 || selected.Distinct(StringComparer.Ordinal).Count() != selected.Length || selected.Any(v => !Efforts.Contains(v)))
                throw new InvalidDataException($"{label}.effort.allowed has invalid or duplicate values.");
            allowed = Efforts.Where(selected.Contains).ToArray();
        }
        var defaultEffort = Text(data, "default") ?? fallback;
        if (!allowed.Contains(defaultEffort, StringComparer.Ordinal))
            throw new InvalidDataException($"{label}.effort.default must be in allowed.");
        return ([.. allowed], defaultEffort);
    }
}
