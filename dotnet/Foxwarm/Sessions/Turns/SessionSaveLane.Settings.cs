using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{

    internal Task CommitSettingsAsync(JsonObject patch, HostModels models) =>
        EnqueueOperationAsync(async () =>
        {
            using var admission = entry.AdmitMutation();
            var prepared = entry.WithState(state =>
            {
                var snapshot = state.Snapshot();
                var envelope = (JsonObject)snapshot.AuthorityEnvelope.DeepClone();
                var desired = patch.Any(pair => SessionModelSettings.Fields.Contains(pair.Key))
                    ? SessionModelSettings.Normalize(envelope, patch, models)
                    : new JsonObject();
                if (patch.ContainsKey("compactThresholdTokens"))
                {
                    var supplied = patch["compactThresholdTokens"];
                    var threshold = SessionWait.Number(supplied);
                    if (
                        supplied is not null
                        && (
                            threshold is null || !double.IsFinite(threshold.Value) || threshold <= 0
                        )
                    )
                        throw new InvalidDataException(
                            "compactThresholdTokens must be a positive number or null."
                        );
                    desired["compactThresholdTokens"] = threshold is null
                        ? null
                        : JsonValue.Create(Math.Floor(threshold.Value));
                }
                if (patch.ContainsKey("verbose"))
                {
                    if (patch["verbose"] is not JsonValue flag || !flag.TryGetValue<bool>(out _))
                        throw new InvalidDataException("verbose must be boolean.");
                    desired["verbose"] = flag.DeepClone();
                }
                var changes = new JsonObject();
                foreach (var (key, value) in desired)
                {
                    if (JsonNode.DeepEquals(envelope[key], value))
                        continue;
                    changes[key] = value?.DeepClone();
                    if (value is null)
                        envelope.Remove(key);
                    else
                        envelope[key] = value.DeepClone();
                }
                return (Snapshot: snapshot with { AuthorityEnvelope = envelope }, Changes: changes);
            });
            if (prepared.Changes.Count == 0)
                return;
            void Publish(SessionState state)
            {
                foreach (var (key, value) in prepared.Changes)
                    if (value is null)
                        state.AuthorityEnvelope.Remove(key);
                    else
                        state.AuthorityEnvelope[key] = value.DeepClone();
            }
            var staged = await PrepareGoalOnlyAsync(prepared.Snapshot).ConfigureAwait(false);
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
        });
}
