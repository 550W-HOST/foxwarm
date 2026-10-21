using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class TimerToolDefinitions
{
    internal static JsonArray Definitions() =>
        new(
            ScriptDefinition("""
{
  "name": "create_timer",
  "description": "Schedule a message or a ToolScript run, once or on a recurring schedule. Choose one of at, afterSeconds, or cron. ToolScript timers run for the calling Session without starting a model turn; the script can send a message when needed. Timers survive restarts. Load the timer-automation skill before creating or changing timers.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "message",
          "toolscript"
        ],
        "description": "What each trigger does. Defaults to message."
      },
      "script": {
        "type": "object",
        "description": "ToolScript to run on each trigger when action is toolscript."
      },
      "sessionId": {
        "type": "string",
        "description": "Session that owns the timer. Defaults to this Session. ToolScript timers must belong to the calling Session."
      },
      "at": {
        "type": [
          "string",
          "number"
        ],
        "description": "One-time trigger time as an ISO date-time string or Unix epoch milliseconds."
      },
      "afterSeconds": {
        "type": "number",
        "description": "Seconds from now until a one-time trigger."
      },
      "cron": {
        "type": "string",
        "description": "Cron schedule for recurring triggers."
      },
      "message": {
        "type": "string",
        "description": "Message delivered on each trigger when action is message."
      },
      "newSession": {
        "type": "boolean",
        "description": "Deliver each message trigger to a newly created Session instead of the owner Session."
      },
      "sessionPrefix": {
        "type": "string",
        "description": "Name prefix for newly created Sessions. Defaults to timer; applies to message timers when newSession is true."
      },
      "agentName": {
        "type": "string",
        "description": "Agent for newly created Sessions. Defaults to the owner Session's Agent; applies to message timers when newSession is true."
      }
    },
    "required": []
  },
  "type": "function"
}
"""),
            Definition(
                "list_timers",
                "List timers owned by a session.",
                new JsonObject
                {
                    ["sessionId"] = String("Owner Session ID. Defaults to this session."),
                }
            ),
            ScriptDefinition("""
{
  "name": "update_timer",
  "description": "Change an existing timer. Omitted fields keep their current values. To change its schedule, supply exactly one of at, afterSeconds, or cron. A supplied script replaces the complete script specification. Load the timer-automation skill before changing timers.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "message",
          "toolscript"
        ],
        "description": "Replacement trigger action. Supply the message or script required by the new action."
      },
      "script": {
        "type": "object",
        "description": "Complete replacement ToolScript specification for future triggers."
      },
      "timerId": {
        "type": "string",
        "description": "Timer to update."
      },
      "sessionId": {
        "type": "string",
        "description": "Owner Session ID. Defaults to this Session. Only the owner Session may configure a ToolScript timer."
      },
      "at": {
        "type": [
          "string",
          "number"
        ],
        "description": "New one-time trigger time as an ISO date-time string or Unix epoch milliseconds."
      },
      "afterSeconds": {
        "type": "number",
        "description": "Seconds from now until the rescheduled one-time trigger."
      },
      "cron": {
        "type": "string",
        "description": "New recurring cron schedule."
      },
      "message": {
        "type": "string",
        "description": "Replacement message for future message triggers."
      },
      "newSession": {
        "type": "boolean",
        "description": "Use a new Session for each message trigger when true. Setting false returns message delivery to the owner and clears new-session target settings."
      },
      "sessionPrefix": {
        "type": "string",
        "description": "Name prefix for new Sessions; applies to message timers when newSession is true."
      },
      "agentName": {
        "type": "string",
        "description": "Agent for new Sessions; applies to message timers when newSession is true and defaults to the owner Session's Agent."
      }
    },
    "required": [
      "timerId"
    ]
  },
  "type": "function"
}
"""),
            Definition(
                "delete_timer",
                "Delete a timer to stop future triggers. A delivery already in progress is not undone.",
                new JsonObject
                {
                    ["timerId"] = String("Timer to delete."),
                    ["sessionId"] = String("Owner Session ID. Defaults to this session."),
                },
                "timerId"
            )
        );

    private static JsonObject ScriptDefinition(string json)
    {
        var definition = JsonNode.Parse(json)!.AsObject();
        definition["parameters"]!["properties"]!["script"]!["properties"] =
            ToolScriptToolDefinitions.Definitions()[0]!["parameters"]!["properties"]!.DeepClone();
        return definition;
    }

    private static JsonObject String(string description) =>
        new() { ["type"] = "string", ["description"] = description };

    private static JsonObject Definition(
        string name,
        string description,
        JsonObject properties,
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
                ["properties"] = properties,
                ["required"] = new JsonArray(
                    required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                ),
            },
        };
}
