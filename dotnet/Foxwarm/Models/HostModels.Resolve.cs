using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed partial class HostModels
{
    private static ConcreteHostModel Build(
        string providerKey,
        string id,
        string type,
        JsonObject provider,
        JsonObject? model,
        JsonObject defaults,
        JsonObject llm
    )
    {
        var key = id.Length == 0 ? providerKey : providerKey + "/" + id;
        var config = (JsonObject)provider.DeepClone();
        config["providerType"] = type;
        config["model"] = id;
        if (model?.ContainsKey("upstreamModelId") == true)
        {
            var upstream = Text(model, "upstreamModelId")?.Trim();
            if (string.IsNullOrEmpty(upstream))
                throw new InvalidDataException("upstreamModelId must be a nonempty string.");
            config["upstreamModelId"] = upstream;
        }
        if (model?.ContainsKey("sameProviderAs") == true)
            throw new InvalidDataException("sameProviderAs belongs on provider objects.");
        if (model is not null && ModelHistoryCompatibility.Reference(model, "sameModelAs") is { } sameModel)
            config["sameModelAs"] = sameModel;
        var pricingScope = model ?? provider;
        if (pricingScope.ContainsKey("pricing"))
            config["pricing"] = ModelUsageCost.ValidatePrices(pricingScope["pricing"]);
        var family =
            type == "anthropic" ? "anthropic"
            : type is "openai" or "openai-responses" or "openai-ws" or "openai-completions"
                ? "openai"
            : null;
        var url =
            Text(provider, "baseUrl")
            ?? (family is null ? null : Text(llm, family + "BaseUrl"))
            ?? (
                family == "anthropic" ? "https://api.anthropic.com"
                : family == "openai" ? "https://api.openai.com/v1"
                : null
            );
        var token =
            Text(provider, "apiKey")
            ?? (family is null ? null : Text(llm, family + "ApiKey"))
            ?? "";
        config["baseUrl"] = url;
        config["apiKey"] = token;
        if (model is not null)
            ValidateDefaults(model, "Model " + key);
        var context = PositiveSetting(
            model?["contextLimit"]
                ?? provider["contextLimit"]
                ?? defaults["contextLimit"]
                ?? llm["contextLimit"],
            200000,
            "contextLimit"
        );
        config["contextLimit"] = context;
        config["maxOutput"] = PositiveSetting(
            model?["maxOutput"]
                ?? provider["maxOutput"]
                ?? defaults["maxOutput"]
                ?? llm["maxOutput"],
            32768,
            "maxOutput"
        );
        config["providerImageOutputFormat"] =
            SessionWait.Text(model?["providerImageOutputFormat"])
            ?? Text(provider, "providerImageOutputFormat")
            ?? Text(defaults, "providerImageOutputFormat")
            ?? Text(llm, "providerImageOutputFormat")
            ?? "webp";
        foreach (var scope in new[] { provider, model })
            if (
                scope?.ContainsKey("keepReasoningOnError") == true
                && (
                    scope["keepReasoningOnError"] is not JsonValue flag
                    || !flag.TryGetValue<bool>(out _)
                )
            )
                throw new InvalidDataException("keepReasoningOnError must be boolean.");
        config["asyncCompact"] =
            model?["asyncCompact"]?.DeepClone()
            ?? provider["asyncCompact"]?.DeepClone()
            ?? JsonValue.Create(true);
        config["disallowEmptyResponse"] =
            model?["disallowEmptyResponse"]?.DeepClone()
            ?? provider["disallowEmptyResponse"]?.DeepClone()
            ?? JsonValue.Create(false);
        config["keepReasoningOnError"] =
            model?["keepReasoningOnError"]?.DeepClone()
            ?? provider["keepReasoningOnError"]?.DeepClone()
            ?? JsonValue.Create(false);
        foreach (var scope in new[] { provider, model })
            if (scope?.ContainsKey("streamContentInactivityTimeoutMs") == true)
            {
                if (scope["streamContentInactivityTimeoutMs"] is null)
                    throw new InvalidDataException(
                        "streamContentInactivityTimeoutMs must be an integer between 1 and 2147483647 milliseconds."
                    );
                _ = Positive(
                    scope["streamContentInactivityTimeoutMs"],
                    60000,
                    "streamContentInactivityTimeoutMs"
                );
            }
        config["streamContentInactivityTimeoutMs"] = Positive(
            model?["streamContentInactivityTimeoutMs"]
                ?? provider["streamContentInactivityTimeoutMs"],
            60000,
            "streamContentInactivityTimeoutMs"
        );
        if (type == "openai-ws" && provider["requestCompression"] is not null)
            throw new InvalidDataException("requestCompression is unsupported on openai-ws.");
        if (
            type != "openai-completions"
            && (
                provider.ContainsKey("historyReasoningField")
                || model?.ContainsKey("historyReasoningField") == true
            )
        )
            throw new InvalidDataException(
                "historyReasoningField is only supported on openai-completions."
            );
        if (type == "openai-completions")
        {
            var reasoning =
                model?["historyReasoningField"]
                ?? provider["historyReasoningField"]
                ?? JsonValue.Create("reasoning_content");
            if (SessionWait.Text(reasoning) is not ("reasoning_content" or "reasoning"))
                throw new InvalidDataException("Invalid historyReasoningField.");
            config["historyReasoningField"] = reasoning.DeepClone();
        }
        var inherited = Effort(provider, Efforts, "high");
        var effort = Effort(model, inherited.Allowed, inherited.Default);
        config["effort"] = new JsonObject
        {
            ["allowed"] = new JsonArray(
                effort.Allowed.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["default"] = effort.Default,
        };
        var headers = Map(provider["extraHeaders"], "extraHeaders");
        foreach (var pair in Map(model?["extraHeaders"], "extraHeaders"))
            headers[pair.Key] = pair.Value?.DeepClone();
        config["extraHeaders"] = headers;
        config["extraFields"] = Merge(
            Map(provider["extraFields"], "extraFields"),
            Map(model?["extraFields"], "extraFields")
        );
        config["webSearch"] = Feature(provider, model, "webSearch", image: false);
        config["imageGeneration"] = Feature(provider, model, "imageGeneration", image: true);
        return new ConcreteHostModel(
            key,
            providerKey,
            id,
            type,
            url,
            token,
            context,
            effort.Allowed,
            effort.Default,
            config,
            []
        );
    }

    internal static void ValidateDefaults(
        JsonObject scope,
        string label,
        bool rejectUnknown = false
    )
    {
        if (rejectUnknown)
            foreach (var field in scope.Select(pair => pair.Key))
                if (field is not ("contextLimit" or "maxOutput" or "providerImageOutputFormat"))
                    throw new InvalidDataException(label + " has unsupported field " + field + ".");
        foreach (var field in new[] { "contextLimit", "maxOutput" })
            if (scope.ContainsKey(field))
            {
                if (scope[field] is null)
                    throw new InvalidDataException(
                        label + "." + field + " must be a positive integer."
                    );
                _ = PositiveSetting(scope[field], 1, label + "." + field);
            }
        if (
            scope.ContainsKey("providerImageOutputFormat")
            && Text(scope, "providerImageOutputFormat") is not ("webp" or "jpeg")
        )
            throw new InvalidDataException(
                label + ".providerImageOutputFormat must be webp or jpeg."
            );
    }

    private static JsonObject Map(JsonNode? node, string label) =>
        node is null ? new JsonObject()
        : node is JsonObject obj ? (JsonObject)obj.DeepClone()
        : throw new InvalidDataException(label + " must be an object.");

    internal static JsonObject Merge(JsonObject earlier, JsonObject later)
    {
        var result = (JsonObject)earlier.DeepClone();
        foreach (var (key, value) in later)
            result[key] =
                result[key] is JsonObject old && value is JsonObject added
                    ? Merge(old, added)
                    : value?.DeepClone();
        return result;
    }

    private static (string[] Allowed, string Default) Effort(
        JsonObject? scope,
        string[] inherited,
        string fallback
    )
    {
        if (scope?.ContainsKey("effort") != true)
            return ([.. inherited], fallback);
        var raw =
            scope["effort"] as JsonObject
            ?? throw new InvalidDataException("effort must be an object.");
        var allowed = inherited;
        if (raw.ContainsKey("allowed"))
        {
            var list =
                raw["allowed"] as JsonArray
                ?? throw new InvalidDataException("effort.allowed must be an array.");
            var values = list.Select(SessionWait.Text).ToArray();
            if (
                values.Length == 0
                || values.Distinct().Count() != values.Length
                || values.Any(value => value is null || !Efforts.Contains(value))
            )
                throw new InvalidDataException("Invalid effort.allowed values.");
            allowed = Efforts.Where(values.Contains).ToArray();
        }
        var selected = raw.ContainsKey("default") ? SessionWait.Text(raw["default"]) : fallback;
        if (selected is null || !allowed.Contains(selected))
            throw new InvalidDataException("effort.default must be in allowed.");
        return (allowed, selected);
    }

    private static JsonObject? Feature(
        JsonObject provider,
        JsonObject? model,
        string property,
        bool image
    )
    {
        JsonObject? Normalize(JsonObject? scope)
        {
            if (scope?.ContainsKey(property) != true)
                return null;
            var value = scope[property];
            if (value is JsonValue scalar && scalar.TryGetValue<bool>(out var enabled))
                return new JsonObject { ["enabled"] = enabled };
            var raw =
                value as JsonObject
                ?? throw new InvalidDataException(
                    property + " must be boolean or an options object."
                );
            if (
                raw.ContainsKey("enabled")
                && (raw["enabled"] is not JsonValue flag || !flag.TryGetValue<bool>(out _))
            )
                throw new InvalidDataException(property + ".enabled must be boolean.");
            var result = new JsonObject
            {
                ["enabled"] = raw["enabled"]?.DeepClone() ?? JsonValue.Create(true),
            };
            var enums = image
                ? new Dictionary<string, string[]>
                {
                    ["action"] = ["auto", "generate", "edit"],
                    ["quality"] = ["auto", "low", "medium", "high", "xhigh", "max"],
                    ["background"] = ["auto", "opaque", "transparent"],
                    ["outputFormat"] = ["png", "jpeg", "webp"],
                }
                : new Dictionary<string, string[]>
                {
                    ["toolChoice"] = ["auto", "required"],
                    ["searchContextSize"] = ["low", "medium", "high"],
                };
            foreach (var (field, choices) in enums)
                if (raw.ContainsKey(field))
                {
                    if (SessionWait.Text(raw[field]) is not string text || !choices.Contains(text))
                        throw new InvalidDataException("Invalid " + property + "." + field + ".");
                    result[field] = text;
                }
            if (image)
            {
                foreach (var field in new[] { "model", "size" })
                    if (raw.ContainsKey(field))
                    {
                        if (
                            SessionWait.Text(raw[field]) is not string text
                            || string.IsNullOrWhiteSpace(text)
                        )
                            throw new InvalidDataException(
                                "imageGeneration." + field + " must be a nonempty string."
                            );
                        result[field] = text.Trim();
                    }
                if (raw.ContainsKey("outputCompression"))
                {
                    if (
                        SessionWait.Number(raw["outputCompression"]) is not double compression
                        || !double.IsFinite(compression)
                        || compression < 0
                        || compression > 100
                        || Math.Floor(compression) != compression
                    )
                        throw new InvalidDataException(
                            "Invalid imageGeneration.outputCompression."
                        );
                    result["outputCompression"] = compression;
                }
                CheckImageConflict(result);
            }
            else
            {
                if (raw.ContainsKey("allowedDomains"))
                {
                    if (
                        raw["allowedDomains"] is not JsonArray domains
                        || domains.Any(domain =>
                            string.IsNullOrWhiteSpace(SessionWait.Text(domain))
                        )
                    )
                        throw new InvalidDataException(
                            "webSearch.allowedDomains must contain nonempty strings."
                        );
                    result["allowedDomains"] = new JsonArray(
                        domains
                            .Select(domain =>
                                (JsonNode?)JsonValue.Create(SessionWait.Text(domain)!.Trim())
                            )
                            .ToArray()
                    );
                }
                if (raw.ContainsKey("userLocation"))
                {
                    var location =
                        raw["userLocation"] as JsonObject
                        ?? throw new InvalidDataException(
                            "webSearch.userLocation must be an object."
                        );
                    var normalizedLocation = new JsonObject();
                    if (location.ContainsKey("type"))
                    {
                        if (SessionWait.Text(location["type"]) != "approximate")
                            throw new InvalidDataException(
                                "webSearch.userLocation.type must be approximate."
                            );
                        normalizedLocation["type"] = "approximate";
                    }
                    foreach (var field in new[] { "country", "city", "region", "timezone" })
                        if (location.ContainsKey(field))
                            normalizedLocation[field] =
                                SessionWait.Text(location[field])?.Trim()
                                ?? throw new InvalidDataException(
                                    "webSearch.userLocation values must be strings."
                                );
                    result["userLocation"] = normalizedLocation;
                }
            }
            return result;
        }
        var earlier = Normalize(provider);
        var later = Normalize(model);
        if (later is null)
            return earlier;
        var merged = earlier ?? new JsonObject();
        foreach (var (key, value) in later)
            merged[key] = value?.DeepClone();
        if (image)
            CheckImageConflict(merged);
        return merged;
    }

    private static void CheckImageConflict(JsonObject result)
    {
        if (
            SessionWait.Text(result["background"]) == "transparent"
            && SessionWait.Text(result["outputFormat"]) == "jpeg"
        )
            throw new InvalidDataException("Transparent image generation cannot use JPEG.");
    }
}
