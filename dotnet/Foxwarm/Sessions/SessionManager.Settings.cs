using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Model-facing `session model`: the caller's own Session or one of its descendants (user
    // decision, 2026-11-19). Authorization policy can narrow this further as session.control
    // settings of the target.
    private async Task<JsonObject> SessionModelAsync(SessionOwner source, JsonObject args)
    {
        Keys(args, ["sessionId", "model", "effort"], []);
        var owner = await RequiredAsync(OptionalString(args, "sessionId") ?? source.Id);
        if (owner.Id != source.Id && !IsDescendantSession(owner.Id, source.Id))
            throw new InvalidOperationException(
                $"Session `{owner.Id}` is not this Session or one of its descendants."
            );
        var patch = new JsonObject();
        if (args.ContainsKey("model"))
        {
            var model =
                SessionWait.Text(args["model"])?.Trim()
                ?? throw new InvalidDataException("model must be a configured model key.");
            patch["model"] = model is "" or "default" ? null : JsonValue.Create(model);
        }
        if (args.ContainsKey("effort"))
        {
            var effort = args["effort"] is null
                ? null
                : SessionWait.Text(args["effort"])?.Trim().ToLowerInvariant()
                    ?? throw new InvalidDataException(
                        "effort must be a canonical effort string or null."
                    );
            patch["effort"] = effort is null or "" or "default" or "unset"
                ? null
                : JsonValue.Create(effort);
        }
        if (patch.Count > 0)
            await owner.Entry.SaveLane.CommitSettingsAsync(patch, models);
        var dto = owner.BuildDto();
        var catalog = models.Capture();
        var raw = owner.Metadata().Model;
        var current = raw is not null && catalog.Contains(raw) ? raw : catalog.DefaultKey;
        var leaf = catalog.All.Count == 0 ? null : catalog.Resolve(current);
        var result = new JsonObject
        {
            ["sessionId"] = owner.Id,
            ["model"] = current,
            ["modelOverride"] = raw,
            ["effort"] = owner.Metadata().Effort,
            ["effectiveEffort"] = dto["effectiveEffort"]?.DeepClone(),
            ["allowedEfforts"] = new JsonArray(
                (leaf?.AllowedEfforts ?? HostModels.Efforts)
                    .Select(value => (JsonNode?)JsonValue.Create(value))
                    .ToArray()
            ),
        };
        if (patch.Count == 0)
            result["models"] = new JsonArray(
                catalog
                    .Options.Select(option => (JsonNode?)JsonValue.Create(option.Key))
                    .ToArray()
            );
        return result;
    }

    private bool IsDescendantSession(string id, string ancestor)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal) { id };
        var current = id;
        while (AuthorizationParent(Catalog.Get(current)) is { } parent)
        {
            if (parent == ancestor)
                return true;
            if (!seen.Add(parent))
                return false;
            current = parent;
        }
        return false;
    }

    private async Task<JsonObject> SessionSettingsAsync(
        SessionOwner source,
        string name,
        JsonObject args
    )
    {
        var child = name == "set_session_child_model";
        Keys(
            args,
            child
                ? ["sessionId", "model", "effort", "clear"]
                : ["sessionId", "thresholdTokens", "clear"],
            []
        );
        var id = OptionalString(args, "sessionId") ?? source.Id;
        var owner = await RequiredAsync(id);
        if (!child)
            ClaudeRuntimeState.RequireFoxwarm(owner, "Foxwarm context settings");
        var clear = OptionalBool(args, "clear") == true;
        var patch = new JsonObject();
        string? change = null;
        if (child)
        {
            if (clear && args.ContainsKey("model"))
                throw new InvalidDataException("clear=true cannot be combined with model.");
            if (clear || args.ContainsKey("model"))
                patch["childModelDefault"] = clear ? null : args["model"]?.DeepClone();
            if (args.ContainsKey("effort"))
            {
                var effort = args["effort"] is null
                    ? null
                    : SessionWait.Text(args["effort"])
                        ?? throw new InvalidDataException(
                            "effort must be a canonical effort string or null."
                        );
                effort = effort?.Trim().ToLowerInvariant();
                patch["childEffortDefault"] = effort is null or "" or "default" or "unset"
                    ? null
                    : JsonValue.Create(effort);
            }
        }
        else if (clear)
        {
            patch["compactThresholdTokens"] = null;
            change = "cleared";
        }
        else if (
            SessionWait.Number(args["thresholdTokens"]) is double threshold
            && double.IsFinite(threshold)
            && threshold > 0
        )
        {
            patch["compactThresholdTokens"] = threshold;
            change = "updated";
        }
        if (patch.Count > 0)
            await owner.Entry.SaveLane.CommitSettingsAsync(patch, models);
        var dto = owner.BuildDto();
        var result = new JsonObject { ["sessionId"] = owner.Id };
        if (!child)
        {
            if (change is not null)
                result["change"] = change;
            // A null override inherits the global default.
            result["thresholdTokens"] = dto["compactThresholdTokens"]?.DeepClone();
            result["effectiveThresholdTokens"] = dto["effectiveCompactThresholdTokens"]?.DeepClone();
            return result;
        }
        if (patch.Count > 0)
            result["change"] = clear && !args.ContainsKey("effort") ? "cleared" : "updated";
        // A null model follows the current model; a null effort is unset.
        result["model"] = dto["childModelDefault"]?.DeepClone();
        result["effectiveModel"] = dto["effectiveChildModelKey"]?.DeepClone();
        result["policySource"] = dto["childModelPolicySource"]?.DeepClone();
        // From the root ancestor to this Session; the supplying hop is marked.
        result["policyChain"] = new JsonArray(
            dto["childPolicyChain"]!
                .AsArray()
                .OfType<JsonObject>()
                .Reverse()
                .Select(hop =>
                {
                    var row = new JsonObject { ["sessionId"] = hop["sessionId"]?.DeepClone() };
                    if (hop["childModelDefault"] is { } childModel)
                        row["childModel"] = childModel.DeepClone();
                    if (hop["modelKey"] is { } model)
                        row["model"] = model.DeepClone();
                    if (hop["supplies"]?.GetValue<bool>() == true)
                        row["supplies"] = true;
                    return (JsonNode?)row;
                })
                .ToArray()
        );
        result["effort"] = dto["childEffortDefault"]?.DeepClone();
        result["effectiveEffort"] = dto["effectiveChildEffort"]?.DeepClone();
        result["allowedEfforts"] = dto["childEffortAllowed"]?.DeepClone();
        return result;
    }
}
