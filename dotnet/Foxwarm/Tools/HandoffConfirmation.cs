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
        "Put this last; only currentSessionTurnAction may follow it. Briefly and honestly check whether this handoff should proceed. Only if it should, end with the exact sentence: “I confirm this handoff should proceed.” Otherwise omit or cancel the call.";

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

    // Old calls put afterSend after handoffConfirmation, as the former order required. Reject
    // them with the rename before any ordering check would point at the wrong problem.
    internal static void RejectRenamedTurnAction(string? name, JsonObject args)
    {
        if (Handoff(name) && args.ContainsKey("afterSend"))
            throw new InvalidDataException(
                "afterSend was renamed to currentSessionTurnAction. Use continue, end_turn (formerly finish), or wait."
            );
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
        var required = (parameters["required"] as JsonArray ?? [])
            .Select(SessionWait.Text)
            .OfType<string>()
            .Where(value =>
                value is not ("confirmation" or "handoffRecall" or "handoffConfirmation")
            )
            .ToList();
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
        // Keep required names in property order so both schema signals describe the same argument order.
        var ordered = properties
            .Select(pair => pair.Key)
            .Where(required.Contains)
            .Concat(required.Where(value => !properties.ContainsKey(value)))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (ordered.Length > 0)
            parameters["required"] = new JsonArray(
                ordered.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            );
        else
            parameters.Remove("required");
        return copy;
    }

    // currentSessionTurnAction only selects the caller's own turn after delivery, so it may follow the review.
    private const string TrailingControl = "currentSessionTurnAction";

    internal static void Validate(JsonObject args)
    {
        var problems = new List<string>();
        var recall = SessionWait.Text(args["handoffRecall"]);
        var recalled = SessionGoal.Trim(recall ?? "");
        if (recalled.Length == 0 || recalled == RecallPlaceholder)
            problems.Add(
                "Inter-agent handoff recall must include the caller's recalled context instead of an empty value or the documented placeholder."
            );
        var text = SessionWait.Text(args["handoffConfirmation"]);
        if (text is null || !text.EndsWith(Suffix, StringComparison.Ordinal))
            problems.Add(
                "Inter-agent handoff confirmation must end with the exact sentence: “I confirm this handoff should proceed.”"
            );
        else
        {
            var review = SessionGoal.Trim(text[..^Suffix.Length]);
            if (review.Length == 0)
                problems.Add("Inter-agent handoff confirmation review must be non-empty.");
            else if (review == Placeholder)
                problems.Add(
                    "Inter-agent handoff confirmation review must replace the documented placeholder with the caller's own review."
                );
        }
        var keys = args.Select(pair => pair.Key).ToArray();
        var ordering = false;
        var confirmation = Array.IndexOf(keys, "handoffConfirmation");
        if (confirmation >= 0 && keys.Skip(confirmation + 1).Any(key => key != TrailingControl))
        {
            ordering = true;
            problems.Add(
                "Inter-agent handoff confirmation must follow every argument except currentSessionTurnAction."
            );
        }
        var message = Array.IndexOf(keys, "message");
        var recallIndex = Array.IndexOf(keys, "handoffRecall");
        if (message >= 0 && recallIndex > message)
        {
            ordering = true;
            problems.Add("Inter-agent handoff recall must be before the message argument.");
        }
        if (problems.Count == 0)
            return;
        if (ordering)
            problems.Add(
                $"Received argument order: {string.Join(", ", keys)}. Resend in this order: {string.Join(", ", ExpectedOrder(keys))}."
            );
        throw new InvalidDataException(string.Join(" ", problems));
    }

    private static string[] ExpectedOrder(IReadOnlyList<string> keys)
    {
        var order = keys.Where(key =>
                key is not ("handoffRecall" or "handoffConfirmation" or TrailingControl)
            )
            .ToList();
        var message = order.IndexOf("message");
        order.Insert(message >= 0 ? message : order.Count, "handoffRecall");
        if (keys.Contains(TrailingControl))
            order.Add(TrailingControl);
        order.Add("handoffConfirmation");
        return [.. order];
    }

    internal static void Validate(string name, JsonObject args, bool enabled)
    {
        if (enabled && Handoff(name))
            Validate(args);
    }

    internal static string GuidanceArgument(
        string parentSessionId,
        string turnAction = "end_turn"
    ) =>
        $"handoffRecall: \"{RecallPlaceholder}\", sessionId: `{parentSessionId}`, message: \"...\", currentSessionTurnAction: \"{turnAction}\", handoffConfirmation: \"{Placeholder}\\n{Suffix}\"";

    internal const string Guidance =
        " Keep handoffRecall before message and handoffConfirmation last. Briefly recall the relevant rules and what to say, then honestly check the handoff. End the confirmation with “I confirm this handoff should proceed.” only if it should proceed; otherwise omit or cancel the call.";
}
