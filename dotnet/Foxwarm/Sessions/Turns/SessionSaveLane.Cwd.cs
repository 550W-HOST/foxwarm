using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal async Task<(bool Changed, string? Previous, string? Current)> CommitCwdAsync(string? value)
    {
        var normalized = value is null ? "" : SessionGoal.Trim(value);
        var next = normalized.Length == 0 ? null : normalized;
        (bool Changed, string? Previous, string? Current) result = default;
        await EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            var operation = entry.WithState(state =>
            {
                var snapshot = state.Snapshot(); var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                var previous = SessionWait.Text(envelope["cwd"]);
                result = (!JsonNode.DeepEquals(envelope["cwd"], next is null ? null : JsonValue.Create(next)), previous, next);
                if (next is null) envelope.Remove("cwd"); else envelope["cwd"] = next;
                return snapshot with { AuthorityEnvelope = envelope };
            });
            if (!result.Changed) return;
            void Publish(SessionState state) { if (next is null) state.AuthorityEnvelope.Remove("cwd"); else state.AuthorityEnvelope["cwd"] = next; }
            var previousScope = SettingsCommitScope.Value; SettingsCommitScope.Value = true;
            try { await store.CommitAsync(operation, SaveKind.Strict); }
            catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
            finally { SettingsCommitScope.Value = previousScope; }
            entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot());
        });
        return result;
    }
}
