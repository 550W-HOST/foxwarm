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

    internal static void ProjectHistoryViewerMessages(JsonNode? messages)
    {
        if (messages is JsonArray array)
            foreach (var message in array.OfType<JsonObject>())
                ProjectHistoryViewerMessage(message);
    }

    internal static void ProjectHistoryViewerMessage(JsonObject message)
    {
        ProjectMessage(message);
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (part["providerMeta"] is not JsonObject metadata
                || metadata["openaiResponses"] is not JsonObject responses
                || responses["outputItem"] is not JsonObject item
                || SessionWait.Text(item["type"]) != "web_search_call")
                continue;
            var display = new JsonObject();
            foreach (var field in new[] { "sourceModelId", "annotations" })
                if (responses.ContainsKey(field))
                    display[field] = responses[field]?.DeepClone();
            JsonObject? action = null;
            if (item["action"] is JsonObject original)
            {
                if (SessionWait.Text(original["type"]) == "search")
                {
                    action = new JsonObject { ["type"] = "search" };
                    if (SessionWait.Text(original["query"]) is { } query)
                        action["query"] = query;
                    if (original["queries"] is JsonArray queries)
                        action["queries"] = new JsonArray(queries
                            .OfType<JsonValue>().Where(value => value.TryGetValue<string>(out _))
                            .Take(20).Select(value => value.DeepClone()).ToArray());
                }
                else if (SessionWait.Text(original["type"]) == "open_page"
                    && SessionWait.Text(original["url"]) is { } url)
                    action = new JsonObject { ["type"] = "open_page", ["url"] = url };
            }
            if (action is not null)
                display["outputItem"] = new JsonObject { ["type"] = "web_search_call", ["action"] = action };
            metadata["openaiResponses"] = display;
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
