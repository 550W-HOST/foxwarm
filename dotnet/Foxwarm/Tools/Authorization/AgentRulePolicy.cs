using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class AgentRulePolicy
{
    internal static ToolAuthorizationPolicy Parse(JsonNode? value)
    {
        if (value is not JsonArray rules)
            throw new InvalidDataException("Agent rules must be an array.");
        foreach (var rule in rules)
        {
            if (rule is not JsonObject row)
                throw new InvalidDataException("Agent rule must be an object.");
            foreach (var key in new[] { "agent", "session", "sessionPattern", "externalId" })
                if (
                    row.ContainsKey(key)
                    || row["match"] is JsonObject match && match.ContainsKey(key)
                )
                    throw new InvalidDataException("Agent rules do not accept caller selectors.");
        }
        return ToolAuthorizationPolicy.Normalize(
            new JsonObject
            {
                ["version"] = 1,
                ["defaultAction"] = "allow",
                ["rules"] = rules.DeepClone(),
            }
        );
    }
}
