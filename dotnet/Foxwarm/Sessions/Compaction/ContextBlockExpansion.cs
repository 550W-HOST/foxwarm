using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class ContextBlockExpansion
{
    public static JsonObject? Render(
        IArchiveSession archive,
        string id,
        long blockId,
        int previewLength
    ) => new ArchiveContextReader(archive).Expand(id, blockId, previewLength);
}
