using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal Task CommitVectorCompatibilityAsync() =>
        EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            var snapshot = entry.Snapshot();
            var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            envelope["vectorIndexPosition"] = snapshot.History.Count;
            envelope.Remove("indexingState");
            var staged = await PrepareGoalOnlyAsync(snapshot with { AuthorityEnvelope = envelope })
                .ConfigureAwait(false);
            void Publish()
            {
                entry.WithState(state =>
                {
                    state.AuthorityEnvelope["vectorIndexPosition"] = snapshot.History.Count;
                    state.AuthorityEnvelope.Remove("indexingState");
                });
                PublishGoalOnly(staged);
                entry.InvokeCommitted(entry.Snapshot());
            }
            try
            {
                await store.CommitAsync(staged, SaveKind.Strict);
            }
            catch (AuthorityCommittedException)
            {
                Publish();
                throw;
            }
            Publish();
        });
}
