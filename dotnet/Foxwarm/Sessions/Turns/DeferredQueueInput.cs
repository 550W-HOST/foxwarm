using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class DeferredQueueInput
{
    private const string Hint =
        "Queued input: this message or event may predate the preceding outputs. Its position here reflects when it was processed, not necessarily when it was sent or occurred.";

    internal static void Mark(IEnumerable<QueueItem> items)
    {
        foreach (var item in items)
            if (
                item.Type != QueueItemType.CompactCommit
                && (item.Message is null || SessionWait.Text(item.Message["role"]) == "user")
                && item.Message?["modelVisible"]?.ToJsonString() != "false"
            )
                item.QueuedInput = true;
    }

    internal static JsonObject Message(QueueItem item, JsonObject message)
    {
        if (
            !item.QueuedInput
            || SessionWait.Text(message["role"]) != "user"
            || message["modelVisible"]?.ToJsonString() == "false"
            || message["parts"] is not JsonArray parts
        )
            return message;
        InputWrapperMetadata.SetAttribute(parts, "queueInputHint", Hint);
        return message;
    }

}
