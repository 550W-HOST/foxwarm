using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class SessionBlockCounter
{
    internal static long Resolve(SessionSnapshot snapshot, long effectiveArchiveMaximum) =>
        Resolve(snapshot.History, snapshot.AuthorityEnvelope, effectiveArchiveMaximum);

    internal static long Resolve(
        IReadOnlyList<HistoryMessage> history,
        JsonObject envelope,
        long effectiveArchiveMaximum
    )
    {
        var known = history
            .Select(row =>
            {
                var json = row.Data;
                return
                    json.TryGetProperty("__meta", out var meta)
                    && meta.ValueKind == JsonValueKind.Object
                    && meta.TryGetProperty("contextBlock", out var block)
                    && block.ValueKind == JsonValueKind.Object
                    && block.TryGetProperty("id", out var id)
                    ? HistoryMessage.Integer(id) ?? 0
                    : 0;
            })
            .DefaultIfEmpty(0)
            .Max();
        return Math.Max(
            CompactCandidateBuilder.Number(envelope["nextBlockId"]) ?? 1,
            checked(Math.Max(known, effectiveArchiveMaximum) + 1)
        );
    }
}
