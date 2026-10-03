using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class SessionModelSettings
{
    internal static readonly string[] Fields = ["model", "effort", "childModelDefault", "childEffortDefault"];
    internal static readonly string[] Efforts = ["none", "low", "medium", "high", "xhigh", "max"];
    internal static JsonObject Normalize(JsonObject current, JsonObject patch, HostModels models)
    {
        models = models.Capture();
        var result = new JsonObject();
        void Pair(string modelField, string effortField, string? fallback)
        {
            var raw = patch.ContainsKey(modelField) ? patch[modelField] : current[modelField];
            var model = SessionWait.Text(raw);
            if (patch.ContainsKey(modelField) && raw is not null && model is null) throw new InvalidDataException(modelField + " must be a model key or null.");
            model = model?.Trim(); if (model?.Length == 0) model = null;
            if (patch.ContainsKey(modelField) && model is not null && !models.Contains(model)) throw new InvalidDataException("Unknown or unsupported model key.");
            var selected = models.Resolve(model ?? fallback);
            var effortNode = patch.ContainsKey(effortField) ? patch[effortField] : current[effortField];
            var effort = SessionWait.Text(effortNode);
            if (effortNode is not null && (effort is null || effort.Length > 0 && !Efforts.Contains(effort))) throw new InvalidDataException(effortField + " must be a canonical effort string or null.");
            if (effort?.Length == 0) effort = null;
            if (effort is not null && !selected.AllowedEfforts.Contains(effort))
            {
                if (patch.ContainsKey(effortField)) throw new InvalidDataException($"{effortField} `{effort}` is not allowed by model `{selected.Key}`.");
                effort = null;
            }
            result[modelField] = model; result[effortField] = effort;
        }
        Pair("model", "effort", null); Pair("childModelDefault", "childEffortDefault", SessionWait.Text(result["model"]));
        return result;
    }
    internal static double EffectiveThreshold(JsonObject envelope, HostModels models)
    {
        var raw = SessionWait.Number(envelope["compactThresholdTokens"]);
        models = models.Capture();
        return raw is > 0 && double.IsFinite(raw.Value) ? Math.Floor(raw.Value) : Math.Max(1, Math.Floor((models.All.Count == 0 ? models.PresentationContextLimit : models.Resolve(SessionWait.Text(envelope["model"])).ContextLimit) * models.CompactThresholdFraction));
    }
    internal static JsonObject Presentation(JsonObject envelope, HostModels models, string id)
    {
        models = models.Capture();
        var model = SessionWait.Text(envelope["childModelDefault"]); var effort = SessionWait.Text(envelope["childEffortDefault"]);
        var leaf = models.All.Count == 0 ? null : models.Resolve(model ?? SessionWait.Text(envelope["model"]));
        var allowed = leaf?.AllowedEfforts ?? HostModels.Efforts; var defaultEffort = leaf is null ? "high" : leaf.DefaultEffort;
        var inherited = effort ?? SessionWait.Text(envelope["effort"]);
        var effective = inherited is not null && allowed.Contains(inherited) ? inherited : defaultEffort;
        return new JsonObject
        {
            ["childModelDefault"] = model,
            ["childModelPolicySource"] = model is null ? "follow-parent" : "explicit",
            ["effectiveChildModelKey"] = leaf?.Key ?? models.DefaultKey,
            ["childEffortDefault"] = effort,
            ["effectiveChildEffort"] = effective,
            ["childEffortAllowed"] = new JsonArray(allowed.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
            ["childModelEffortDefault"] = defaultEffort,
            ["compactThresholdTokens"] = envelope["compactThresholdTokens"]?.DeepClone(),
            ["effectiveCompactThresholdTokens"] = EffectiveThreshold(envelope, models),
            ["childPolicyChain"] = new JsonArray(new JsonObject
            {
                ["level"] = "session",
                ["sessionId"] = id,
                ["modelKey"] = envelope["model"]?.DeepClone(),
                ["effort"] = envelope["effort"]?.DeepClone(),
                ["childModelDefault"] = model,
                ["childEffortDefault"] = effort,
                ["source"] = model is null ? "follow-parent" : "explicit",
                ["supplies"] = true
            })
        };
    }
}
