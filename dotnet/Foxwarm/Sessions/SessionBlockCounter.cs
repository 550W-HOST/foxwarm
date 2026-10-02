using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class SessionBlockCounter
{
    internal static long Resolve(SessionSnapshot snapshot, long effectiveArchiveMaximum) => Resolve(snapshot.History, snapshot.AuthorityEnvelope, effectiveArchiveMaximum);
    internal static long Resolve(IReadOnlyList<JsonObject> history, JsonObject envelope, long effectiveArchiveMaximum)
    {
        var known = history.Select(row => CompactCandidateBuilder.Number(row["__meta"]?["contextBlock"]?["id"]) ?? 0).DefaultIfEmpty(0).Max();
        return Math.Max(CompactCandidateBuilder.Number(envelope["nextBlockId"]) ?? 1,
            checked(Math.Max(known, effectiveArchiveMaximum) + 1));
    }
}
