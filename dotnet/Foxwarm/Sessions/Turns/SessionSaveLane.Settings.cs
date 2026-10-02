using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    private static readonly AsyncLocal<bool> SettingsCommitScope = new();
    internal static bool IsSettingsCommit => SettingsCommitScope.Value;
    internal Task CommitSettingsAsync(JsonObject patch, HostModels models) => EnqueueOperationAsync(async () =>
    {
        using var admission = entry.AdmitMutation();
        var prepared = entry.WithState(state =>
        {
            var snapshot = state.Snapshot(); var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
            var desired = patch.Any(pair => SessionModelSettings.Fields.Contains(pair.Key)) ? SessionModelSettings.Normalize(envelope, patch, models) : new JsonObject();
            if (patch.ContainsKey("compactThresholdTokens")) desired["compactThresholdTokens"] = patch["compactThresholdTokens"]?.DeepClone();
            var changes = new JsonObject();
            foreach (var (key, value) in desired)
            {
                if (JsonNode.DeepEquals(envelope[key], value)) continue;
                changes[key] = value?.DeepClone(); if (value is null) envelope.Remove(key); else envelope[key] = value.DeepClone();
            }
            return (Snapshot: snapshot with { AuthorityEnvelope = envelope }, Changes: changes);
        });
        if (prepared.Changes.Count == 0) return;
        void Publish(SessionState state)
        {
            foreach (var (key, value) in prepared.Changes)
                if (value is null) state.AuthorityEnvelope.Remove(key); else state.AuthorityEnvelope[key] = value.DeepClone();
        }
        var previous = SettingsCommitScope.Value; SettingsCommitScope.Value = true;
        try { await store.CommitAsync(prepared.Snapshot, SaveKind.Strict); }
        catch (AuthorityCommittedException) { entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot()); throw; }
        finally { SettingsCommitScope.Value = previous; }
        entry.WithState(Publish); entry.InvokeCommitted(entry.Snapshot());
    });
}
