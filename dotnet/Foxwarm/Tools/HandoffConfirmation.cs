using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static class HandoffConfirmation
{
    internal const string RecallPlaceholder =
        "<briefly consider what to say and which existing rules apply>";
    internal const string Placeholder =
        "<briefly and honestly check whether this handoff should proceed>";
    internal const string Suffix = "I confirm this handoff should proceed.";
    internal const string ErrorCode = "invalid_inter_agent_handoff_confirmation";
    internal const string RecallDescription =
        "Put this before message. Briefly consider what to say and which existing rules apply.";
    internal const string Description =
        "Put this last. Briefly and honestly check whether this handoff should proceed. Only if it should, end with the exact sentence: “I confirm this handoff should proceed.” Otherwise omit or cancel the call.";

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
        var recalled = SessionGoal.Trim(recall ?? "");
        if (recalled.Length == 0 || recalled == RecallPlaceholder)
            throw new InvalidDataException(
                "Inter-agent handoff recall must include the caller's recalled context instead of an empty value or the documented placeholder."
            );
        var text = SessionWait.Text(args["handoffConfirmation"]);
        if (
            text is null
            || !text.EndsWith(Suffix, StringComparison.Ordinal)
        )
            throw new InvalidDataException(
                "Inter-agent handoff confirmation must end with the exact sentence: “I confirm this handoff should proceed.”"
            );
        var review = SessionGoal.Trim(text[..^Suffix.Length]);
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
        $"handoffRecall: \"{RecallPlaceholder}\", sessionId: `{parentSessionId}`, message: \"...\", afterSend: \"finish\", handoffConfirmation: \"{Placeholder}\\n{Suffix}\"";

    internal const string Guidance =
        " Keep handoffRecall before message and handoffConfirmation last. Briefly recall the relevant rules and what to say, then honestly check the handoff. End the confirmation with “I confirm this handoff should proceed.” only if it should proceed; otherwise omit or cancel the call.";
}
