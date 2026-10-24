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
                "view_session",
                "Read a Session's current conversation and execution state. Defaults to the latest 10 visible records, with tools summarized by name and count. Use parts to select content and the returned older-page call to continue reading. Use recall for archived originals.",
                new JsonObject
                {
                    ["sessionId"] = Field("string", "Session to read."),
                    ["start"] = Field("number", "Active-history index to read forward from. Negative values count from the end. Omit start and before to read the newest page; do not combine them."),
                    ["before"] = Field("number", "Exclusive active-history index to read backward from. Use the value returned for the older page; do not combine with start."),
                    ["count"] = Field("number", "Maximum visible source records to select after applying parts. Defaults to 10; 0 returns only the header and execution state. Text filters can leave fewer matches."),
                    ["historyVersion"] = Field("number", "History version returned by an earlier view. Supply with start or before to detect a structurally changed range."),
                    ["parts"] = new JsonObject { ["type"] = "array", ["description"] = "Content to show: text, tools, or images. Defaults to all three. Hiding tools preserves commentary in mixed messages; text and images belonging to tool results stay with tools.", ["items"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("text", "tools", "images") } },
                    ["previewLength"] = Field("number", "Total character budget for the response. Omit or use 0 for the default; other values are bounded to 1,000–20,000."),
                    ["contentFilter"] = Field("string", "Keep selected records containing this literal text, ignoring case. Searches the included content of the selected page, not the entire history."),
                    ["includeRegex"] = Field("string", "Keep selected records whose included content matches this regular expression, ignoring case."),
                    ["excludeRegex"] = Field("string", "Exclude selected records whose included content matches this regular expression, ignoring case."),
                    ["toolDetail"] = Field("string", "Tool display detail: names (default) groups names and counts; snippets adds short argument/result excerpts; full expands them within the response budget.", "names", "snippets", "full"),
                },
                "sessionId"
            ),
        ];
}
