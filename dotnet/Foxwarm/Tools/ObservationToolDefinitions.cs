using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ObservationToolDefinitions
{
    private static JsonObject Field(string type, string description, params string[] choices)
    {
        var field = new JsonObject { ["type"] = type, ["description"] = description };
        if (choices.Length > 0) field["enum"] = new JsonArray(choices.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
        return field;
    }
    private static JsonObject Definition(string name, string description, JsonObject fields, params string[] required) => new()
    {
        ["type"] = "function",
        ["name"] = name,
        ["description"] = description,
        ["strict"] = false,
        ["parameters"] = new JsonObject
        {
            ["type"] = "object",
            ["additionalProperties"] = false,
            ["properties"] = fields,
            ["required"] = new JsonArray(required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray())
        }
    };
    internal static JsonObject[] Definitions() =>
    [
        Definition("session", "Inspect this session's status, list sessions in the current Agent by default, or change a session's display name. Status includes the current Node and working directory, model and effort settings, context usage, and recent children.", new JsonObject
        {
            ["action"] = Field("string", "status (default) inspects this session; list returns a page of sessions; update-display-name sets or clears a session's display name.", "status", "list", "update-display-name"),
            ["start"] = Field("number", "Zero-based offset for list, ordered by most recent activity. Defaults to 0."),
            ["count"] = Field("number", "Number of sessions to return for list. Defaults to 20."),
            ["scope"] = Field("string", "Scope for list. Defaults to current-agent; use all to include sessions from other Agents.", "current-agent", "all"),
            ["sessionId"] = Field("string", "Target for update-display-name. Defaults to this session; status always describes this session."),
            ["name"] = Field("string", "New display name for update-display-name. An empty string clears it.")
        }),
        Definition("get_session_messages", "Read a page of a session's messages and its current execution state. Defaults to the latest 10 messages. Filters narrow the selected page, not the entire conversation. Use recall to inspect archived context blocks or exact message ranges.", new JsonObject
        {
            ["sessionId"] = Field("string", "Session to read."),
            ["start"] = Field("number", "Zero-based message offset. Negative values count back from the end; -10 starts at the tenth-last message."),
            ["count"] = Field("number", "Number of messages to retrieve."),
            ["previewLength"] = Field("number", "Total character budget for the response. Omit or use 0 for the default; other values are bounded to 1,000-20,000."),
            ["contentFilter"] = Field("string", "Keep selected messages whose full text or tool content contains this text, ignoring case. Previews show the matching area when possible."),
            ["includeRegex"] = Field("string", "Keep selected messages matching this regular expression, ignoring case."),
            ["excludeRegex"] = Field("string", "Exclude selected messages matching this regular expression, ignoring case."),
            ["toolDetail"] = Field("string", "Tool display detail: names (default) shows name, ID, and status; snippets adds short excerpts; full includes arguments and results within the response budget.", "names", "snippets", "full")
        }, "sessionId"),
        Definition("set_goal", "Keep a goal reminder in this session during substantial work that may span compaction. Use it when this session will perform the work over many steps, not for short tasks or work mostly delegated to children. The reminder survives compaction and applies only to this session.", new JsonObject
        {
            ["goal"] = Field("string", "Goal to remember. An empty string clears it."),
            ["remindEvery"] = Field("number", "Number of subsequent non-reminder messages between reminders. Omit to keep the current interval, or use the default of 20 if none is set."),
            ["clear"] = Field("boolean", "Remove the current goal reminder.")
        })
    ];
}
