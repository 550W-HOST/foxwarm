using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class AgentRulePolicy
{
    internal static bool IsScriptLayer(JsonNode? value) => value is JsonObject;

    internal static bool HasLocalLayer(JsonNode? value) =>
        value is JsonArray { Count: > 0 } or JsonObject;

    internal static ToolAuthorizationPolicy Parse(JsonNode? value)
    {
        var (rules, fromScript) = Expand(value);
        return NormalizeAgentRules(rules, fromScript);
    }

    internal static async Task<ToolAuthorizationPolicy> ParseAsync(
        JsonNode? value,
        CancellationToken cancellationToken = default
    )
    {
        var (rules, fromScript) = await ExpandAsync(value, cancellationToken).ConfigureAwait(false);
        return NormalizeAgentRules(rules, fromScript);
    }

    private static (JsonArray Rules, bool FromScript) Expand(JsonNode? value)
    {
        if (value is JsonArray array)
            return ((JsonArray)array.DeepClone(), false);
        var (script, data) = ValidateScriptObject(value);
        return (PolicyScriptRunner.EvaluateRules(script, data, "agent-rules"), true);
    }

    private static async Task<(JsonArray Rules, bool FromScript)> ExpandAsync(
        JsonNode? value,
        CancellationToken cancellationToken
    )
    {
        if (value is JsonArray array)
            return ((JsonArray)array.DeepClone(), false);
        var (script, data) = ValidateScriptObject(value);
        var evaluated = await PolicyScriptRunner
            .EvaluateRulesAsync(script, data, "agent-rules", cancellationToken)
            .ConfigureAwait(false);
        return (evaluated, true);
    }

    private static (string Script, JsonNode? Data) ValidateScriptObject(JsonNode? value)
    {
        if (value is not JsonObject obj)
            throw new InvalidDataException(
                "Agent rules must be an array or a { script, data? } object."
            );
        foreach (var pair in obj)
            if (pair.Key is not ("script" or "data"))
                throw new InvalidDataException(
                    $"Unknown Agent rules field `{pair.Key}`; only `script` and `data` are accepted."
                );
        if (
            !obj.ContainsKey("script")
            || obj["script"] is not JsonValue scriptValue
            || !scriptValue.TryGetValue<string>(out var script)
            || string.IsNullOrWhiteSpace(script)
        )
            throw new InvalidDataException("Agent rules `script` must be a non-empty string.");
        var data = obj.ContainsKey("data") ? obj["data"] : null;
        PolicyScriptRunner.ValidateStaticData(data);
        return (script, data);
    }

    private static ToolAuthorizationPolicy NormalizeAgentRules(JsonArray rules, bool fromScript)
    {
        for (var i = 0; i < rules.Count; i++)
        {
            if (rules[i] is not JsonObject row)
                throw new InvalidDataException(
                    fromScript
                        ? $"Policy script output rule[{i}]: Agent rule must be an object."
                        : "Agent rule must be an object."
                );
            foreach (var key in new[] { "agent", "session", "sessionPattern", "externalId" })
                if (
                    row.ContainsKey(key)
                    || row["match"] is JsonObject match && match.ContainsKey(key)
                )
                {
                    if (!fromScript)
                        throw new InvalidDataException(
                            "Agent rules do not accept caller selectors."
                        );
                    var id =
                        row["id"] is JsonValue idValue
                        && idValue.TryGetValue<string>(out var text)
                        && !string.IsNullOrWhiteSpace(text)
                            ? $" (id '{text.Trim()}')"
                            : "";
                    throw new InvalidDataException(
                        $"Policy script output rule[{i}]{id}: Agent rules do not accept caller selectors."
                    );
                }
        }
        return ToolAuthorizationPolicy.Normalize(
            new JsonObject
            {
                ["version"] = 1,
                ["defaultAction"] = "allow",
                ["rules"] = rules,
            },
            fromScript
        );
    }
}
