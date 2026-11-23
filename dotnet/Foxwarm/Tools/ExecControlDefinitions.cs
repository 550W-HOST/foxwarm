using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// Hidden builtins behind `ctl exec list` and `ctl exec stop`; never natively declared.
internal static class ExecControlDefinitions
{
    internal static JsonArray Definitions() =>
        new(
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "exec_list",
                ["description"] = "List this Session's commands still running in the background.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject(),
                },
            },
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "exec_stop",
                ["description"] = "Stop a background command of this Session.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject
                    {
                        ["execId"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "execId returned by exec.",
                        },
                    },
                    ["required"] = new JsonArray("execId"),
                },
            }
        );
}
