using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// The model and effort inputs of one tool-created Session after applying
/// <c>forceModel</c> &gt; the source's future-child defaults &gt; <c>model</c> &gt; the source's
/// own selection. <see cref="Force"/> and <see cref="Inherited"/> feed the existing
/// <c>ValidateModelSettings</c>; the sources label each field for the creation result.
/// </summary>
internal sealed record CreationModelPlan(
    JsonObject? Force,
    (string? Model, string? Effort) Inherited,
    string? ModelSource,
    string? EffortSource
);

internal sealed partial class SessionManager
{
    /// <summary>
    /// Resolves creation-time model inputs against the source Session's envelope.
    /// A <c>model</c> effort is strict (validated like <c>forceModel</c>) only when it takes effect.
    /// </summary>
    /// <param name="ignoreSuggested">
    /// True when the new Session's runtime manages its own model; <c>model</c> is still checked for
    /// an unknown key but never takes effect.
    /// </param>
    internal CreationModelPlan PlanCreationModel(
        JsonObject envelope,
        JsonObject? force,
        JsonObject? suggested,
        bool ignoreSuggested = false
    )
    {
        string? suggestedModel = null;
        string? suggestedEffort = null;
        if (suggested?["modelId"] is JsonNode idNode)
        {
            var id = SessionWait.Text(idNode);
            if (id is null || !models.Contains(id))
                throw new InvalidDataException("Unknown configured model key in model.");
            suggestedModel = id;
        }
        if (suggested?["effort"] is JsonNode effortNode)
            suggestedEffort = SessionWait.Text(effortNode);
        if (ignoreSuggested)
        {
            suggestedModel = null;
            suggestedEffort = null;
        }
        var forcedModel = SessionWait.Text(force?["modelId"]);
        var forcedEffort = SessionWait.Text(force?["effort"]);
        var childModel = SessionWait.Text(envelope["childModelDefault"]);
        var childEffort = SessionWait.Text(envelope["childEffortDefault"]);
        var rawModel = SessionWait.Text(envelope["model"]);
        var rawEffort = SessionWait.Text(envelope["effort"]);
        // An effort chosen together with a model describes that model; it is not applied to
        // another model that a higher-precedence setting selected.
        if (suggestedModel is not null && (forcedModel is not null || childModel is not null))
            suggestedEffort = null;
        var modelSource =
            forcedModel is not null ? "forceModel"
            : childModel is not null ? "child setting"
            : suggestedModel is not null ? "model"
            : rawModel is not null ? "inherited"
            : null;
        var effortSource =
            forcedEffort is not null ? "forceModel"
            : childEffort is not null ? "child setting"
            : suggestedEffort is not null ? "model"
            : rawEffort is not null ? "inherited"
            : null;
        var effective = force is null ? null : (JsonObject)force.DeepClone();
        if (effortSource == "model")
        {
            effective ??= new JsonObject();
            effective["effort"] = suggestedEffort;
        }
        return new CreationModelPlan(
            effective,
            (childModel ?? suggestedModel ?? rawModel, childEffort ?? rawEffort),
            modelSource,
            effortSource
        );
    }

    /// <summary>
    /// States the stored pair of a created Session and where each field came from, or null when
    /// the Session's runtime manages its own model.
    /// </summary>
    internal string? DescribeCreationModel(CreationModelPlan plan, SessionOwner created)
    {
        var envelope = created.Entry.Snapshot().AuthorityEnvelope;
        if (SessionWait.Text(envelope["runtime"]) == ClaudeRuntimeState.Kind)
            return null;
        var rawModel = SessionWait.Text(envelope["model"]);
        var key =
            rawModel is not null ? rawModel
            : models.All.Count == 0 ? "default"
            : models.DefaultKey;
        var modelSource = rawModel is null ? "global default" : plan.ModelSource ?? "inherited";
        var effort = SessionWait.Text(envelope["effort"]);
        return effort is null
            ? $"Model: {key} ({modelSource}); effort: default."
            : $"Model: {key} ({modelSource}); effort: {effort} ({plan.EffortSource ?? "inherited"}).";
    }
}
