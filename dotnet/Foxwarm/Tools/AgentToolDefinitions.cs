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
            "Create and track a small task shared by Foxwarm Sessions. Use one action at a time to create, list, inspect, claim, update, complete, or cancel a task. The current Session is recorded automatically; do not provide another Session identity.",
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
                        "Short problem or scope description for a new task, or replacement description when updating."
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
                    ["note"] = String("Short progress note to append when updating a task."),
                    ["result"] = String("Short completion summary for a completed task."),
                    ["notifySession"] = Boolean(
                        "When true, send task notifications after the assignment is committed: notify the new owner, and notify the previous owner when ownership changes or is released."
                    ),
                    ["ownerSessionId"] = new JsonObject
                    {
                        ["type"] = new JsonArray("string", "null"),
                        ["description"] =
                            "Existing Session ID to receive the task, or null to release the current owner.",
                    },
                    ["reason"] = String("Short reason for cancelling a task."),
                },
                "action"
            )
        );

    public static IReadOnlyList<JsonObject> Definitions() =>
        [
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
                "Create a child session under the current or a specified agent. Supply an initial message to start its work. Ask the child to report back with send_to_session; creation alone does not deliver its eventual result.",
                Parameters(
                    new JsonObject
                    {
                        ["agentName"] = String(
                            "Existing agent that will own the child. Omit to use this session's agent."
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
                        ["message"] = String(
                            "Initial task or message to send immediately after creation. Omit to create the child without starting a turn."
                        ),
                        ["afterSend"] = Choice(
                            "What this session does after creation and any initial delivery: continue (default), finish the turn without waiting, or wait for a reply. The wait option requires a nonempty initial message; other incoming activity can also resume the session.",
                            "continue",
                            "finish",
                            "wait"
                        ),
                        ["forceModel"] = ForceModel(),
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
                        ["message"] = String("Message to deliver."),
                        ["afterSend"] = Choice(
                            "What this session does after successful delivery: continue (default), finish the turn without waiting, or wait for a response. Other incoming activity can also resume a waiting session.",
                            "continue",
                            "finish",
                            "wait"
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
