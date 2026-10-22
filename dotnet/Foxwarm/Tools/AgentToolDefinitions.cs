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
            "Create, list, inspect, claim, update, complete, or cancel a shared task. Prefer combining task bookkeeping with related work rather than spending a separate model turn on it. Put independent calls in the same tool batch; use run_script for dependencies, especially creating a task and passing its returned taskId to create_child_session. The current Session supplies the actor identity and is the creator of new tasks; ownerSessionId selects the assignee, not the caller. Set ownerSessionId during create for immediate assignment; use assign to transfer or release an existing owner.",
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
                        "Problem or scope description for a new task, or replacement description when updating. Any Session may update the description of an open or active task, subject to tool permissions. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content."
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
                        "For list, choose tasks created by or assigned to the current Session (default), tasks owned by the current Session, tasks in the current Agent, or all tasks.",
                        "current-session",
                        "owned",
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

    private static JsonObject CreationIsolationRules()
    {
        var rules = IsolationRules();
        rules["description"] =
            "Replace this agent's legacy isolated-tool rules. Use an empty array to clear them. These rules apply only while the agent is isolated, alongside the instance-wide authorization policy.";
        return rules;
    }

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
                "Create an agent with its own persistent workspace and memory. A main session is also created by default. Use create_session instead when you only need another conversation under an existing agent.",
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
                        ["inheritMemory"] = Boolean(
                            "Copy memory files from the source agent once. Use inherit for ongoing shared-memory inheritance."
                        ),
                        ["sourceSessionId"] = String(
                            "Session whose current Node and model provide creation defaults. Defaults to this session."
                        ),
                        ["convertSession"] = Boolean(
                            "Convert an existing session into this agent's main session. Requires createMainSession=true."
                        ),
                        ["isolatedNode"] = String(
                            "Non-master Node to bind when creating an isolated agent."
                        ),
                        ["toolRules"] = CreationIsolationRules(),
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
                            "Session name without the agent prefix. Use only ASCII letters, digits, underscores, and hyphens."
                        ),
                        ["displayName"] = String("Display name for the new session."),
                        ["parentSessionId"] = String(
                            "Existing session to record as the new session's parent."
                        ),
                        ["node"] = String(
                            "Node for the new session. Omit to inherit this session's current Node. An isolated target agent uses its bound Node."
                        ),
                        ["systemPromptFiles"] = new JsonObject
                        {
                            ["type"] = "array",
                            ["description"] =
                                "Memory source files for the new prompt snapshot. When supplied, these replace the default memory-file selection; other system instructions remain.",
                            ["items"] = String(
                                "File path. Relative paths use the agent directory; absolute paths and ~/ paths are accepted."
                            ),
                        },
                        ["forceModel"] = ForceModel(),
                    },
                    "agentName",
                    "sessionName"
                )
            ),
            Tool(
                "create_child_session",
                "Create a child Session under the current Session. With taskId, assign or transfer the task to the child, deliver its full description and any message as one assignment, and start work. Complete the task with the task tool. Completion notifies a Session creator automatically; do not send a separate routine completion report. Without taskId, message is optional and normal completion reporting applies.",
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
                            "Name for the child. Within the same agent, it replaces a main leaf or is appended to the parent ID. Under a different agent, it becomes that agent's session name. A numeric suffix is added when needed to avoid an existing ID."
                        ),
                        ["fork"] = new JsonObject
                        {
                            ["type"] = "boolean",
                            ["default"] = false,
                            ["description"] =
                                "Copy the parent's current context into the child. Defaults to false. Context copying is available only when the child belongs to the same agent as the parent.",
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
                        ["node"] = String(
                            "Node for the new child session. Omit to inherit the parent's current Node. An isolated target agent uses its bound Node."
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
                "Send a message to another Session. Self-send is available only from inside ToolScript. Use this to assign work or report results across Sessions. For a completed child report, use afterSend=finish; use wait only when you need a later response.",
                Parameters(
                    new JsonObject
                    {
                        ["sessionId"] = String(
                            "Target Session ID. <main> selects this agent's main session; <parent> selects this session's direct parent and requires one to exist. Access is subject to session permissions."
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
                "Refresh a session's prompt snapshot now after changes to memory, inheritance, or available skills, without waiting for an automatic refresh.",
                Parameters(
                    new JsonObject
                    {
                        ["sessionId"] = String(
                            "Session to refresh now, even if it has been inactive for more than an hour. Defaults to this session."
                        ),
                    }
                )
            ),
            TaskDefinition(),
        ];
}
