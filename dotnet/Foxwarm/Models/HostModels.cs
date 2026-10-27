using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record ConcreteHostModel(
    string Key,
    string ProviderKey,
    string ModelId,
    string ProviderType,
    string? BaseUrl,
    string Token,
    double ContextLimit,
    string[] AllowedEfforts,
    string? DefaultEffort,
    JsonObject Configuration,
    string[] Targets
)
{
    internal string UpstreamModelId => HostModels.Text(Configuration, "upstreamModelId") ?? ModelId;
    internal double MaxOutput =>
        HostModels.PositiveSetting(Configuration["maxOutput"], 32768, "maxOutput");
    internal string ProviderImageOutputFormat =>
        HostModels.Text(Configuration, "providerImageOutputFormat") ?? "webp";
    internal bool IsVirtual => ProviderType is "session-hash" or "failover";
    internal Uri BaseUri =>
        new(
            BaseUrl ?? throw new InvalidDataException("Selected model has no base URL."),
            UriKind.Absolute
        );
}

internal sealed partial class HostModels
{
    internal static readonly string[] Efforts = ["none", "low", "medium", "high", "xhigh", "max"];
    private readonly Dictionary<string, ConcreteHostModel> entries = new(StringComparer.Ordinal);
    private readonly string[] displayKeys = [];
    private readonly string defaultKey = "";
    private readonly ModelConfiguration? owner;
    internal ModelConfiguration? ConfigurationOwner => owner;
    internal bool HandoffConfirmationEnabled { get; private init; }
    internal double PresentationContextLimit { get; private init; } = 200000;
    internal double CompactKeepFraction { get; private init; } = .3;
    internal double CompactThresholdFraction { get; private init; } = .85;

    internal HostModels(ModelConfiguration owner)
    {
        this.owner = owner;
        HandoffConfirmationEnabled = owner.HandoffConfirmationEnabled;
    }

    private HostModels(string key, Dictionary<string, ConcreteHostModel> entries, string[] display)
    {
        defaultKey = key;
        this.entries = entries;
        displayKeys = display;
    }

    internal HostModels Capture() => owner?.Capture() ?? this;

    public string DefaultKey => owner is null ? defaultKey : Capture().DefaultKey;

    public ConcreteHostModel Resolve(string? rawKey)
    {
        if (owner is not null)
            return Capture().Resolve(rawKey);
        return rawKey is not null && entries.TryGetValue(rawKey, out var selected) ? selected
            : entries.TryGetValue(defaultKey, out var fallback) ? fallback
            : throw new InvalidDataException("No model is configured.");
    }

    public bool Contains(string key) =>
        owner is null ? entries.ContainsKey(key) : Capture().Contains(key);

    public IReadOnlyList<ConcreteHostModel> Options =>
        owner is null
            ? displayKeys.Select(key => entries[key] with { Key = key }).ToArray()
            : Capture().Options;
    internal IReadOnlyCollection<ConcreteHostModel> All =>
        owner is null ? entries.Values : Capture().All;

    public (
        ConcreteHostModel Model,
        string? RawModel,
        string? RawEffort,
        string? EffectiveEffort
    ) Select(SessionSnapshot snapshot) => Select(snapshot.AuthorityEnvelope);

    public (
        ConcreteHostModel Model,
        string? RawModel,
        string? RawEffort,
        string? EffectiveEffort
    ) Select(JsonObject envelope)
    {
        if (owner is not null)
            return Capture().Select(envelope);
        var rawModel = SessionWait.Text(envelope["model"]);
        var rawEffort = SessionWait.Text(envelope["effort"]);
        var model = Resolve(rawModel);
        var effective =
            rawEffort is not null && model.AllowedEfforts.Contains(rawEffort)
                ? rawEffort
                : model.DefaultEffort;
        return (model, rawModel, rawEffort, effective);
    }

    // Explicit dependency injection for low-level host tests, not a runtime file format.
    internal static HostModels ForTest(ResponsesClientOptions options)
    {
        var model = new ConcreteHostModel(
            options.ConcreteModelId,
            options.ConcreteModelId,
            options.RequestModel,
            "openai-responses",
            options.BaseUri.ToString(),
            options.Token,
            200000,
            Efforts,
            "high",
            new JsonObject
            {
                ["maxOutput"] = options.MaxOutputTokens,
                ["providerImageOutputFormat"] = "webp",
            },
            []
        );
        return new HostModels(
            model.Key,
            new Dictionary<string, ConcreteHostModel> { [model.Key] = model },
            [model.Key]
        );
    }

