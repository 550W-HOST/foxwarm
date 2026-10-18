using System.Text.Json.Nodes;
using Foxwarm.Vector;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> SearchVectorHistoryAsync(
        string query,
        int limit,
        string? agent,
        string? sessionId
    )
    {
        var exact = !string.IsNullOrEmpty(sessionId);
        var lineage = exact ? ArchiveReader(sessionId!).VectorLineage() : null;
        var resolved = lineage?.FirstOrDefault()?.SessionId ?? sessionId;
        var options = exact
            ? new VectorSearchOptions(LineageSessions: lineage)
            : new VectorSearchOptions(Agent: string.IsNullOrEmpty(agent) ? null : agent);
        var search = await VectorRecall.SearchAsync(
            Vector,
            ArchiveReader,
            query,
            limit,
            options,
            exact ? "current-session"
                : string.IsNullOrEmpty(agent) ? "global"
                : "current-agent",
            resolved,
            bounded: true
        );
        foreach (var source in search.Sources.OfType<JsonObject>())
        {
            var messages = (source["messages"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
            var seqs = messages
                .Select(message => SessionWait.Number((message["__meta"] as JsonObject)?["seq"]))
                .OfType<double>()
                .Where(number =>
                    number > 0 && number <= 9007199254740991 && Math.Floor(number) == number
                )
                .Select(number => (long)number)
                .ToArray();
            var range = source["sourceRange"] as JsonObject;
            var first =
                seqs.Length > 0 ? seqs[0]
                : SessionWait.Number(range?["startSeq"]) is { } start ? (long?)start
                : null;
            var last =
                seqs.Length > 0 ? seqs[^1]
                : SessionWait.Number(range?["endSeq"]) is { } end ? (long?)end
                : null;
            var available =
                source["kind"]?.GetValue<string>() != "unavailable" && first is > 0 && last is > 0;
            var archive = ArchiveReader(VectorText.Text(source["sessionId"]));
            source["firstSeq"] = first;
            source["lastSeq"] = last;
            source["hasEarlier"] =
                available && archive.ReadEffectiveMessagesPage(null, first - 1, 1).Count > 0;
            source["hasLater"] =
                available && archive.ReadEffectiveMessagesPage(last + 1, null, 1).Count > 0;
        }
        var result = new JsonObject
        {
            ["results"] = search.Sources,
            ["searchKind"] = search.SearchLabel,
        };
        await Images.ExternalizeTreeAsync(result, strict: false);
        return result;
    }
}
