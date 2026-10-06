using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    private static readonly AsyncLocal<bool> GoalCommitScope = new();
    internal static bool IsGoalCommit => GoalCommitScope.Value;

    internal Task SetGoalAsync(string? goal, JsonNode? interval, bool suppliedInterval) =>
        EnqueueOperationAsync(async () =>
        {
            var staged = entry.WithState(state =>
            {
                var snapshot = state.Snapshot();
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                if (goal is null)
                    envelope.Remove("goalState");
                else
                {
                    var every =
                        suppliedInterval ? SessionGoal.Interval(interval)
                        : envelope["goalState"] is JsonObject existing
                            ? SessionGoal.Interval(existing["remindEvery"])
                        : 20;
                    envelope["goalState"] = new JsonObject
                    {
                        ["goal"] = goal,
                        ["remindEvery"] = every,
                        ["anchorSeq"] = Math.Max(0, state.NextMessageSeq - 1),
                        ["updatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    };
                }
                return snapshot with { AuthorityEnvelope = envelope };
            });
            void Publish(SessionState state)
            {
                if (staged.AuthorityEnvelope["goalState"] is JsonNode next)
                    state.AuthorityEnvelope["goalState"] = next.DeepClone();
                else
                    state.AuthorityEnvelope.Remove("goalState");
            }
            var previous = GoalCommitScope.Value;
            GoalCommitScope.Value = true;
            try
            {
                await store.CommitAsync(staged, SaveKind.Strict);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            finally
            {
                GoalCommitScope.Value = previous;
            }
            entry.WithState(Publish);
            entry.InvokeCommitted(entry.Snapshot());
        });

    internal Task AppendGoalReminderAsync(CancellationToken token) =>
        EnqueueOperationAsync(async () =>
        {
            var prepared = entry.WithState(state =>
            {
                if (state.Stopping)
                    return (CanonicalAppendPreparation?)null;
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var candidate = SessionGoal.Prepare(state, now);
                if (candidate is null)
                    return null;
                var (goal, message) = candidate.Value;
                var snapshot = state.Snapshot();
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                envelope["goalState"] = goal;
                var meta = (JsonObject)snapshot.Meta.DeepClone();
                meta["messageCount"] = state.History.Count + 1;
                meta["lastMessageTime"] = now;
                var staged = snapshot with
                {
                    History = snapshot.History.Append(message).ToArray(),
                    NextMessageSeq = state.NextMessageSeq + 1,
                    Meta = meta,
                    AuthorityEnvelope = envelope,
                };
                void Publish(SessionState current)
                {
                    current.AuthorityEnvelope["goalState"] = goal.DeepClone();
                    current.History.Add((JsonObject)message.DeepClone());
                    current.NextMessageSeq = staged.NextMessageSeq;
                    current.Meta["messageCount"] = current.History.Count;
                    current.Meta["lastMessageTime"] = now;
                }
                return new CanonicalAppendPreparation(staged, [message], Publish);
            });
            if (prepared is null)
                return;
            var previous = GoalCommitScope.Value;
            GoalCommitScope.Value = true;
            try
            {
                if (store is ICanonicalAppendAuthorityStore canonical)
                    await canonical.CommitCanonicalAppendAsync(
                        prepared.StagedSnapshot,
                        prepared.AppendedMessages,
                        token
                    );
                else
                    await store.CommitAsync(prepared.StagedSnapshot, SaveKind.Strict, token);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(prepared.Publish);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            finally
            {
                GoalCommitScope.Value = previous;
            }
            entry.WithState(prepared.Publish);
            entry.InvokeCommitted(entry.Snapshot());
        });
}
