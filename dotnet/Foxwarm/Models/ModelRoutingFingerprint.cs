using System.Text;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class ModelRoutingFingerprint
{
    internal static string Build(string strategy, string[] targets, IReadOnlyList<ConcreteHostModel> leaves, int threshold, int cooldown)
    {
        var data = new JsonObject { ["strategy"] = strategy, ["targets"] = new JsonArray(targets.Select(target => (JsonNode?)JsonValue.Create(target)).ToArray()),
            ["failureThreshold"] = threshold, ["cooldownMs"] = cooldown };
        var entries = new JsonArray();
        for (var index = 0; index < leaves.Count; index++)
        {
            var leaf = leaves[index]; var config = leaf.Configuration;
            entries.Add(new JsonObject
            {
                ["target"] = targets[index], ["providerType"] = leaf.ProviderType, ["model"] = leaf.ModelId,
                ["baseUrl"] = leaf.BaseUrl, ["requestCompression"] = config["requestCompression"]?.DeepClone(),
                ["contextLimit"] = leaf.ContextLimit,
                ["streamContentInactivityTimeoutMs"] = config["streamContentInactivityTimeoutMs"]?.DeepClone() ?? JsonValue.Create(60000),
                ["asyncCompact"] = !False(config["asyncCompact"]), ["disallowEmptyResponse"] = True(config["disallowEmptyResponse"]),
                ["keepReasoningOnError"] = True(config["keepReasoningOnError"]),
                ["effort"] = new JsonObject { ["allowed"] = new JsonArray(leaf.AllowedEfforts.Select(effort => (JsonNode?)JsonValue.Create(effort)).ToArray()), ["default"] = leaf.DefaultEffort },
                ["historyReasoningField"] = SessionWait.Text(config["historyReasoningField"]), ["apiKeyHash"] = Hash(JsonValue.Create(leaf.Token)),
                ["extraFieldsHash"] = Hash(config["extraFields"] ?? new JsonObject()), ["extraHeadersHash"] = Hash(config["extraHeaders"] ?? new JsonObject()),
                ["webSearchHash"] = Hash(config["webSearch"] ?? new JsonObject()), ["imageGenerationHash"] = Hash(config["imageGeneration"] ?? new JsonObject())
            });
        }
        data["leaves"] = entries; return Hash(data);
    }
    internal static bool True(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;
    internal static bool False(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) && !flag;
    internal static string Hash(JsonNode? node) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes((node is null ? "null" : EcmaJson.Stringify(Sorted(node)!))))).ToLowerInvariant();
    private static JsonNode? Sorted(JsonNode? node)
    {
        if (node is JsonArray array) return new JsonArray(array.Select(Sorted).ToArray());
        if (node is JsonObject obj)
        {
            var result = new JsonObject(); foreach (var key in obj.Select(pair => pair.Key).Order(StringComparer.Ordinal)) result[key] = Sorted(obj[key]); return result;
        }
        return node?.DeepClone();
    }
}
