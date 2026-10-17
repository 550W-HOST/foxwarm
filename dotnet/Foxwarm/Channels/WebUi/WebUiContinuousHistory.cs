using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal static class WebUiContinuousHistory
{
    // Snapshot bounds constrain display reads; Archive never supplies active authority.
    internal static JsonObject Read(
        SqliteArchiveMessageStore archive,
        long? before,
        long? after,
        long latest
    )
    {
        var descending = after is null;
        var first = after is long afterSeq ? afterSeq + 1 : (long?)null;
        var last = before is long beforeSeq ? Math.Min(latest, beforeSeq - 1) : latest;
        var records = archive.ReadEffectiveMessagesPage(first, last, 100, descending);
        var more =
            records.Count == 100
            && (
                descending
                    ? archive.ReadEffectiveMessagesPage(first, records[^1].Seq - 1, 1).Count > 0
                    : archive.ReadEffectiveMessagesPage(records[^1].Seq + 1, last, 1).Count > 0
            );
        if (descending)
            records = records.Reverse().ToArray();
        var messages = new JsonArray();
        foreach (var record in records)
        {
            var message = record.Message.DeepClone().AsObject();
            var meta = message["__meta"] as JsonObject ?? new JsonObject();
            meta["seq"] = record.Seq;
            if (meta["timestamp"] is null || SessionWait.Number(meta["timestamp"]) == 0)
                meta["timestamp"] = record.Timestamp;
            message["__meta"] = meta;
            messages.Add(message);
        }
        var result = new JsonObject
        {
            ["latestSeq"] = latest,
            ["messages"] = messages,
            ["hasMore"] = more,
        };
        if (records.Count > 0)
        {
            result["firstSeq"] = records[0].Seq;
            result["lastSeq"] = records[^1].Seq;
        }
        return result;
    }
}
