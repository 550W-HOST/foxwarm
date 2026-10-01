using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class RetryNoticeState
{
    internal JsonObject? Committed { get; set; }
    internal bool NotificationSucceeded { get; set; }
}

public sealed partial class SessionSaveLane
{
    internal Task CommitRetryNoticeAsync(RetryNoticeState notice, string chunk, JsonObject retry) => EnqueueOperationAsync(async () =>
    {
        var prepared = entry.WithState(state =>
        {
            var prior = notice.Committed;
            var seq = prior is null ? state.NextMessageSeq : SessionWait.Number(prior["__meta"]?["seq"]) is double id ? (long)id
                : throw new InvalidOperationException("Committed retry notice has no sequence.");
            var index = prior is null ? -1 : state.History.FindIndex(row => SessionWait.Number(row["__meta"]?["seq"]) == seq);
            if (prior is not null && index < 0) throw new InvalidOperationException("Committed retry notice is no longer in active history.");
            var message = prior is null ? new JsonObject { ["role"] = "model", ["modelVisible"] = false, ["parts"] = new JsonArray(new JsonObject { ["text"] = chunk }),
                ["__meta"] = new JsonObject { ["seq"] = seq, ["noticeType"] = "llm-retry" } } : (JsonObject)state.History[index].DeepClone();
            if (prior is not null)
            {
                var part = message["parts"]![0]!.AsObject(); part["text"] = (SessionWait.Text(part["text"]) ?? "") + "\n" + chunk;
                message["__meta"]!["updateExisting"] = true;
            }
            message["__meta"]!["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); message["__meta"]!["retry"] = retry.DeepClone();
            var snapshot = state.Snapshot(); var history = snapshot.History.Select(row => (JsonObject)row.DeepClone()).ToList();
            if (index < 0) history.Add((JsonObject)message.DeepClone()); else history[index] = (JsonObject)message.DeepClone();
            var meta = (JsonObject)snapshot.Meta.DeepClone(); meta["messageCount"] = history.Count;
            var staged = snapshot with { History = history, NextMessageSeq = index < 0 ? seq + 1 : state.NextMessageSeq, Meta = meta };
            void Publish(SessionState current)
            {
                if (index < 0)
                {
                    if (current.NextMessageSeq != seq) throw new InvalidOperationException("Retry append sequence changed before publication.");
                    current.History.Add((JsonObject)message.DeepClone()); current.NextMessageSeq = seq + 1;
                }
                else
                {
                    var actual = current.History.FindIndex(row => SessionWait.Number(row["__meta"]?["seq"]) == seq);
                    if (actual < 0) throw new InvalidOperationException("Retry update sequence disappeared before publication.");
                    current.History[actual] = (JsonObject)message.DeepClone();
                }
                current.Meta["messageCount"] = current.History.Count; notice.Committed = (JsonObject)message.DeepClone();
            }
            return (Staged: staged, Message: message, Append: index < 0, Publish: (Action<SessionState>)Publish);
        });
        void PublishCommitted()
        {
            entry.WithState(prepared.Publish);
            var failures = entry.BestEffortFailureCount; entry.InvokeCommitted(entry.Snapshot());
            notice.NotificationSucceeded = entry.BestEffortFailureCount == failures;
        }
        try
        {
            if (prepared.Append && store is ICanonicalAppendAuthorityStore canonical)
                await canonical.CommitCanonicalAppendAsync(prepared.Staged, [prepared.Message]);
            else await store.CommitAsync(prepared.Staged, SaveKind.Strict);
        }
        catch (AuthorityCommittedException) { PublishCommitted(); throw; }
        PublishCommitted();
    });
}
