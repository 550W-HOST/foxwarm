using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static class HandoffConfirmation
{
    internal const string RecallPrefix =
        "Before composing this inter-agent handoff, have I recalled the applicable communication rules, the user's actual request, and the scope this recipient needs?";
    internal const string RecallPlaceholder =
        "<write the actual applicable rules, request, and recipient scope recalled for this handoff>";
    internal const string Prefix =
        "Before sending this inter-agent handoff, have I honestly checked that it is necessary, actionable, and not merely acknowledgement, duplication, or inherited-rule repetition; if I found that it should not be sent, did I omit or cancel it instead?";
    internal const string Placeholder = "<write the specific honest review for this handoff>";
    internal const string Suffix =
        "I have completed the check, found no issue, and confirm this inter-agent handoff should proceed.";
    internal const string ErrorCode = "invalid_inter_agent_handoff_confirmation";
    private const string RecallDescription =
        "Put handoffRecall before message. Start with the exact opening sentence below, then write the actual applicable communication rules, the user's actual request, and the scope this recipient needs. Replace the placeholder with this handoff's own recalled context.\n\n"
        + RecallPrefix
        + "\n"
        + RecallPlaceholder;
    private const string Description =
        "Put handoffConfirmation last in the arguments. Write an honest review of the proposed handoff using the exact opening and closing sentences below. Replace the placeholder with your own specific review. If the handoff should not proceed, omit it or cancel with __cancelTool=true instead of approving it to satisfy the check.\n\nFor a handoff that should proceed, use: "
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
        properties.Remove("handoffRecall");
        properties.Remove("handoffConfirmation");
        var original = properties.ToArray();
        properties.Clear();
        foreach (var (key, value) in original)
        {
            if (enabled && key == "message")
                properties["handoffRecall"] = new JsonObject
                {
                    ["type"] = "string",
                    ["description"] = RecallDescription,
                };
            properties[key] = value;
        }
        var required = new JsonArray(
            (parameters["required"] as JsonArray ?? [])
                .Where(value =>
                    SessionWait.Text(value)
                        is not ("confirmation" or "handoffRecall" or "handoffConfirmation")
                )
                .Select(value => value?.DeepClone())
                .ToArray()
        );
        if (enabled)
        {
            copy["description"] =
                SessionWait.Text(copy["description"])
                + " A structured handoff recall and confirmation are required."
                + (
                    name == "create_child_session"
                        ? " This applies even when creating a child without an initial message."
                        : ""
                );
            properties["handoffConfirmation"] = new JsonObject
            {
                ["type"] = "string",
                ["description"] = Description,
            };
            required.Add("handoffRecall");
            required.Add("handoffConfirmation");
        }
        if (required.Count > 0)
            parameters["required"] = required;
        else
            parameters.Remove("required");
        return copy;
    }

    internal static void Validate(JsonObject args)
    {
        var recall = SessionWait.Text(args["handoffRecall"]);
        if (recall is null || !recall.StartsWith(RecallPrefix, StringComparison.Ordinal))
            throw new InvalidDataException(
                "Inter-agent handoff recall must start with the exact required opening sentence and include the applicable recalled context."
            );
        var recalled = SessionGoal.Trim(recall[RecallPrefix.Length..]);
        if (recalled.Length == 0 || recalled == RecallPlaceholder)
            throw new InvalidDataException(
                "Inter-agent handoff recall must include the caller's actual recalled context instead of the documented placeholder."
            );
        var text = SessionWait.Text(args["handoffConfirmation"]);
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
        if (args.LastOrDefault().Key != "handoffConfirmation")
            throw new InvalidDataException(
                "Inter-agent handoff confirmation must be the final argument property."
            );
        var keys = args.Select(pair => pair.Key).ToArray();
        var message = Array.IndexOf(keys, "message");
        var recallIndex = Array.IndexOf(keys, "handoffRecall");
        if (message >= 0 && (recallIndex < 0 || recallIndex > message))
            throw new InvalidDataException(
                "Inter-agent handoff recall must be before the message argument."
            );
    }

    internal static void Validate(string name, JsonObject args, bool enabled)
    {
        if (enabled && Handoff(name))
            Validate(args);
    }

    internal static string GuidanceArgument(string parentSessionId) =>
        $"handoffRecall: \"{RecallPrefix}\\n{RecallPlaceholder}\", sessionId: `{parentSessionId}`, message: \"...\", afterSend: \"finish\", handoffConfirmation: \"{Prefix}\\n{Placeholder}\\n{Suffix}\"";

    internal const string Guidance =
        " The recall must be before message and both review fields must use this handoff's own content; handoffConfirmation must be the final argument property. If the handoff should not be sent, omit it or cancel it instead of adding approval text.";
}
