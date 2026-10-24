using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

// Message-only WebUI projection. Never walk arbitrary user arguments or tool results as messages.
internal static class WebUiMessageTransport
{
    internal static JsonObject Message(JsonObject source)
    {
        var message = (JsonObject)source.DeepClone();
        ProjectMessage(message);
        return message;
    }

    internal static void ProjectMessages(JsonNode? messages)
    {
        if (messages is JsonArray array)
            foreach (var message in array.OfType<JsonObject>())
                ProjectMessage(message);
    }

    internal static void ProjectMessage(JsonObject message)
    {
        if (
            message["providerMeta"] is JsonObject messageMeta
            && messageMeta["providerSpecificFields"] is JsonObject fields
        )
            ReplaceWithLength(fields, "reasoning_signature", "reasoning_signature_length");
        if (
            message["compaction"] is JsonObject compaction
            && compaction["planner"] is JsonObject planner
        )
            ProjectMessages(planner["messages"]);
        ProjectParts(message["parts"]);
    }

    internal static void ProjectParts(JsonNode? parts)
    {
        foreach (var part in (parts as JsonArray ?? []).OfType<JsonObject>())
        {
            if (part["functionCall"] is JsonObject call && !call.ContainsKey("argsParseError"))
                call.Remove("rawArgsText");
            if (part["providerMeta"] is not JsonObject metadata)
                continue;
            ReplaceWithLength(metadata, "encryptedThinking", "encryptedThinkingLength");
            ReplaceWithLength(metadata, "redactedThinking", "redactedThinkingLength");
            ReplaceWithLength(metadata, "signature", "signatureLength");
            if (
                metadata["openaiResponses"] is JsonObject responses
                && responses["outputItem"] is JsonObject item
                && SessionWait.Text(item["type"]) == "reasoning"
            )
                ReplaceWithLength(item, "encrypted_content", "encryptedThinkingLength");
        }
    }

    private static void ReplaceWithLength(JsonObject value, string field, string lengthField)
    {
        if (value[field] is JsonValue scalar && scalar.TryGetValue<string>(out var text))
        {
            value.Remove(field);
            value[lengthField] = text.Length;
        }
    }
}
