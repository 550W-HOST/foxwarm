using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<(JsonObject Response, bool Finish)> ExecuteAgentToolAsync(
        SessionOwner source, string name, JsonObject? args)
    {
        try
        {
            if (args is null) throw new InvalidDataException("Tool arguments must be an object.");
            switch (name)
            {
                case "create_agent":
                    {
                        Keys(args, ["agentName", "createMainSession"], ["agentName"]);
                        var nameValue = RequiredString(args, "agentName");
                        var createMain = OptionalBool(args, "createMainSession") ?? true;
                        var created = await CreateAgentAsync(nameValue, createMain);
                        return (Output(created.MainSessionId is null
                            ? $"Created Agent {created.AgentName} without a main Session."
                            : $"Created Agent {created.AgentName} with main Session {created.MainSessionId}."), false);
                    }
                case "create_session":
                    {
                        Keys(args, ["agentName", "sessionName", "displayName", "forceModel"], ["agentName", "sessionName"]);
                        var forceModel = OptionalForceModel(args);
                        var created = await CreateNamedAsync(RequiredString(args, "agentName"),
                            RequiredString(args, "sessionName"), OptionalString(args, "displayName"), forceModel);
                        return (Output($"Created Session {created.Id} under Agent {created.Agent}."), false);
                    }
                case "create_child_session":
                    {
                        Keys(args, ["agentName", "suffix", "displayName", "message", "afterSend", "forceModel"], ["suffix"]);
                        var forceModel = OptionalForceModel(args);
                        var after = AfterSend(args);
                        var (child, delivered) = await CreateChildAsync(source, RequiredString(args, "suffix"),
                            OptionalString(args, "agentName"), OptionalString(args, "displayName"),
                            OptionalString(args, "message"), forceModel);
                        return (Output($"Created fresh child Session {child.Id} under Agent {child.Agent}; "
                            + (delivered ? "initial message delivered to its queue." : "no initial message was supplied.")), after == "finish");
                    }
                case "send_to_session":
                    {
                        Keys(args, ["sessionId", "message", "afterSend"], ["sessionId", "message"]);
                        var after = AfterSend(args);
                        var requested = RequiredString(args, "sessionId");
                        var target = await SendAsync(source, requested, RequiredString(args, "message"));
                        return (Output($"Delivered a message from {source.Id} to Session {target} (requested {requested})."), after == "finish");
                    }
                case "refresh_session_snapshot":
                    {
                        Keys(args, [], []);
                        var model = await RefreshSnapshotAsync(source);
                        return (Output($"Refreshed Session {source.Id} prompt snapshot for concrete model {model}."), false);
                    }
                default: throw new InvalidDataException("Unsupported Agent tool.");
            }
        }
        catch (CommittedSessionCreationException error)
        {
            var response = UnsupportedTurnToolExecutor.ToolError("partial_create", error.Message);
            var detail = response["error"] as JsonObject;
            if (error.SessionId is not null) detail!["sessionId"] = error.SessionId;
            if (error.InitialDeliveryCommitted is not null) detail!["initialDeliveryCommitted"] = error.InitialDeliveryCommitted;
            return (response, false);
        }
        catch (Exception error) when (error is InvalidDataException or IOException or InvalidOperationException
                                     or System.Text.Json.JsonException or ArgumentException)
        {
            return (UnsupportedTurnToolExecutor.ToolError("agent_tool_error", error.Message), false);
        }
    }

    private static JsonObject Output(string value) => new() { ["output"] = value };

    private static void Keys(JsonObject args, string[] allowed, string[] required)
    {
        if (args.Any(item => !allowed.Contains(item.Key, StringComparer.Ordinal))
            || required.Any(key => !args.ContainsKey(key)))
            throw new InvalidDataException("Tool arguments contain unsupported or missing fields.");
    }

    private static string RequiredString(JsonObject args, string key) =>
        args[key] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text : throw new InvalidDataException($"{key} must be a string.");
    private static string? OptionalString(JsonObject args, string key) =>
        args.ContainsKey(key) ? RequiredString(args, key) : null;
    private static bool? OptionalBool(JsonObject args, string key) =>
        !args.ContainsKey(key) ? null : args[key] is JsonValue value && value.TryGetValue<bool>(out var result)
            ? result : throw new InvalidDataException($"{key} must be a boolean.");
    private static string AfterSend(JsonObject args)
    {
        var value = OptionalString(args, "afterSend") ?? "continue";
        if (value is not ("continue" or "finish")) throw new InvalidDataException("afterSend must be continue or finish.");
        return value;
    }

    private static JsonObject? OptionalForceModel(JsonObject args)
    {
        if (!args.ContainsKey("forceModel")) return null;
        if (args["forceModel"] is not JsonObject force)
            throw new InvalidDataException("forceModel must be an object.");
        Keys(force, ["modelId", "effort"], []);
        if (force.ContainsKey("modelId")) _ = RequiredString(force, "modelId");
        if (force.ContainsKey("effort"))
        {
            var effort = RequiredString(force, "effort");
            if (effort is not ("none" or "low" or "medium" or "high" or "xhigh" or "max"))
                throw new InvalidDataException("Unsupported effort override.");
        }
        return force;
    }
}
