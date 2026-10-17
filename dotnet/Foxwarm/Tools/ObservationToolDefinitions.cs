using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ObservationToolDefinitions
{
    private static JsonObject Field(string type, string description, params string[] choices)
    {
        var field = new JsonObject { ["type"] = type, ["description"] = description };
        if (choices.Length > 0)
            field["enum"] = new JsonArray(
                choices.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            );
        return field;
    }

    private static JsonObject Definition(
        string name,
        string description,
        JsonObject fields,
        params string[] required
    ) =>
        new()
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
                ["required"] = new JsonArray(
                    required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                ),
            },
        };

    internal static JsonObject[] Definitions() =>
        [
            Definition(
                "session",
                "Inspect session status, list sessions in the current Agent by default, or change a session's display name or parent. Status includes the current Node and working directory, model and effort settings, context usage, and recent children.",
                new JsonObject
                {
                    ["action"] = Field(
                        "string",
                        "status (default) inspects a session; list returns a page of sessions; update-display-name sets or clears its display name; update-parent changes or removes its parent.",
                        "status",
                        "list",
                        "update-display-name",
                        "update-parent"
                    ),
                    ["start"] = Field(
                        "number",
                        "Zero-based offset for list, ordered by most recent activity. Defaults to 0."
                    ),
                    ["count"] = Field(
                        "number",
                        "Number of sessions to return for list. Defaults to 20."
                    ),
                    ["scope"] = Field(
                        "string",
                        "Scope for list. Defaults to current-agent; use all to include sessions from other Agents.",
                        "current-agent",
                        "all"
                    ),
                    ["sessionId"] = Field(
                        "string",
                        "Target for status, update-display-name, or update-parent. Defaults to this session."
                    ),
                    ["name"] = Field(
                        "string",
                        "New display name for update-display-name. An empty string clears it."
                    ),
                    ["parentSessionId"] = new JsonObject
                    {
                        ["type"] = new JsonArray("string", "null"),
                        ["description"] =
                            "Existing Session ID to use as the parent, or null to remove the parent. Required for update-parent.",
                    },
                }
            ),
            Definition(
                "get_session_messages",
                "Review a Session's live context (its current message list, not archived history) to recover context, check evidence, or investigate a specific issue. Returns a page of messages and the current execution state. For delegated work, normally use completion reports or wait rather than repeatedly reading progress. With neither start nor count, returns the latest 10 messages. Filters apply to the selected page. To open a message referenced as `msg#N` (the archived sequence), use `recall`.",
                new JsonObject
                {
                    ["sessionId"] = Field("string", "Session to read."),
                    ["start"] = Field(
                        "number",
                        "Zero-based offset into this Session's live context, not the archived `msg#N` sequence. Negative values count back from the end; -10 starts at the tenth-last message."
                    ),
                    ["count"] = Field("number", "Number of messages to retrieve."),
                    ["previewLength"] = Field(
                        "number",
                        "Total character budget for the response. Omit or use 0 for the default; other values are bounded to 1,000-20,000."
                    ),
                    ["contentFilter"] = Field(
                        "string",
                        "Keep selected messages whose full text or tool content contains this text, ignoring case. Previews show the matching area when possible."
                    ),
                    ["includeRegex"] = Field(
                        "string",
                        "Keep selected messages matching this regular expression, ignoring case."
                    ),
                    ["excludeRegex"] = Field(
                        "string",
                        "Exclude selected messages matching this regular expression, ignoring case."
                    ),
                    ["toolDetail"] = Field(
                        "string",
                        "Tool display detail: names (default) shows name, ID, and status; snippets adds short excerpts; full includes arguments and results within the response budget.",
                        "names",
                        "snippets",
                        "full"
                    ),
                },
                "sessionId"
            ),
        ];
}
