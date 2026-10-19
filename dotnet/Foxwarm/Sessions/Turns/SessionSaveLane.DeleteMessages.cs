using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal async Task<(int Deleted, int Remaining)> DeleteMessagesAsync(int count)
    {
        (int Deleted, int Remaining) result = default;
        await EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            var before = entry.Snapshot();
            var deleted = (int)Math.Min(Math.Abs((long)count), before.History.Count);
            var history = SessionHistory.FromMessages(count > 0
                ? before.History.Skip(deleted)
                : before.History.Take(before.History.Count - deleted));
            result = (deleted, history.Count);
            if (count == 0)
                return;
            var envelope = (JsonObject)before.AuthorityEnvelope.DeepClone();
            envelope.Remove("indexingState");
            if (SessionWait.Number(envelope["vectorIndexPosition"]) is double position)
                envelope["vectorIndexPosition"] = count > 0
                    ? Math.Max(0, position - deleted)
                    : Math.Min(position, history.Count);
            var meta = (JsonObject)before.Meta.DeepClone();
            meta["messageCount"] = history.Count;
            var staged = before with
            {
                History = history,
                HistoryVersion = before.HistoryVersion + 1,
                AuthorityEnvelope = envelope,
                Meta = meta,
            };
            staged = await PrepareGoalOnlyAsync(staged).ConfigureAwait(false);
            void Publish(SessionState state)
            {
                state.PublishCommittedHistoryRewrite(history, before.HistoryVersion,
                    before.NextMessageSeq, before.NextMessageSeq);
                state.AuthorityEnvelope.Remove("indexingState");
                if (envelope["vectorIndexPosition"] is { } position)
                    state.AuthorityEnvelope["vectorIndexPosition"] = position.DeepClone();
            }
            try
            {
                await store.CommitAsync(staged, SaveKind.Strict).ConfigureAwait(false);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                PublishGoalOnly(staged);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            entry.WithState(Publish);
            PublishGoalOnly(staged);
            entry.InvokeCommitted(entry.Snapshot());
        }).ConfigureAwait(false);
        return result;
    }
}