    internal static HostModels Parse(JsonObject root, JsonObject app)
    {
        var providers = root["providers"] ?? root["models"];
        if (providers is not JsonObject source)
            throw new InvalidDataException(
                "Expected root providers (preferred) or legacy models object in models config."
            );
        var models = new Dictionary<string, ConcreteHostModel>(StringComparer.Ordinal);
        var display = new List<string>();
        var virtuals = new List<(string Key, JsonObject Config)>();
        var llm = app["llm"] as JsonObject ?? new JsonObject();
        var defaults = root.ContainsKey("defaults")
            ? root["defaults"] as JsonObject
                ?? throw new InvalidDataException("Models defaults must be an object.")
            : new JsonObject();
        ValidateDefaults(defaults, "defaults", rejectUnknown: true);
        ValidateDefaults(llm, "llm");
        foreach (var (providerKey, raw) in source)
        {
            if (raw is JsonValue alias && alias.TryGetValue<string>(out var target))
            {
                if (target.Trim().Length == 0)
                    throw new InvalidDataException("Provider alias requires a nonempty target.");
                virtuals.Add(
                    (
                        providerKey,
                        new JsonObject
                        {
                            ["providerType"] = "session-hash",
                            ["targets"] = new JsonArray(target.Trim()),
                        }
                    )
                );
                continue;
            }
            var provider =
                raw as JsonObject
                ?? throw new InvalidDataException("Provider must be an object or alias string.");
            if (provider.ContainsKey("upstreamModelId"))
                throw new InvalidDataException("upstreamModelId belongs on model objects.");
            var type = ProviderType(provider);
            if (type is "session-hash" or "failover")
            {
                virtuals.Add((providerKey, provider));
                continue;
            }
            if (!SetupProviderRequests.IsSupportedProviderType(type))
                throw new InvalidDataException("Unsupported providerType: " + type + ".");
            ValidateDefaults(provider, "Provider " + providerKey);
            foreach (var key in new[] { "targets", "failureThreshold", "cooldownMs" })
                if (provider.ContainsKey(key))
                    throw new InvalidDataException(
                        "Concrete provider forbids routing field " + key + "."
                    );
            var rawMembers = provider["models"] ?? provider["model"];
            JsonNode?[] members =
                rawMembers is JsonArray list ? list.ToArray()
                : rawMembers is null || SessionWait.Text(rawMembers) == "" ? []
                : rawMembers is JsonValue value && value.TryGetValue<string>(out _) ? [rawMembers]
                : throw new InvalidDataException(
                    "Provider models must be a string or array of IDs/model objects."
                );
            if (members.Length > 0 && provider.ContainsKey("pricing"))
                throw new InvalidDataException(
                    "pricing belongs on individual model objects, or a concrete provider without models."
                );
            if (members.Length == 0)
            {
                models[providerKey] = Build(providerKey, "", type, provider, null, defaults, llm);
                display.Add(providerKey);
            }
            foreach (var member in members)
            {
                var item = member as JsonObject;
                var id = item is null
                    ? SessionWait.Text(member)
                        ?? throw new InvalidDataException(
                            "Model list entries require string IDs or objects."
                        )
                    : Text(item, "id")?.Trim() ?? "";
                if (item is not null && id.Length == 0)
                    throw new InvalidDataException("Model object requires a nonempty id.");
                var leaf = Build(providerKey, id, type, provider, item, defaults, llm);
                var key = providerKey + "/" + id;
                models[key] = leaf;
                if (members.Length == 1)
                {
                    models[providerKey] = leaf;
                    display.Add(providerKey);
                }
                else
                    display.Add(key);
            }
        }
        foreach (var (key, config) in virtuals)
        {
            var type = ProviderType(config);
            foreach (
                var forbidden in new[]
                {
                    "models",
                    "model",
                    "baseUrl",
                    "apiKey",
                    "requestCompression",
                    "extraFields",
                    "extraHeaders",
                    "pricing",
                    "contextLimit",
                    "maxOutput",
                    "providerImageOutputFormat",
                    "streamContentInactivityTimeoutMs",
                    "effort",
                    "historyReasoningField",
                    "asyncCompact",
                    "disallowEmptyResponse",
                    "keepReasoningOnError",
                    "webSearch",
                    "imageGeneration",
                }
            )
                if (config.ContainsKey(forbidden))
                    throw new InvalidDataException("Virtual provider forbids " + forbidden + ".");
            if (
                type == "session-hash"
                && (config.ContainsKey("failureThreshold") || config.ContainsKey("cooldownMs"))
            )
                throw new InvalidDataException("Session-hash provider forbids failover fields.");
            var targets =
                config["targets"] as JsonArray
                ?? throw new InvalidDataException("Virtual provider requires targets array.");
            if (targets.Count < (type == "failover" ? 2 : 1))
                throw new InvalidDataException("Virtual provider has too few targets.");
            var leaves = targets
                .Select(target =>
                {
                    var name = SessionWait.Text(target)?.Trim();
                    if (
                        string.IsNullOrEmpty(name)
                        || name == key
                        || virtuals.Any(entry => entry.Key == name)
                        || !models.TryGetValue(name, out var leaf)
                    )
                        throw new InvalidDataException(
                            "Virtual provider requires known concrete targets."
                        );
                    return leaf;
                })
                .ToArray();
            if (leaves.Select(leaf => leaf.Key).Distinct().Count() != leaves.Length)
                throw new InvalidDataException("Virtual provider has duplicate canonical targets.");
            var resolved = (JsonObject)config.DeepClone();
            resolved["failureThreshold"] = Positive(
                config["failureThreshold"],
                5,
                "failureThreshold"
            );
            resolved["cooldownMs"] = Positive(config["cooldownMs"], 600000, "cooldownMs");
            var canonicalTargets = leaves.Select(leaf => leaf.Key).ToArray();
            resolved["targets"] = new JsonArray(
                canonicalTargets.Select(target => (JsonNode?)JsonValue.Create(target)).ToArray()
            );
            resolved["asyncCompact"] = leaves.All(leaf =>
                !ModelRoutingFingerprint.False(leaf.Configuration["asyncCompact"])
            );
            resolved["fingerprint"] = ModelRoutingFingerprint.Build(
                type,
                canonicalTargets,
                leaves,
                Positive(resolved["failureThreshold"], 5, "failureThreshold"),
                Positive(resolved["cooldownMs"], 600000, "cooldownMs")
            );
            models[key] = new ConcreteHostModel(
                key,
                key,
                "",
                type,
                null,
                "",
                leaves.Min(leaf => leaf.ContextLimit),
                Efforts
                    .Where(effort => leaves.Any(leaf => leaf.AllowedEfforts.Contains(effort)))
                    .ToArray(),
                null,
                resolved,
                leaves.Select(leaf => leaf.Key).ToArray()
            );
            display.Add(key);
        }
        var ordered = source
            .SelectMany(provider => display.Where(key => models[key].ProviderKey == provider.Key))
            .ToArray();
        var requested = SessionWait.Text(root["default"]);
        var selected =
            requested is not null && models.ContainsKey(requested)
                ? requested
                : ordered.FirstOrDefault() ?? requested ?? "";
        return new HostModels(selected, models, ordered)
        {
            HandoffConfirmationEnabled = Foxwarm.Tools.HandoffConfirmation.Enabled(app),
            PresentationContextLimit = PositiveSetting(
                llm["contextLimit"],
                200000,
                "llm.contextLimit"
            ),
            CompactKeepFraction =
                SessionWait.Number(llm["compactKeepPercent"] ?? llm["compactPercent"]) ?? .3,
            CompactThresholdFraction = SessionWait.Number(llm["compactThresholdPercent"]) ?? .85,
        };
    }

