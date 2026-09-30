using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class ContextBlockExpansion
{
    public static JsonObject? Render(SqliteArchiveMessageStore archive, string id, long blockId, int previewLength) =>
        new ArchiveContextReader(archive).Expand(id, blockId, previewLength);
}
