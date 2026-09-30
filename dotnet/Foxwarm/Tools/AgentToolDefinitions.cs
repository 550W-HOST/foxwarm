using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class AgentToolDefinitions
{
    private const string ForceModelDescription = "Only use when the user explicitly requests a model or effort override for this task or session. Otherwise omit this parameter to use the normal inherited defaults; an empty object also leaves them unchanged.";
    private static JsonObject String(string description) => new() { ["type"] = "string", ["description"] = description };
    private static JsonObject Boolean(string description) => new() { ["type"] = "boolean", ["description"] = description };
    private static JsonObject Choice(string description, params string[] values) => new()
    {
        ["type"] = "string", ["description"] = description,
        ["enum"] = new JsonArray(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray())
    };
    private static JsonObject ForceModel() => new()
    {
        ["type"] = "object", ["description"] = ForceModelDescription,
        ["properties"] = new JsonObject
        {
            ["modelId"] = String("Configured model key to use."),
            ["effort"] = Choice("Effort override. Can be set without modelId to use the otherwise selected model.",
                "none", "low", "medium", "high", "xhigh", "max")
        },
        ["required"] = new JsonArray(), ["additionalProperties"] = false
    };
    private static JsonObject Parameters(JsonObject properties, params string[] required) => new()
    {
        ["type"] = "object", ["properties"] = properties,
        ["required"] = new JsonArray(required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
        ["additionalProperties"] = false
    };
    private static JsonObject Tool(string name, string description, JsonObject parameters) => new()
    {
        ["type"] = "function", ["name"] = name, ["description"] = description,
        ["strict"] = false, ["parameters"] = parameters
    };

    public static IReadOnlyList<JsonObject> Definitions() =>
    [
        Tool("create_agent",
            "Create an agent with its own workspace and memory directory. A main session is also created by default. Use create_session instead when you only need another conversation under an existing agent.",
            Parameters(new JsonObject
            {
                ["agentName"] = String("New agent name, using letters, numbers, hyphens, or underscores."),
                ["createMainSession"] = Boolean("Also create the agent's main session. Defaults to true.")
            }, "agentName")),
        Tool("create_session", "Create a conversation under an existing agent, reusing that agent's memory and workspace.",
            Parameters(new JsonObject
            {
                ["agentName"] = String("Existing agent that will own the session."),
                ["sessionName"] = String("Session name without the agent prefix; it cannot contain /."),
                ["displayName"] = String("Display name for the new session."),
                ["forceModel"] = ForceModel()
            }, "agentName", "sessionName")),
        Tool("create_child_session",
            "Create a fresh child session under the current or a specified agent. Supply an initial message to start its work. Ask the child to report back with send_to_session; creation alone does not deliver its eventual result.",
            Parameters(new JsonObject
            {
                ["agentName"] = String("Existing agent that will own the child. Omit to use this session's agent."),
                ["suffix"] = String("Name used to form the child's Session ID. A numeric suffix is added when needed to avoid an existing ID."),
                ["displayName"] = String("Display name for the new child session. This does not change its session ID."),
                ["message"] = String("Initial task or message to send immediately after creation. Omit to create the child without starting a turn."),
                ["afterSend"] = Choice("What this session does after creation and any initial delivery: continue (default), finish the turn without waiting, or wait for a reply. The wait option requires a nonempty initial message; other incoming activity can also resume the session.", "continue", "finish", "wait"),
                ["forceModel"] = ForceModel()
            }, "suffix")),
        Tool("send_to_session", "Send a message to another session. Use this to assign work or report results across sessions. For a completed child report, use afterSend=finish; use wait only when you need a later response.",
            Parameters(new JsonObject
            {
                ["sessionId"] = String("Target Session ID. <main> selects this agent's main session; <parent> selects this session's direct parent and requires one to exist."),
                ["message"] = String("Message to deliver."),
                ["afterSend"] = Choice("What this session does after successful delivery: continue (default), finish the turn without waiting, or wait for a response. Other incoming activity can also resume a waiting session.", "continue", "finish", "wait")
            }, "sessionId", "message")),
        Tool("refresh_session_snapshot",
            "Refresh this session's prompt snapshot from its memory files. Later model requests use the refreshed snapshot; an in-flight request keeps the snapshot it already selected.",
            Parameters(new JsonObject()))
    ];
}
