using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static class HandoffConfirmation
{
    internal const string Prefix =
        "Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?";
    internal const string Placeholder =
        "<replace this with your own non-empty review; do not copy this placeholder verbatim>";
    internal const string Suffix =
        "I have completed the check, found no issue, and confirm this inter-agent handoff should proceed.";
    internal const string ErrorCode = "invalid_inter_agent_handoff_confirmation";
    private const string Description =
        "Put confirmation last in the arguments. Write an honest review of the proposed handoff using the exact opening and closing sentences below. Replace the middle placeholder with your own review. Check whether the recipient needs this handoff to perform work, make a decision, or change its current actions; if it would only acknowledge the message, omit it or combine it with the next actionable handoff. If the handoff should not proceed, cancel with __cancelTool=true instead of approving it to satisfy the check.\n\nFor a handoff that should proceed, use: "
        + Prefix
        + "\n"
        + Placeholder
        + "\n"
        + Suffix;

    internal static bool Enabled(JsonObject app)
    {
        if (!app.ContainsKey("handoffConfirmation"))
            return false;
        return
            app["handoffConfirmation"] is JsonValue value
            && value.TryGetValue<bool>(out var enabled)
            ? enabled
            : throw new InvalidDataException("app config `handoffConfirmation` must be a boolean.");
    }

    internal static bool Handoff(string? name) =>
        name is "send_to_session" or "create_child_session";

    internal static JsonObject Definition(JsonObject definition, bool enabled)
    {
        var copy = (JsonObject)definition.DeepClone();
        var name = SessionWait.Text(copy["name"]);
        if (!Handoff(name))
            return copy;
        var parameters = copy["parameters"]!.AsObject();
        var properties = parameters["properties"]!.AsObject();
        properties.Remove("confirmation");
        var required = new JsonArray(
            (parameters["required"] as JsonArray ?? [])
                .Where(value => SessionWait.Text(value) != "confirmation")
                .Select(value => value?.DeepClone())
                .ToArray()
        );
        if (enabled)
        {
            copy["description"] =
                SessionWait.Text(copy["description"])
                + (
                    name == "create_child_session"
                        ? " A confirmation review is required, even when creating a child without an initial message."
                        : " A confirmation review is required."
                );
            properties["confirmation"] = new JsonObject
            {
                ["type"] = "string",
                ["description"] = Description,
            };
            required.Add("confirmation");
        }
        if (required.Count > 0)
            parameters["required"] = required;
        else
            parameters.Remove("required");
        return copy;
    }

    internal static void Validate(JsonObject args)
    {
        var text = SessionWait.Text(args["confirmation"]);
        if (
            text is null
            || !text.StartsWith(Prefix, StringComparison.Ordinal)
            || !text.EndsWith(Suffix, StringComparison.Ordinal)
        )
            throw new InvalidDataException(
                "Inter-agent handoff confirmation must contain the exact required prefix and suffix separated by a non-empty review."
            );
        var review = SessionGoal.Trim(text[Prefix.Length..^Suffix.Length]);
        if (review.Length == 0)
            throw new InvalidDataException(
                "Inter-agent handoff confirmation review must be non-empty."
            );
        if (review == Placeholder)
            throw new InvalidDataException(
                "Inter-agent handoff confirmation review must replace the documented placeholder with the caller's own review."
            );
        if (args.LastOrDefault().Key != "confirmation")
            throw new InvalidDataException(
                "Inter-agent handoff confirmation must be the final argument property."
            );
    }

    internal static void Validate(string name, JsonObject args, bool enabled)
    {
        if (enabled && Handoff(name))
            Validate(args);
    }

    internal static string GuidanceArgument =>
        $", confirmation: \"{Prefix}\\n{Placeholder}\\n{Suffix}\"";
    internal const string Guidance =
        " The confirmation must be the final argument property, and you must replace the placeholder with your own review rather than copying it.";
}
