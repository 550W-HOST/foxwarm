using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal async Task<string> EnsurePromptCacheKeyAsync()
    {
        string? result = null;
        await EnqueueOperationAsync(async () =>
        {
            var snapshot = entry.Snapshot();
            var key = SessionWait.Text(snapshot.AuthorityEnvelope["promptCacheKey"]);
            if (!string.IsNullOrWhiteSpace(key))
            {
                result = key;
                return;
            }
            key = Guid.NewGuid().ToString();
            var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            envelope["promptCacheKey"] = key;
            var staged = await PrepareGoalOnlyAsync(snapshot with { AuthorityEnvelope = envelope })
                .ConfigureAwait(false);
            void Publish(SessionState state) => state.AuthorityEnvelope["promptCacheKey"] = key;
            try
            {
                await store.CommitAsync(staged, SaveKind.Strict);
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
            result = key;
        });
        return result!;
    }
}
