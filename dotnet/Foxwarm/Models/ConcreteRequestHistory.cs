using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class ConcreteRequestHistory
{
    internal static IReadOnlyList<JsonObject> Prepare(IReadOnlyList<JsonObject> history, string destinationModelId)
    {
        var prepared = new List<JsonObject>();
        foreach (var original in history)
        {
            // Visibility belongs to canonical admission, before request-only metadata removal.
            if (!CanonicalMessage.FromNode(original).IsModelVisible) continue;
            var source = SessionWait.Text(original["role"]) == "model"
                ? SessionWait.Text((original["__meta"] as JsonObject)?["modelId"])
                : null;
            if (source is not null && (source.Length == 0 || source != OpenAIRequestText.Trim(source))) source = null;
            var message = (JsonObject)original.DeepClone();
            message.Remove("__meta");
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
                if (part["functionResponse"] is JsonObject response) response.Remove("__meta");
            if (source is null || source == destinationModelId)
            {
                prepared.Add(message);
                continue;
            }

            message.Remove("providerMeta");
            var parts = new JsonArray();
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var copy = (JsonObject)part.DeepClone();
                copy.Remove("thinking");
                if (copy["providerMeta"] is JsonObject metadata)
                {
                    foreach (var key in new[] { "thinkingSummaries", "encryptedThinking", "signature", "openaiResponses" }) metadata.Remove(key);
                    if (metadata.Count == 0) copy.Remove("providerMeta");
                }
                if (copy.Count > 0) parts.Add(copy);
            }
            var legacy = message["content"];
            var hasLegacyContent = legacy is JsonValue value && value.TryGetValue<string>(out var text)
                ? text.Length > 0
                : legacy is JsonArray array ? array.Count > 0 : legacy is not null;
            if (parts.Count == 0 && !hasLegacyContent) continue;
            message["parts"] = parts;
            prepared.Add(message);
        }
        return prepared;
    }

    internal static IReadOnlyList<JsonObject> PrepareRequest(IReadOnlyList<JsonObject> history, string destinationModelId) =>
        Prepare(RequestHistoryRepair.SelectAndRepair(history), destinationModelId);

    internal sealed class ChatService(IChatService inner, string destinationModelId) : IChatService
    {
        public Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken) =>
            inner.ChatAsync(sessionId, PrepareRequest(history, destinationModelId), cancellationToken);
    }
}
