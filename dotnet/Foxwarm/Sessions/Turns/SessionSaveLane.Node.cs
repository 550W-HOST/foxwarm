using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal async Task<(bool Changed, string? Previous, string? Current)> CommitNodeAsync(
        string value
    )
    {
        var next = value;
        (bool Changed, string? Previous, string? Current) result = default;
        await EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            var operation = entry.WithState(state =>
            {
                var snapshot = state.Snapshot();
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                var previous = SessionWait.Text(envelope["currentNode"]);
                result = (
                    !JsonNode.DeepEquals(
                        envelope["currentNode"],
                        next is null ? null : JsonValue.Create(next)
                    ),
                    previous,
                    next
                );
                if (next is null)
                    envelope.Remove("currentNode");
                else
                    envelope["currentNode"] = next;
                envelope.Remove("cwd");
                return snapshot with { AuthorityEnvelope = envelope };
            });

            void Publish(SessionState state)
            {
                state.AuthorityEnvelope.Remove("cwd");
                if (next is null)
                    state.AuthorityEnvelope.Remove("currentNode");
                else
                    state.AuthorityEnvelope["currentNode"] = next;
            }
            operation = await PrepareGoalOnlyAsync(operation).ConfigureAwait(false);
            var previousScope = SettingsCommitScope.Value;
            SettingsCommitScope.Value = true;
            try
            {
                await store.CommitAsync(operation, SaveKind.Strict);
            }
            catch (AuthorityCommittedException)
            {
                entry.WithState(Publish);
                PublishGoalOnly(operation);
                entry.InvokeCommitted(entry.Snapshot());
                throw;
            }
            finally
            {
                SettingsCommitScope.Value = previousScope;
            }
            entry.WithState(Publish);
            PublishGoalOnly(operation);
            entry.InvokeCommitted(entry.Snapshot());
        });
        return result;
    }
}