    private static string ProviderType(JsonObject provider)
    {
        foreach (var field in new[] { "providerType", "provider" })
        {
            var raw = provider[field];
            if (
                raw is null
                || SessionWait.Text(raw) == ""
                || SessionWait.Number(raw) == 0
                || raw is JsonValue flag && flag.TryGetValue<bool>(out var enabled) && !enabled
            )
                continue;
            return SessionWait.Text(raw)
                ?? throw new InvalidDataException("Unsupported providerType.");
        }
        return "openai";
    }

    internal static string? Text(JsonObject data, string key) =>
        SessionWait.Text(data[key]) is { Length: > 0 } value ? value : null;

    internal static double PositiveSetting(JsonNode? data, double fallback, string label)
    {
        if (data is null)
            return fallback;
        var number = SessionWait.Number(data);
        return
            number is > 0
            && double.IsFinite(number.Value)
            && Math.Floor(number.Value) == number.Value
            ? number.Value
            : throw new InvalidDataException(label + " must be a positive integer.");
    }

    internal static int Positive(JsonNode? data, int fallback, string label)
    {
        if (data is null)
            return fallback;
        var number = SessionWait.Number(data);
        return
            number is > 0
            && number <= int.MaxValue
            && double.IsFinite(number.Value)
            && Math.Floor(number.Value) == number.Value
            ? (int)number.Value
            : throw new InvalidDataException(label + " must be a positive integer.");
    }
}
