using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

internal static class ContextBlockExpansion
{
    public static JsonObject? Render(SqliteArchiveMessageStore archive, string id, long blockId, int previewLength)
    {
        var blocks = archive.ReadBlocks();
        var target = blocks.FirstOrDefault(block => block.Id == blockId);
        if (target is null) return null;
        var items = new JsonArray();
        if (target.SourceKind == "block")
        {
            var byId = blocks.ToDictionary(block => block.Id);
            foreach (var value in target.SourceBlockIds?.OfType<JsonValue>() ?? [])
            {
                if (!value.TryGetValue<long>(out var childId) || !byId.TryGetValue(childId, out var child)) continue;
                var message = child.ToMessage();
                var meta = (JsonObject)message["__meta"]!;
                meta["contextArchiveItem"] = new JsonObject { ["kind"] = "block", ["id"] = child.Id };
                items.Add(new JsonObject
                {
                    ["kind"] = "block", ["message"] = message, ["block"] = child.ToContextMeta(),
                    ["timestamp"] = child.CreatedAt
                });
            }
        }
        else
        {
            foreach (var record in archive.ReadMessagesRange(target.SourceStart, target.SourceEnd))
            {
                var message = (JsonObject)record.Message.DeepClone();
                var meta = message["__meta"] as JsonObject ?? new JsonObject();
                message["__meta"] = meta;
                meta["contextArchiveItem"] = new JsonObject { ["kind"] = "message", ["seq"] = record.Seq };
                items.Add(new JsonObject
                {
                    ["kind"] = "message", ["message"] = message, ["seq"] = record.Seq,
                    ["timestamp"] = record.Timestamp
                });
            }
        }
        var blockText = target.ToMessage()["parts"]?[0]?["text"]?.GetValue<string>() ?? "";
        var summary = target.Summary.EnumerateRunes().Take(previewLength).Select(rune => rune.ToString());
        return new JsonObject
        {
            ["sessionId"] = id, ["blockId"] = blockId,
            ["expansionKind"] = target.SourceKind == "block" ? "child-blocks" : "messages",
            ["target"] = $"B#{blockId}", ["previewLength"] = previewLength,
            ["text"] = blockText[..Math.Min(blockText.Length, 240)] + "\n" + string.Concat(summary),
            ["items"] = items,
            ["messages"] = new JsonArray(items.OfType<JsonObject>().Select(item => item["message"]?.DeepClone()).ToArray()),
            ["totalItems"] = items.Count, ["block"] = target.ToContextMeta()
        };
    }
}
