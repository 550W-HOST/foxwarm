using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static class ToolCallControls
{
    private static readonly string[] Names = ["__cancelTool", "__cancelAllToolsThisTurn"];

    // The controls are accepted on every call but deliberately not declared: the framework prompt
    // describes them once instead of repeating them in each of the tool schemas.
    internal static JsonObject ForModel(JsonObject definition)
    {
        var copy = (JsonObject)definition.DeepClone();
        copy.Remove("defaultInject");
        return copy;
    }

    internal static IReadOnlyList<(JsonObject Call, JsonObject? Preset)> Plan(
        IReadOnlyList<JsonObject> calls,
        bool handoffConfirmation = false
    )
    {
        var all = calls.Any(call =>
            !call.ContainsKey("argsParseError") && True(call["args"]?[Names[1]])
        );
        return calls
            .Select(call =>
            {
                var copy = (JsonObject)call.DeepClone();
                var original = call["args"] as JsonObject;
                if (copy["args"] is JsonObject args)
                    foreach (var key in Names)
                        args.Remove(key);
                JsonObject? preset = null;
                if (all)
                    preset = Cancelled();
                else if (!call.ContainsKey("argsParseError"))
                {
                    var invalid = Names.FirstOrDefault(key =>
                        original?.ContainsKey(key) == true && !True(original[key])
                    );
                    if (invalid is not null)
                        preset = UnsupportedTurnToolExecutor.ToolError(
                            "invalid_tool_control_argument",
                            invalid + " accepts only the boolean value true when provided."
                        );
                    else if (True(original?[Names[0]]))
                        preset = Cancelled();
                    else if (
                        handoffConfirmation
                        && HandoffConfirmation.Handoff(SessionWait.Text(copy["name"]))
                    )
                    {
                        var handoffArgs = copy["args"] as JsonObject ?? new JsonObject();
                        try
                        {
                            HandoffConfirmation.RejectRenamedTurnAction(
                                SessionWait.Text(copy["name"]),
                                handoffArgs
                            );
                        }
                        catch (InvalidDataException error)
                        {
                            // Same rejection the handler gives when the checkpoint is off.
                            preset = UnsupportedTurnToolExecutor.ToolError(
                                "agent_tool_error",
                                error.Message
                            );
                        }
                        if (preset is null)
                            try
                            {
                                HandoffConfirmation.Validate(handoffArgs);
                            }
                            catch (InvalidDataException error)
                            {
                                preset = UnsupportedTurnToolExecutor.ToolError(
                                    HandoffConfirmation.ErrorCode,
                                    error.Message
                                );
                            }
                    }
                }
                return (Call: copy, Preset: preset);
            })
            .ToArray();
    }

    private static bool True(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    private static JsonObject Cancelled() =>
        new() { ["canceled"] = true, ["message"] = "Tool call canceled before execution." };
}
