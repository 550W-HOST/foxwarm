using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<(JsonObject Response, bool Finish)> ExecuteAgentToolAsync(
        SessionOwner source,
        string name,
        JsonObject? args,
        CancellationToken cancellationToken = default,
        Action<string, string>? sessionMessageDelivered = null,
        string? toolScriptRunId = null
    )
    {
        var previous = semanticCaller.Value;
        semanticCaller.Value = cancellationToken;
        try
        {
            return await ExecuteAgentToolCoreAsync(
                source,
                name,
                args,
                sessionMessageDelivered,
                toolScriptRunId
            );
        }
        finally
        {
            semanticCaller.Value = previous;
        }
    }

    private async Task<(JsonObject Response, bool Finish)> ExecuteAgentToolCoreAsync(
        SessionOwner source,
        string name,
        JsonObject? args,
        Action<string, string>? sessionMessageDelivered,
        string? toolScriptRunId
    )
    {
        try
        {
            if (args is null)
                throw new InvalidDataException("Tool arguments must be an object.");
            if (name == "delete_session" && AgentIsolated(source.Agent))
                throw new SessionDeletionException(
                    "Isolated session cannot use delete_session tool.",
                    "SESSION_DELETE_ISOLATED",
                    403
                );
            await AuthorizeToolAsync(
                source,
                new(name, "builtin", name, args),
                null,
                semanticCaller.Value ?? CancellationToken.None
            );
            HandoffConfirmation.Validate(name, args, HandoffConfirmationEnabled);
            switch (name)
            {
                case "move_session":
                    return (
                        await MoveIdentityAsync(source, args, semanticCaller.Value ?? default),
                        false
                    );
                case "delete_session":
                {
                    Keys(args, ["sessionId"], ["sessionId"]);
                    if (!IsCurrentOwner(source))
                        throw new SessionDeletionException(
                            "Cannot delete a session without current session context.",
                            "SESSION_DELETE_SOURCE_NOT_FOUND",
                            404
                        );
                    if (
                        agents.MetadataSnapshot()[source.Agent] is JsonObject metadata
                        && SessionCatalog.Flag(metadata["isolated"])
                    )
                        throw new SessionDeletionException(
                            "Isolated session cannot use delete_session tool.",
                            "SESSION_DELETE_ISOLATED",
                            403
                        );
                    var result = await DeleteAsync(
                        RequiredString(args, "sessionId"),
                        source: source
                    );
                    return (
                        Output(DeleteToolText(RequiredString(args, "sessionId"), result)),
                        false
                    );
                }
                case "set_agent_isolated":
                {
                    Keys(args, ["agentName", "nodeId", "toolRules"], ["agentName"]);
                    var agent = RequiredString(args, "agentName");
                    var node = OptionalString(args, "nodeId")?.Trim();
                    if (node == "")
                        node = null;
                    if (args.ContainsKey("toolRules") && args["toolRules"] is not JsonArray)
                        throw new InvalidDataException("toolRules must be an array.");
                    await SetAgentIsolationAsync(
                        agent,
                        node,
                        args.ContainsKey("nodeId"),
                        args["toolRules"] as JsonArray
                    );
                    var isolation = agents.MetadataSnapshot()[agent] as JsonObject;
                    return (
                        new JsonObject
                        {
                            ["success"] = true,
                            ["isolated"] = AgentIsolated(agent),
                            ["node"] = RecordedIsolationNode(agent),
                            ["toolRuleCount"] = (isolation?["toolRules"] as JsonArray)?.Count ?? 0,
                        },
                        false
                    );
                }
                case "create_agent":
                {
                    Keys(args, ["agentName", "createMainSession", "inherit"], ["agentName"]);
                    var nameValue = RequiredString(args, "agentName");
                    var createMain = OptionalBool(args, "createMainSession") ?? true;
                    var created = await CreateAgentAsync(
                        nameValue,
                        createMain,
                        inherit: OptionalString(args, "inherit")
                    );
                    return (
                        Output(
                            created.MainSessionId is null
                                ? $"Created Agent {created.AgentName} without a main Session."
                                : $"Created Agent {created.AgentName} with main Session {created.MainSessionId}."
                        ),
                        false
                    );
                }
                case "set_session_child_model":
                case "set_session_compact_threshold":
                    return (await SessionSettingsAsync(source, name, args), false);
                case "compact_session":
                    return (await CompactSessionAsync(source, args), false);
                case "session":
                case "get_session_messages":
                    return (await ObserveAsync(source, name, args), false);
                case "skill":
                    return (await SkillAsync(source, args), false);
                case "set_agent_inherit":
                {
                    Keys(
                        args,
                        ["agentName", "inheritAgentName", "refreshSnapshots"],
                        ["agentName"]
                    );
                    var agent = RequiredString(args, "agentName");
                    var result = await SetAgentInheritAsync(
                        agent,
                        OptionalString(args, "inheritAgentName"),
                        OptionalBool(args, "refreshSnapshots") ?? false
                    );
                    return (Output(System.Text.Json.JsonSerializer.Serialize(result)), false);
                }
                case "create_session":
                {
                    Keys(
                        args,
                        ["agentName", "sessionName", "displayName", "forceModel"],
                        ["agentName", "sessionName"]
                    );
                    var forceModel = OptionalForceModel(args);
                    var created = await CreateNamedAsync(
                        RequiredString(args, "agentName"),
                        RequiredString(args, "sessionName"),
                        OptionalString(args, "displayName"),
                        forceModel,
                        initialNode: CurrentNode(source)
                    );
                    return (
                        Output($"Created Session {created.Id} under Agent {created.Agent}."),
                        false
                    );
                }
                case "create_child_session":
                {
                    Keys(
                        args,
                        [
                            "agentName",
                            "suffix",
                            "displayName",
                            "handoffRecall",
                            "message",
                            "afterSend",
                            "forceModel",
                            "fork",
                            "taskId",
                            "handoffConfirmation",
                        ],
                        ["suffix"]
                    );
                    var forceModel = OptionalForceModel(args);
                    var after = AfterSend(args);
                    var taskId = OptionalString(args, "taskId");
                    if (
                        after == "wait"
                        && taskId is null
                        && string.IsNullOrWhiteSpace(OptionalString(args, "message"))
                    )
                        throw new InvalidDataException(
                            "create_child_session with afterSend=wait requires a nonempty initial message."
                        );
                    var initialMessage = OptionalString(args, "message");
                    SessionOwner child;
                    var delivered = false;
                    var sentNotifications = 0;
                    string? assignmentWarning = null;
                    if (taskId is null)
                    {
                        var created = await CreateChildAsync(
                            source,
                            RequiredString(args, "suffix"),
                            OptionalString(args, "agentName"),
                            OptionalString(args, "displayName"),
                            initialMessage,
                            forceModel,
                            OptionalBool(args, "fork") ?? false,
                            taskId
                        );
                        child = created.Child;
                        delivered = created.Delivered;
                        sentNotifications = delivered ? 1 : 0;
                    }
                    else
                    {
                        var attached = await Tasks.CreateAttachedChildAsync(
                            taskId,
                            source.Id,
                            async () =>
                                (
                                    await CreateChildAsync(
                                        source,
                                        RequiredString(args, "suffix"),
                                        OptionalString(args, "agentName"),
                                        OptionalString(args, "displayName"),
                                        null,
                                        forceModel,
                                        OptionalBool(args, "fork") ?? false,
                                        taskId
                                    )
                                ).Child,
                            initialMessage
                        );
                        child = attached.Child;
                        delivered = attached.AssignmentDelivered;
                        assignmentWarning = attached.Warning;
                        sentNotifications = attached.SentNotifications;
                    }
                    var childOutput =
                        $"Child session created: `{child.Id}` ({(OptionalBool(args, "fork") == true ? "forked from parent" : "new session")})";
                    if (taskId is not null)
                        childOutput += delivered
                            ? $". Task assignment sent{(assignmentWarning is not null ? " with warning: " + assignmentWarning : "")}."
                            : $", but task assignment delivery failed{(assignmentWarning is not null ? ": " + assignmentWarning : ".")}";
                    else if (delivered)
                        childOutput += ". Initial message sent.";
                    var childResult = Output(
                        childOutput,
                        delivered && after == "wait" ? child.Id : null
                    );
                    childResult["sentNotifications"] = sentNotifications;
                    return (
                        childResult,
                        taskId is null ? after == "finish" : delivered && after == "finish"
                    );
                }
                case "send_to_session":
                {
                    Keys(
                        args,
                        [
                            "sessionId",
                            "handoffRecall",
                            "message",
                            "afterSend",
                            "handoffConfirmation",
                        ],
                        ["sessionId", "message"]
                    );
                    var after = AfterSend(args);
                    var requested = RequiredString(args, "sessionId");
                    var target = await SendAsync(
                        source,
                        requested,
                        RequiredString(args, "message"),
                        toolScriptRunId: toolScriptRunId
                    );
                    try
                    {
                        sessionMessageDelivered?.Invoke(target, RequiredString(args, "message"));
                    }
                    catch (Exception error)
                    {
                        source.Entry.RecordBestEffortFailure(error);
                    }
                    return (
                        Output(
                            target == requested
                                ? $"Message sent to session `{target}`"
                                : $"Message sent to session `{target}` (requested `{requested}`)",
                            after == "wait" ? target : null
                        ),
                        after == "finish"
                    );
                }
                case "refresh_session_snapshot":
                {
                    Keys(args, [], []);
                    var model = await RefreshSnapshotAsync(source);
                    return (
                        Output(
                            $"Refreshed Session {source.Id} prompt snapshot for concrete model {model}."
                        ),
                        false
                    );
                }
                default:
                    throw new InvalidDataException("Unsupported Agent tool.");
            }
        }
        catch (SessionIdentityMoveException error)
        {
            var detail = (JsonObject)error.Details.DeepClone();
            detail["error"] = error.Message;
            return (detail, false);
        }
        catch (SessionDeletionException error)
        {
            var response = UnsupportedTurnToolExecutor.ToolError(error.Code, error.Message);
            response["error"]!["details"] = error.Details.DeepClone();
            return (response, false);
        }
        catch (CommittedSessionCreationException error)
        {
            var response = UnsupportedTurnToolExecutor.ToolError("partial_create", error.Message);
            var detail = response["error"] as JsonObject;
            if (error.SessionId is not null)
                detail!["sessionId"] = error.SessionId;
            if (error.InitialDeliveryCommitted is not null)
                detail!["initialDeliveryCommitted"] = error.InitialDeliveryCommitted;
            if (error.ParentNoticeCommitted is not null)
                detail!["parentNoticeCommitted"] = error.ParentNoticeCommitted;
            return (response, false);
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or IOException
                        or InvalidOperationException
                        or System.Text.Json.JsonException
                        or ArgumentException
                        or UnauthorizedAccessException
                        or YamlDotNet.Core.YamlException
            )
        {
            return (
                UnsupportedTurnToolExecutor.ToolError("agent_tool_error", error.Message),
                false
            );
        }
    }

    private static JsonObject Output(string value, string? waitTarget = null)
    {
        var output = new JsonObject { ["output"] = value };
        if (waitTarget is not null)
            output["__waitTarget"] = waitTarget;
        return output;
    }

    private static void Keys(JsonObject args, string[] allowed, string[] required)
    {
        if (
            args.Any(item => !allowed.Contains(item.Key, StringComparer.Ordinal))
            || required.Any(key => !args.ContainsKey(key))
        )
            throw new InvalidDataException("Tool arguments contain unsupported or missing fields.");
    }

    private static string RequiredString(JsonObject args, string key) =>
        args[key] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : throw new InvalidDataException($"{key} must be a string.");

    private static string? OptionalString(JsonObject args, string key) =>
        args.ContainsKey(key) ? RequiredString(args, key) : null;

    private static bool? OptionalBool(JsonObject args, string key) =>
        !args.ContainsKey(key) ? null
        : args[key] is JsonValue value && value.TryGetValue<bool>(out var result) ? result
        : throw new InvalidDataException($"{key} must be a boolean.");

    private static string AfterSend(JsonObject args)
    {
        var value = OptionalString(args, "afterSend") ?? "continue";
        if (value is not ("continue" or "finish" or "wait"))
            throw new InvalidDataException("afterSend must be continue, finish, or wait.");
        return value;
    }

    private static JsonObject? OptionalForceModel(JsonObject args)
    {
        if (!args.ContainsKey("forceModel"))
            return null;
        if (args["forceModel"] is not JsonObject force)
            throw new InvalidDataException("forceModel must be an object.");
        Keys(force, ["modelId", "effort"], []);
        if (force.ContainsKey("modelId"))
            _ = RequiredString(force, "modelId");
        if (force.ContainsKey("effort"))
        {
            var effort = RequiredString(force, "effort");
            if (effort is not ("none" or "low" or "medium" or "high" or "xhigh" or "max"))
                throw new InvalidDataException("Unsupported effort override.");
        }
        return force;
    }
}
