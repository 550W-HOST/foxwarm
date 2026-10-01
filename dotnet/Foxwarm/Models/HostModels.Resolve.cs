using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed partial class HostModels
{
    private static ConcreteHostModel Build(string providerKey, string id, string type, JsonObject provider, JsonObject? model, JsonObject llm)
    {
        var key = id.Length == 0 ? providerKey : providerKey + "/" + id;
        var config = (JsonObject)provider.DeepClone();
        config["providerType"] = type; config["model"] = id;
        var family = type == "anthropic" ? "anthropic" : type is "openai" or "openai-responses" or "openai-ws" or "openai-completions" ? "openai" : null;
        var url = Text(provider, "baseUrl") ?? (family is null ? null : Text(llm, family + "BaseUrl")) ?? (family == "anthropic" ? "https://api.anthropic.com" : family == "openai" ? "https://api.openai.com/v1" : null);
        var token = Text(provider, "apiKey") ?? (family is null ? null : Text(llm, family + "ApiKey")) ?? "";
        config["baseUrl"] = url; config["apiKey"] = token;
        var rawContext = model?["contextLimit"] ?? provider["contextLimit"] ?? llm["contextLimit"];
        var number = SessionWait.Number(rawContext); var context = number is > 0 && double.IsFinite(number.Value) && number <= int.MaxValue ? (int)Math.Floor(number.Value) : 122880;
        config["contextLimit"] = rawContext?.DeepClone() ?? JsonValue.Create(context);
        foreach (var scope in new[] { provider, model })
            if (scope?.ContainsKey("keepReasoningOnError") == true && (scope["keepReasoningOnError"] is not JsonValue flag || !flag.TryGetValue<bool>(out _))) throw new InvalidDataException("keepReasoningOnError must be boolean.");
        config["keepReasoningOnError"] = model?["keepReasoningOnError"]?.DeepClone() ?? provider["keepReasoningOnError"]?.DeepClone() ?? JsonValue.Create(false);
        foreach (var scope in new[] { provider, model }) if (scope?.ContainsKey("streamContentInactivityTimeoutMs") == true) _ = Positive(scope["streamContentInactivityTimeoutMs"], 60000, "streamContentInactivityTimeoutMs");
        config["streamContentInactivityTimeoutMs"] = Positive(model?["streamContentInactivityTimeoutMs"] ?? provider["streamContentInactivityTimeoutMs"], 60000, "streamContentInactivityTimeoutMs");
        if (type == "openai-ws" && provider["requestCompression"] is not null) throw new InvalidDataException("requestCompression is unsupported on openai-ws.");
        if (type != "openai-completions" && (provider.ContainsKey("historyReasoningField") || model?.ContainsKey("historyReasoningField") == true)) throw new InvalidDataException("historyReasoningField is only supported on openai-completions.");
        if (type == "openai-completions")
        {
            var reasoning = model?["historyReasoningField"] ?? provider["historyReasoningField"] ?? JsonValue.Create("reasoning_content");
            if (SessionWait.Text(reasoning) is not ("reasoning_content" or "reasoning")) throw new InvalidDataException("Invalid historyReasoningField.");
            config["historyReasoningField"] = reasoning.DeepClone();
        }
        var inherited = Effort(provider["effort"], Efforts, "high"); var effort = Effort(model?["effort"], inherited.Allowed, inherited.Default);
        config["effort"] = new JsonObject { ["allowed"] = new JsonArray(effort.Allowed.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()), ["default"] = effort.Default };
        var headers = Map(provider["extraHeaders"], "extraHeaders");
        foreach (var pair in Map(model?["extraHeaders"], "extraHeaders")) headers[pair.Key] = pair.Value?.DeepClone();
        config["extraHeaders"] = headers; config["extraFields"] = Merge(Map(provider["extraFields"], "extraFields"), Map(model?["extraFields"], "extraFields"));
        config["webSearch"] = Feature(provider["webSearch"], model?["webSearch"], image: false);
        config["imageGeneration"] = Feature(provider["imageGeneration"], model?["imageGeneration"], image: true);
        return new ConcreteHostModel(key, providerKey, id, type, url, token, context, effort.Allowed, effort.Default, config, []);
    }
    private static JsonObject Map(JsonNode? node, string label) => node is null ? new JsonObject() : node is JsonObject obj ? (JsonObject)obj.DeepClone() : throw new InvalidDataException(label + " must be an object.");
    internal static JsonObject Merge(JsonObject earlier, JsonObject later)
    {
        var result = (JsonObject)earlier.DeepClone();
        foreach (var (key, value) in later) result[key] = result[key] is JsonObject old && value is JsonObject added ? Merge(old, added) : value?.DeepClone();
        return result;
    }
    private static (string[] Allowed, string Default) Effort(JsonNode? node, string[] inherited, string fallback)
    {
        if (node is null) return ([.. inherited], fallback);
        var raw = node as JsonObject ?? throw new InvalidDataException("effort must be an object.");
        var allowed = inherited;
        if (raw.ContainsKey("allowed"))
        {
            var list = raw["allowed"] as JsonArray ?? throw new InvalidDataException("effort.allowed must be an array.");
            var values = list.Select(SessionWait.Text).ToArray();
            if (values.Length == 0 || values.Distinct().Count() != values.Length || values.Any(value => value is null || !Efforts.Contains(value))) throw new InvalidDataException("Invalid effort.allowed values.");
            allowed = Efforts.Where(values.Contains).ToArray();
        }
        var selected = raw.ContainsKey("default") ? SessionWait.Text(raw["default"]) : fallback;
        if (selected is null || !allowed.Contains(selected)) throw new InvalidDataException("effort.default must be in allowed.");
        return (allowed, selected);
    }
    private static JsonObject? Feature(JsonNode? earlier, JsonNode? later, bool image)
    {
        if (earlier is null && later is null) return null;
        JsonObject Normalize(JsonNode? value)
        {
            if (value is null) return new JsonObject();
            if (value is JsonValue scalar && scalar.TryGetValue<bool>(out var enabled)) return new JsonObject { ["enabled"] = enabled };
            var obj = value as JsonObject ?? throw new InvalidDataException("Hosted feature must be boolean or an options object.");
            var normalized = (JsonObject)obj.DeepClone();
            if (!normalized.ContainsKey("enabled")) normalized["enabled"] = true;
            if (normalized["enabled"] is not JsonValue flag || !flag.TryGetValue<bool>(out _)) throw new InvalidDataException("Hosted feature enabled must be boolean.");
            return normalized;
        }
        var result = Merge(Normalize(earlier), Normalize(later));
        if (image)
        {
            foreach (var (field, choices) in new Dictionary<string, string[]> { ["action"] = ["auto", "generate", "edit"], ["quality"] = ["auto", "low", "medium", "high", "xhigh", "max"], ["background"] = ["auto", "opaque", "transparent"], ["outputFormat"] = ["png", "jpeg", "webp"] })
                if (result[field] is not null && (SessionWait.Text(result[field]) is not string text || !choices.Contains(text))) throw new InvalidDataException("Invalid imageGeneration." + field + ".");
            foreach (var field in new[] { "model", "size" }) if (result.ContainsKey(field))
            { if (SessionWait.Text(result[field]) is not string text || string.IsNullOrWhiteSpace(text)) throw new InvalidDataException("imageGeneration." + field + " must be a nonempty string."); result[field] = text.Trim(); }
            if (result["outputCompression"] is not null && (SessionWait.Number(result["outputCompression"]) is not double compression || compression < 0 || compression > 100 || Math.Floor(compression) != compression)) throw new InvalidDataException("Invalid imageGeneration.outputCompression.");
            if (SessionWait.Text(result["background"]) == "transparent" && SessionWait.Text(result["outputFormat"]) == "jpeg") throw new InvalidDataException("Transparent image generation cannot use JPEG.");
        }
        else
        {
            foreach (var (field, choices) in new Dictionary<string, string[]> { ["toolChoice"] = ["auto", "required"], ["searchContextSize"] = ["low", "medium", "high"] })
                if (result.ContainsKey(field) && (SessionWait.Text(result[field]) is not string text || !choices.Contains(text))) throw new InvalidDataException("Invalid webSearch." + field + ".");
            if (result.ContainsKey("allowedDomains"))
            {
                if (result["allowedDomains"] is not JsonArray domains || domains.Any(domain => string.IsNullOrWhiteSpace(SessionWait.Text(domain)))) throw new InvalidDataException("webSearch.allowedDomains must contain nonempty strings.");
                result["allowedDomains"] = new JsonArray(domains.Select(domain => (JsonNode?)JsonValue.Create(SessionWait.Text(domain)!.Trim())).ToArray());
            }
            if (result.ContainsKey("userLocation"))
            {
                var location = Map(result["userLocation"], "webSearch.userLocation");
                if (location.ContainsKey("type") && SessionWait.Text(location["type"]) != "approximate") throw new InvalidDataException("webSearch.userLocation.type must be approximate.");
                foreach (var field in new[] { "country", "city", "region", "timezone" }) if (location.ContainsKey(field))
                    location[field] = SessionWait.Text(location[field])?.Trim() ?? throw new InvalidDataException("webSearch.userLocation values must be strings.");
                result["userLocation"] = location;
            }
        }
        return result;
    }
}
