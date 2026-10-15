using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class ConcreteRequestHistory
{
    internal static IReadOnlyList<JsonObject> Prepare(
        IReadOnlyList<JsonObject> history,
        string destinationModelId
    )
        => PrepareCore(history, destinationModelId, copyMessages: true);

    private static IReadOnlyList<JsonObject> PrepareCore(
        IReadOnlyList<JsonObject> history,
        string destinationModelId,
        bool copyMessages
    )
    {
        var prepared = new List<JsonObject>();
        foreach (var original in history)
        {
            // Visibility belongs to canonical admission, before request-only metadata removal.
            if (!CanonicalMessage.IsVisible(original))
                continue;
            var source =
                SessionWait.Text(original["role"]) == "model"
                    ? SessionWait.Text((original["__meta"] as JsonObject)?["modelId"])
                    : null;
            if (
                source is not null
                && (source.Length == 0 || source != OpenAIRequestText.Trim(source))
            )
                source = null;
            var message = copyMessages ? (JsonObject)original.DeepClone() : original;
            message.Remove("__meta");
            ProjectDisplayMetadata(message);
            if (source is null || source == destinationModelId)
            {
                prepared.Add(message);
                continue;
            }

            message.Remove("providerMeta");
            var parts = new JsonArray();
            var originalParts = (message["parts"] as JsonArray ?? []);
            var ownedParts = originalParts.OfType<JsonObject>().ToArray();
            originalParts.Clear();
            foreach (var copy in ownedParts)
            {
                copy.Remove("thinking");
                if (copy["providerMeta"] is JsonObject metadata)
                {
                    var generatedOutput = metadata["openaiResponses"]?["outputItem"] as JsonObject;
                    var preserveGenerated =
                        SessionWait.Text(generatedOutput?["type"]) == "image_generation_call";
                    foreach (
                        var key in new[]
                        {
                            "thinkingSummaries",
                            "encryptedThinking",
                            "signature",
                            "redactedThinking",
                        }
                    )
                        metadata.Remove(key);
                    if (!preserveGenerated)
                        metadata.Remove("openaiResponses");
                    if (metadata.Count == 0)
                        copy.Remove("providerMeta");
                }
                if (copy.Count > 0)
                    parts.Add(copy);
            }
            var legacy = message["content"];
            var hasLegacyContent =
                legacy is JsonValue value && value.TryGetValue<string>(out var text)
                    ? text.Length > 0
                : legacy is JsonArray array ? array.Count > 0
                : legacy is not null;
            if (parts.Count == 0 && !hasLegacyContent)
                continue;
            message["parts"] = parts;
            prepared.Add(message);
        }
        return prepared;
    }

    internal static void ProjectDisplayMetadata(JsonObject message)
    {
        message.Remove("compaction");
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (part["functionResponse"] is not JsonObject response)
                continue;
            if (
                response["__meta"] is JsonObject metadata
                && metadata.ContainsKey("toolScriptSubCalls")
            )
                response["response"] = new JsonObject
                {
                    ["output"] = Foxwarm.Tools.ToolResponseFormatting.FormatToolScriptExecution(
                        response["response"]
                    ),
                };
            response.Remove("__meta");
        }
    }

    internal static IReadOnlyList<JsonObject> PrepareRequest(
        IReadOnlyList<JsonObject> history,
        string destinationModelId
    ) => PrepareCore(RequestHistoryRepair.SelectAndRepair(history), destinationModelId, copyMessages: false);

    internal sealed class ChatService(IChatService inner, string destinationModelId) : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken cancellationToken
        ) =>
            inner.ChatAsync(
                sessionId,
                PrepareRequest(history, destinationModelId),
                cancellationToken
            );
    }
}
