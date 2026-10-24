using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Pure source lookup shared by model recall and the existing WebUI block expansion.
internal sealed class ArchiveContextReader(SqliteArchiveMessageStore archive)
{
    internal ArchiveStats Stats() => archive.EffectiveMessageStats();

    internal IReadOnlyList<ArchiveBlockTopology> Topology() => archive.EffectiveBlockTopology();

    internal ArchiveBlockRecord? Block(long id) =>
        archive.ReadEffectiveBlocksRange(id, id).FirstOrDefault();

    internal IReadOnlyList<ArchiveMessageRecord> Messages(long first, long last) =>
        archive.ReadEffectiveMessagesRange(first, last);

    internal IReadOnlyList<ArchiveBlockRecord> Children(ArchiveBlockRecord block)
    {
        if (block.SourceKind != "block")
            return [];
        if (block.SourceBlockIds is { Count: > 0 })
            return block
                .SourceBlockIds.Select(value => Block(value!.GetValue<long>()))
                .OfType<ArchiveBlockRecord>()
                .ToArray();
        return archive.ReadEffectiveBlocksRange(
            Math.Min(block.SourceStart, block.SourceEnd),
            Math.Max(block.SourceStart, block.SourceEnd)
        );
    }

    internal IReadOnlyList<ArchiveBlockTopology> Frontier(
        IReadOnlyList<ArchiveBlockTopology> topology
    )
    {
        var parents = topology.Where(row => row.Kind == "block").ToArray();
        return topology
            .Where(row =>
                !parents.Any(parent =>
                    parent.Id != row.Id
                    && (
                        parent.Children.Length > 0
                            ? parent.Children.Contains(row.Id)
                            : row.Id >= Math.Min(parent.First, parent.Last)
                                && row.Id <= Math.Max(parent.First, parent.Last)
                    )
                )
            )
            .ToArray();
    }

    internal static PreviewItem BlockItem(ArchiveBlockRecord block, string? ownerId = null)
    {
        var text = SessionWait.Text(block.ToMessage()["parts"]?[0]?["text"]) ?? block.Summary;
        return new(
            $"[CTX B#{block.Id}{ContextPreviewRenderer.Time(block.CreatedAt)}] "
                + (
                    ownerId is not null && ownerId != block.SessionId
                        ? "[inherited: " + block.SessionId + "]"
                        : "[local]"
                ),
            text,
            text,
            null,
            DrillDown: ContextPreviewRenderer.ArchiveDrill(
                ownerId ?? block.SessionId,
                $"B#{block.Id}"
            )
        );
    }

    internal JsonObject? Expand(string sessionId, long blockId, int previewLength)
    {
        var target = Block(blockId);
        if (target is null)
            return null;
        var items = new JsonArray();
        if (target.SourceKind == "block")
            foreach (var child in Children(target))
            {
                var message = child.ToMessage();
                ((JsonObject)message["__meta"]!)["contextArchiveItem"] = new JsonObject
                {
                    ["kind"] = "block",
                    ["id"] = child.Id,
                };
                items.Add(
                    new JsonObject
                    {
                        ["kind"] = "block",
                        ["message"] = message,
                        ["block"] = child.ToContextMeta(),
                        ["timestamp"] = child.CreatedAt,
                        ["sourceSessionId"] = child.SessionId,
                        ["inherited"] = child.SessionId != sessionId,
                    }
                );
            }
        else
            foreach (var record in Messages(target.SourceStart, target.SourceEnd))
            {
                var message = (JsonObject)record.Message.DeepClone();
                var meta = message["__meta"] as JsonObject ?? new JsonObject();
                message["__meta"] = meta;
                meta["contextArchiveItem"] = new JsonObject
                {
                    ["kind"] = "message",
                    ["seq"] = record.Seq,
                };
                items.Add(
                    new JsonObject
                    {
                        ["kind"] = "message",
                        ["message"] = message,
                        ["seq"] = record.Seq,
                        ["timestamp"] = record.Timestamp,
                        ["sourceSessionId"] = record.SessionId,
                        ["inherited"] = record.SessionId != sessionId,
                    }
                );
            }
        var renderer = new ContextPreviewRenderer(
            new JsonObject { ["previewLength"] = previewLength },
            1000
        );
        return new JsonObject
        {
            ["sessionId"] = sessionId,
            ["blockId"] = blockId,
            ["expansionKind"] = target.SourceKind == "block" ? "child-blocks" : "messages",
            ["target"] = $"B#{blockId}",
            ["previewLength"] = previewLength,
            ["text"] = renderer.RenderItems(
                [BlockItem(target, sessionId)],
                $"CTX-BLOCK B#{blockId} for session `{sessionId}`.",
                _ => "Block summary:",
                "No summary."
            ),
            ["items"] = items,
            ["messages"] = new JsonArray(
                items.OfType<JsonObject>().Select(item => item["message"]?.DeepClone()).ToArray()
            ),
            ["totalItems"] = items.Count,
            ["block"] = target.ToContextMeta(),
        };
    }
}
