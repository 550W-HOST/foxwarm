using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// The persisted JSON form of a queue item inside Session authority, shared by every authority
/// representation and by wait snapshots.
/// </summary>
internal static class SessionQueueJson
{
    internal static JsonObject ToJson(QueueItem item)
    {
        if (item.Type == QueueItemType.CompactCommit)
            return new JsonObject { ["type"] = "compact-commit" };
        var result = item.OpenFields is null
            ? new JsonObject()
            : (JsonObject)item.OpenFields.DeepClone();
        result.Remove("queuedInput");
        if (item.QueuedInput)
            result["queuedInput"] = true;
        result.Remove("trigger");
        if (!item.Trigger)
            result["trigger"] = false;
        result["type"] = item.Type switch
        {
            QueueItemType.User => "user",
            QueueItemType.Intersession => "intersession",
            QueueItemType.Background => "background",
            QueueItemType.Trigger => "trigger",
            QueueItemType.OnBoot => "onboot",
            _ => throw new UnsupportedSessionTurnException($"persisted queue type {item.Type}"),
        };
        if (item.Source is null)
            result.Remove("source");
        else
        {
            var source = item.Source.OpenFields is null
                ? new JsonObject()
                : (JsonObject)item.Source.OpenFields.DeepClone();
            source["platform"] = item.Source.Platform;
            source["channelUserId"] = item.Source.ChannelUserId;
            SetOptional(source, "channelId", item.Source.ChannelId);
            SetOptional(source, "channelType", item.Source.ChannelType);
            SetOptional(source, "conversationId", item.Source.ConversationId);
            SetOptional(source, "username", item.Source.Username);
            SetOptional(source, "senderId", item.Source.SenderId);
            result["source"] = source;
        }
        SetOptional(result, "clientMessageId", item.ClientMessageId);
        SetOptional(result, "sourceSessionId", item.SourceSessionId);
        SetOptional(result, "sourceSessionRelation", item.SourceSessionRelation);
        if (item.Parts is null)
            result.Remove("parts");
        else
            result["parts"] = new JsonArray(
                item.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
            );
        if (item.Message is null)
            result.Remove("message");
        else
            result["message"] = item.Message.DeepClone();
        return result;
    }

    internal static QueueItem FromJson(JsonObject value)
    {
        var type = value["type"]!.GetValue<string>() switch
        {
            "user" => QueueItemType.User,
            "intersession" => QueueItemType.Intersession,
            "background" => QueueItemType.Background,
            "trigger" => QueueItemType.Trigger,
            "onboot" => QueueItemType.OnBoot,
            "compact-commit" => QueueItemType.CompactCommit,
            var unsupported => throw new UnsupportedSessionTurnException(
                $"persisted queue type {unsupported}"
            ),
        };
        QueueSource? source = null;
        if (value["source"] is JsonObject sourceJson)
            source = new QueueSource(
                sourceJson["platform"]!.GetValue<string>(),
                sourceJson["channelUserId"]!.GetValue<string>(),
                OptionalString(sourceJson, "channelId"),
                OptionalString(sourceJson, "channelType"),
                OptionalString(sourceJson, "conversationId"),
                OptionalString(sourceJson, "username"),
                OptionalString(sourceJson, "senderId"),
                (JsonObject)sourceJson.DeepClone()
            );
        var parts = value["parts"] is JsonArray partArray
            ? partArray.Select(node => (JsonObject)node!.DeepClone()).ToArray()
            : null;
        return new QueueItem(
            type,
            parts,
            value["message"] is JsonObject message ? (JsonObject)message.DeepClone() : null,
            source,
            OptionalString(value, "clientMessageId"),
            OptionalString(value, "sourceSessionId"),
            OptionalString(value, "sourceSessionRelation"),
            (JsonObject)value.DeepClone(),
            value["trigger"] is JsonValue trigger
            && trigger.TryGetValue<bool>(out var shouldTrigger)
                ? shouldTrigger
                : true
        )
        {
            QueuedInput =
                value["queuedInput"] is JsonValue queued
                && queued.TryGetValue<bool>(out var observed)
                && observed,
        };
    }

    private static void SetOptional(JsonObject value, string property, string? content)
    {
        if (content is null)
            value.Remove(property);
        else
            value[property] = content;
    }

    private static string? OptionalString(JsonObject value, string property) =>
        value[property] is JsonValue node && node.TryGetValue<string>(out var result)
            ? result
            : null;
}
