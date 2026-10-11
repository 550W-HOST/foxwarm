using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class AgentToolDefinitions
{
    private const string ForceModelDescription =
        "Only use when the user explicitly requests a model or effort override for this task or session. Otherwise omit this parameter to use the normal inherited defaults; an empty object also leaves them unchanged.";

    private static JsonObject String(string description) =>
        new() { ["type"] = "string", ["description"] = description };

    private static JsonObject Boolean(string description) =>
        new() { ["type"] = "boolean", ["description"] = description };

    private static JsonObject Choice(string description, params string[] values) =>
        new()
        {
            ["type"] = "string",
            ["description"] = description,
            ["enum"] = new JsonArray(
                values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
        };

    private static JsonObject ForceModel() =>
        new()
        {
            ["type"] = "object",
            ["description"] = ForceModelDescription,
            ["properties"] = new JsonObject
            {
                ["modelId"] = String("Configured model key to use."),
                ["effort"] = Choice(
                    "Effort override. Can be set without modelId to use the otherwise selected model.",
                    "none",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max"
                ),
            },
            ["required"] = new JsonArray(),
            ["additionalProperties"] = false,
        };

    private static JsonObject Parameters(JsonObject properties, params string[] required) =>
        new()
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = new JsonArray(
                required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["additionalProperties"] = false,
        };

    private static JsonObject Tool(string name, string description, JsonObject parameters) =>
        new()
        {
            ["type"] = "function",
            ["name"] = name,
            ["description"] = description,
            ["strict"] = false,
            ["parameters"] = parameters,
        };

    private static JsonObject TaskDefinition() =>
        Tool(
            "task",
            "Create and track a small task shared by Foxwarm Sessions. Use one action at a time to create, list, inspect, claim, update, complete, or cancel a task. The current Session is recorded automatically as the creator and actor; do not use ownerSessionId to identify the caller. When creating a task, you may set ownerSessionId to assign it immediately; use assign only to transfer or release an existing task owner.",
            Parameters(
                new JsonObject
                {
                    ["action"] = Choice(
                        "Task operation to perform.",
                        "create",
                        "list",
                        "get",
                        "claim",
                        "assign",
                        "update",
                        "complete",
                        "cancel"
                    ),
                    ["title"] = String("Task title. Required when action is create."),
                    ["description"] = String(
                        "Problem or scope description for a new task, or replacement description when updating. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content."
                    ),
                    ["parentTaskId"] = String(
                        "Existing parent task ID for a simple child task. Set only when creating."
                    ),
                    ["taskId"] = String(
                        "Existing task ID. Required for get, claim, update, complete, and cancel."
                    ),
                    ["status"] = Choice(
                        "For list, filter by task status. For update, set only open or active.",
                        "open",
                        "active",
                        "completed",
                        "cancelled"
                    ),
                    ["scope"] = Choice(
                        "For list, choose tasks created by or assigned to the current Session (default), any Session in the current Agent, or all Sessions and users.",
                        "current-session",
                        "current-agent",
                        "all"
                    ),
                    ["note"] = String("Short progress note to append when updating a task."),
                    ["result"] = String(
                        "Completion summary for a completed task. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content."
                    ),
                    ["notifySession"] = Boolean(
                        "When true, create/assign notify the new owner and, on transfer or release, the previous owner after the change is saved. For update with a note, notify the current owner unless it is the caller. Omitted or false saves without these notifications."
                    ),
                    ["ownerSessionId"] = new JsonObject
                    {
                        ["type"] = new JsonArray("string", "null"),
                        ["description"] =
                            "For create, the optional existing Session ID to receive the task. For assign, the existing Session ID to receive the task, or null to release the current owner.",
                    },
                    ["reason"] = String("Short reason for cancelling a task."),
                },
                "action"
            )
        );

    private static JsonObject IsolationRules() =>
        new()
        {
            ["type"] = "array",
            ["maxItems"] = 256,
            ["description"] =
                "Replace this agent's legacy isolated-tool rules. Use an empty array to clear them. These rules apply only while the agent is isolated.",
            ["items"] = new JsonObject
            {
                ["oneOf"] = new JsonArray(
                    new[] { "builtin", "node", "mcp" }
                        .Select(source =>
                        {
                            var properties = new JsonObject
                            {
                                ["effect"] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["enum"] = new JsonArray("allow", "deny"),
                                },
                                ["source"] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["enum"] = new JsonArray(source),
                                },
                                ["tool"] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["maxLength"] = 128,
                                },
                            };
                            var required = new JsonArray("effect", "source", "tool");
                            if (source != "builtin")
                            {
                                var key = source == "node" ? "node" : "server";
                                properties[key] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["maxLength"] = 128,
                                };
                                required.Add(key);
                            }
                            return (JsonNode?)
                                new JsonObject
                                {
                                    ["type"] = "object",
                                    ["additionalProperties"] = false,
                                    ["properties"] = properties,
                                    ["required"] = required,
                                };
                        })
                        .ToArray()
                ),
            },
        };

    public static IReadOnlyList<JsonObject> Definitions() =>
        [
            Tool(
                "set_agent_isolated",
                "Set or clear legacy agent-level isolation and its non-master Node binding. These restrictions apply to all sessions in the agent, in addition to any instance-wide tool authorization policy.",
                Parameters(
                    new JsonObject
                    {
                        ["agentName"] = String("Agent to update."),
                        ["nodeId"] = String(
                            "Non-master Node to bind. An empty string clears isolation; omission leaves the current binding unchanged."
                        ),
                        ["toolRules"] = IsolationRules(),
                    },
                    "agentName"
                )
            ),
            Tool(
                "move_session",
                "Rename a session or move it to another agent, optionally creating the destination agent. The old session ID remains an alias.",
                new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject
                    {
                        ["sessionId"] = String(
                            "Session to move, identified by its ID or an unambiguous alias. Defaults to this session."
                        ),
                        ["newSessionId"] = String(
                            "New session name without an agent prefix or /. Required unless creating an agent, when it defaults to main."
                        ),
                        ["createAgent"] = Boolean(
                            "Create the destination agent. Defaults to false."
                        ),
                        ["newAgentName"] = String(
                            "Destination agent. Required when creating an agent or moving to another agent; omit to rename within the source agent."
                        ),
                        ["createAgentInheritMemory"] = Boolean(
                            "Copy the source agent's memory when creating the destination agent. Defaults to false."
                        ),
                        ["parentSessionId"] = String(
                            "Existing parent session to assign after the move. Omit to keep the current parent."
                        ),
                    },
                }
            ),
            Tool(
                "delete_session",
                "Delete another session's live record, retaining its archived history. Surviving children are detached. A busy target receives a stop request; retry deletion after it becomes idle. The current session cannot delete itself.",
                Parameters(
                    new JsonObject
                    {
                        ["sessionId"] = String(
                            "Session to delete, identified by its ID or an unambiguous alias."
                        ),
                    },
                    "sessionId"
                )
            ),
            Tool(
                "create_agent",
                "Create an agent with its own workspace and memory directory. A main session is also created by default. Use create_session instead when you only need another conversation under an existing agent.",
                Parameters(
                    new JsonObject
                    {
                        ["agentName"] = String(
                            "New agent name, using letters, numbers, hyphens, or underscores."
                        ),
                        ["createMainSession"] = Boolean(
                            "Also create the agent's main session. Defaults to true."
                        ),
                        ["inherit"] = String(
                            "Agent whose memory should be inherited by the new agent."
                        ),
                    },
                    "agentName"
                )
            ),
            Tool(
                "create_session",
                "Create a conversation under an existing agent, reusing that agent's memory and workspace.",
                Parameters(
                    new JsonObject
                    {
                        ["agentName"] = String("Existing agent that will own the session."),
                        ["sessionName"] = String(
                            "Session name without the agent prefix; it cannot contain /."
                        ),
                        ["displayName"] = String("Display name for the new session."),
                        ["forceModel"] = ForceModel(),
                    },
                    "agentName",
                    "sessionName"
                )
            ),
            Tool(
                "create_child_session",
                "Create a child Session under the current Session. If taskId is supplied, attach the new Session to that task; when the task-linked child completes, use task(action:\"complete\", ...) for the completion report instead of sending a separate completion message. Without taskId, preserve the normal completion-report behavior.",
                Parameters(
                    new JsonObject
                    {
                        ["agentName"] = String(
                            "Existing agent that will own the child. Omit to use this session's agent."
                        ),
                        ["taskId"] = String(
                            "Existing task to assign or transfer to the new Session. The child receives the full task description and starts work. Completed or cancelled tasks cannot be assigned."
                        ),
                        ["suffix"] = String(
                            "Name used to form the child's Session ID. A numeric suffix is added when needed to avoid an existing ID."
                        ),
                        ["fork"] = new JsonObject
                        {
                            ["type"] = "boolean",
                            ["default"] = false,
                            ["description"] =
                                "Copy the parent's conversation history and prompt snapshot into the child. Defaults to false. Forks must remain in the same agent.",
                        },
                        ["displayName"] = String(
                            "Display name for the new child session. This does not change its session ID."
                        ),
                        ["handoffRecall"] = String(
                            "Put handoffRecall before message. Start with the exact opening sentence required for a handoff, then write the actual applicable communication rules, the user's request, and the scope this child needs."
                        ),
                        ["message"] = String(
                            "Optional initial instruction. With taskId, add only information not already in the task; it is delivered with the assignment."
                        ),
                        ["afterSend"] = Choice(
                            "What this session does after creation and any initial delivery: continue (default), finish the turn without waiting, or wait for a reply. Waiting requires taskId or a nonempty message; other incoming activity can also resume the session.",
                            "continue",
                            "finish",
                            "wait"
                        ),
                        ["forceModel"] = ForceModel(),
                        ["handoffConfirmation"] = String(
                            "Put handoffConfirmation last. Use the exact required opening and closing sentences with your own specific review."
                        ),
                    },
                    "suffix"
                )
            ),
            Tool(
                "send_to_session",
                "Send a message to another session. Use this to assign work or report results across sessions. For a completed child report, use afterSend=finish; use wait only when you need a later response.",
                Parameters(
                    new JsonObject
                    {
                        ["sessionId"] = String(
                            "Target Session ID. <main> selects this agent's main session; <parent> selects this session's direct parent and requires one to exist."
                        ),
                        ["handoffRecall"] = String(
                            "Put handoffRecall before message. Start with the exact opening sentence required for a handoff, then write the actual applicable communication rules, the user's request, and the scope this recipient needs."
                        ),
                        ["message"] = String("Message to deliver."),
                        ["afterSend"] = Choice(
                            "What this session does after successful delivery: continue (default), finish the turn without waiting, or wait for a response. Other incoming activity can also resume a waiting session.",
                            "continue",
                            "finish",
                            "wait"
                        ),
                        ["handoffConfirmation"] = String(
                            "Put handoffConfirmation last. Use the exact required opening and closing sentences with your own specific review."
                        ),
                    },
                    "sessionId",
                    "message"
                )
            ),
            Tool(
                "refresh_session_snapshot",
                "Refresh this session's prompt snapshot from its memory files. Later model requests use the refreshed snapshot; an in-flight request keeps the snapshot it already selected.",
                Parameters(new JsonObject())
            ),
            TaskDefinition(),
        ];
}
