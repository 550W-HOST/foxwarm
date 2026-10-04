using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class TimerToolDefinitions
{
    internal static JsonArray Definitions() => new(
        Definition("create_timer", "Schedule a message for a session, once or on a recurring schedule. Choose one of at, afterSeconds, or cron. Timers persist across restarts. Load the timer-automation skill before creating or changing timers.", new JsonObject
        {
            ["sessionId"] = String("Session that owns the timer. Defaults to this session."),
            ["at"] = Absolute("One-time trigger time as an ISO date-time string or Unix epoch milliseconds."),
            ["afterSeconds"] = Number("Seconds from now until a one-time trigger."),
            ["cron"] = String("Recurring cron schedule in the host's local time zone."),
            ["message"] = String("Message delivered on each trigger."),
            ["newSession"] = Boolean("Deliver each trigger to a newly created session instead of the owner session."),
            ["sessionPrefix"] = String("Name prefix for newly created sessions. Defaults to timer; applies when newSession is true."),
            ["agentName"] = String("Agent for newly created sessions. Defaults to the owner session's agent; applies when newSession is true.")
        }, "message"),
        Definition("list_timers", "List timers owned by a session.", new JsonObject { ["sessionId"] = String("Owner Session ID. Defaults to this session.") }),
        Definition("update_timer", "Change an existing timer. Omitted fields keep their current values. To change its schedule, supply exactly one of at, afterSeconds, or cron. Load the timer-automation skill before changing timers.", new JsonObject
        {
            ["timerId"] = String("Timer to update."),
            ["sessionId"] = String("Owner Session ID. Defaults to this session."),
            ["at"] = Absolute("New one-time trigger time as an ISO date-time string or Unix epoch milliseconds."),
            ["afterSeconds"] = Number("Seconds from now until the rescheduled one-time trigger."),
            ["cron"] = String("New recurring cron schedule in the host's local time zone."),
            ["message"] = String("Replacement message for future triggers."),
            ["newSession"] = Boolean("Use a new session for each trigger when true. Setting false returns delivery to the owner and clears new-session target settings."),
            ["sessionPrefix"] = String("Name prefix for new sessions; applies only when newSession is true."),
            ["agentName"] = String("Agent for new sessions; applies only when newSession is true and defaults to the owner session's agent.")
        }, "timerId"),
        Definition("delete_timer", "Delete a timer to stop future triggers. A delivery already in progress is not undone.", new JsonObject
        {
            ["timerId"] = String("Timer to delete."),
            ["sessionId"] = String("Owner Session ID. Defaults to this session.")
        }, "timerId"));
    private static JsonObject String(string description) => new() { ["type"] = "string", ["description"] = description };
    private static JsonObject Number(string description) => new() { ["type"] = "number", ["description"] = description };
    private static JsonObject Boolean(string description) => new() { ["type"] = "boolean", ["description"] = description };
    private static JsonObject Absolute(string description) => new() { ["type"] = new JsonArray("string", "number"), ["description"] = description };
    private static JsonObject Definition(string name, string description, JsonObject properties, params string[] required) => new()
    {
        ["type"] = "function", ["name"] = name, ["description"] = description, ["strict"] = false,
        ["parameters"] = new JsonObject { ["type"] = "object", ["properties"] = properties, ["required"] = new JsonArray(required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()) }
    };
}
