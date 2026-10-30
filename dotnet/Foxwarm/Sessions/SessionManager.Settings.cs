using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
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
        if (!child) ClaudeRuntimeState.RequireFoxwarm(owner, "Foxwarm context settings");
        var clear = OptionalBool(args, "clear") == true;
        var patch = new JsonObject();
        var action = "status";
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
            action = "cleared";
        }
        else if (
            SessionWait.Number(args["thresholdTokens"]) is double threshold
            && double.IsFinite(threshold)
            && threshold > 0
        )
        {
            patch["compactThresholdTokens"] = threshold;
            action = "updated";
        }
        if (patch.Count > 0)
            await owner.Entry.SaveLane.CommitSettingsAsync(patch, models);
        var dto = owner.BuildDto();
        if (!child)
        {
            var raw = dto["compactThresholdTokens"];
            return Output(
                $"Session `{id}` compact threshold {action}.\noverride: {(raw is null ? "inherit global default" : raw + " tokens")}\neffective: {dto["effectiveCompactThresholdTokens"]} tokens"
            );
        }
        var prefix =
            patch.Count == 0 ? ""
            : clear && !args.ContainsKey("effort") ? "Child default model cleared.\n"
            : "Child model/effort defaults updated.\n";
        var chain = string.Join(
            " → ",
            dto["childPolicyChain"]!
                .AsArray()
                .OfType<JsonObject>()
                .Reverse()
                .Select(hop =>
                    (hop["supplies"]?.GetValue<bool>() == true ? "*" : "")
                    + (
                        SessionWait.Text(hop["childModelDefault"])
                        ?? SessionWait.Text(hop["modelKey"])
                        ?? "follow"
                    )
                )
        );
        return Output(
            prefix
                + $"Session `{id}` child model/effort defaults:\nmodel override: {SessionWait.Text(dto["childModelDefault"]) ?? "follow current model"}\npolicy source: {dto["childModelPolicySource"]}\neffective model: `{dto["effectiveChildModelKey"]}`\npolicy chain: {chain}\neffort override: {SessionWait.Text(dto["childEffortDefault"]) ?? "unset"}\neffective effort: {dto["effectiveChildEffort"]}\nallowed: {string.Join(", ", dto["childEffortAllowed"]!.AsArray().Select(value => value!.GetValue<string>()))}"
        );
    }
}
