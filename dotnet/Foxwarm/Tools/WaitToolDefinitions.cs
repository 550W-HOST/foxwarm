using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class WaitToolDefinitions
{
    internal static JsonObject Definition()
    {
        static JsonObject Array(
            string description,
            int minimum,
            string itemDescription,
            bool session = false
        )
        {
            var items = new JsonObject { ["type"] = "string", ["description"] = itemDescription };
            if (session)
                items["pattern"] = ".*\\S.*";
            var array = new JsonObject
            {
                ["type"] = "array",
                ["description"] = description,
                ["uniqueItems"] = true,
                ["minItems"] = 0,
                ["items"] = items,
            };
            if (minimum > 1)
                array["anyOf"] = new JsonArray(
                    new JsonObject { ["maxItems"] = 0 },
                    new JsonObject { ["minItems"] = minimum }
                );
            return array;
        }
        return new JsonObject
        {
            ["type"] = "function",
            ["name"] = "wait",
            ["strict"] = false,
            ["description"] =
                "End the current turn and wait for more information before continuing. This tool registers the wait and returns; it does not remain running until messages arrive or work completes. It requests that the Session pause after the current tool batch. Specify what you are waiting for using at least one of the options below. Incoming messages or other events can resume the session even while the specified work is still pending. If another tool in the same batch returns an error, this wait is canceled so you can handle the error.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["required"] = new JsonArray(),
                ["properties"] = new JsonObject
                {
                    ["reason"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "Briefly explain what you are waiting for.",
                    },
                    ["wakeIfNoActivityAfterSeconds"] = new JsonObject
                    {
                        ["type"] = new JsonArray("number", "null"),
                        ["exclusiveMinimum"] = 0,
                        ["description"] =
                            "Resume after this many seconds if nothing else has resumed the session. Set to null to disable the automatic 600-second fallback for waitExecIds.",
                    },
                    ["waitAllSessions"] = Array(
                        "Session IDs from which you need responses before continuing the dependent work. Use this only when every listed session must respond. Empty lists are treated as omitted. Cannot be combined with a nonempty waitAnySessions list.",
                        2,
                        "Session ID.",
                        true
                    ),
                    ["waitAnySessions"] = Array(
                        "Session IDs from which you expect a response. Use this when a response from any one of them is enough to continue. Empty lists are treated as omitted.",
                        1,
                        "Session ID.",
                        true
                    ),
                    ["waitExecIds"] = Array(
                        "Background executions whose completion you are waiting for. Use an active execId owned by this session or agent, or one whose completion is already queued. Use the execId returned by exec, not a process ID or file path. Empty lists are treated as omitted. If wakeIfNoActivityAfterSeconds is omitted and waitForInput is not true, a nonempty list adds a 600-second fallback wake. Set wakeIfNoActivityAfterSeconds to null to disable that default.",
                        1,
                        "Execution ID returned by exec."
                    ),
                    ["waitForInput"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["enum"] = new JsonArray(true),
                        ["description"] =
                            "Set to true when waiting for a user message or another external event that is not covered by the session or execution options. When combined with waitExecIds, this keeps the wait input-driven without adding the automatic exec fallback.",
                    },
                },
            },
        };
    }
}
