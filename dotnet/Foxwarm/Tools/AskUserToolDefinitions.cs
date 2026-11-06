using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class AskUserToolDefinitions
{
    internal static JsonObject Definition() =>
        new()
        {
            ["type"] = "function",
            ["name"] = "ask_user",
            ["strict"] = false,
            ["description"] =
                "Ask the user for a decision or information you need, optionally offering choices. The user can pick options, write their own answer, or skip. By default the Session pauses after the current tool batch until the user answers; set afterAsk to continue to keep working on things that do not depend on the answer, and the answer arrives later as a user message. While the Session is waiting on a question, any message the user sends is treated as the answer. In a delegated Session, ask your parent Session first and ask the user only for decisions the parent cannot make. Use close to close an open question that is no longer needed or that the user already answered in conversation.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["required"] = new JsonArray(),
                ["properties"] = new JsonObject
                {
                    ["questions"] = new JsonObject
                    {
                        ["type"] = "array",
                        ["description"] =
                            "Questions to ask together. The user answers them in one submission.",
                        ["minItems"] = 1,
                        ["maxItems"] = 4,
                        ["items"] = new JsonObject
                        {
                            ["type"] = "object",
                            ["additionalProperties"] = false,
                            ["required"] = new JsonArray("question"),
                            ["properties"] = new JsonObject
                            {
                                ["question"] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["description"] = "Complete question text.",
                                },
                                ["options"] = new JsonObject
                                {
                                    ["type"] = "array",
                                    ["description"] =
                                        "Choices to offer. Omit for a free-text question. The user can always write a different answer instead.",
                                    ["maxItems"] = 6,
                                    ["items"] = new JsonObject
                                    {
                                        ["type"] = "object",
                                        ["additionalProperties"] = false,
                                        ["required"] = new JsonArray("label"),
                                        ["properties"] = new JsonObject
                                        {
                                            ["label"] = new JsonObject
                                            {
                                                ["type"] = "string",
                                                ["description"] = "Short choice text.",
                                            },
                                            ["description"] = new JsonObject
                                            {
                                                ["type"] = "string",
                                                ["description"] =
                                                    "What choosing this option means.",
                                            },
                                            ["recommended"] = new JsonObject
                                            {
                                                ["type"] = "boolean",
                                                ["description"] = "Mark the option you recommend.",
                                            },
                                        },
                                    },
                                },
                                ["multiSelect"] = new JsonObject
                                {
                                    ["type"] = "boolean",
                                    ["description"] =
                                        "Allow the user to choose more than one option.",
                                },
                            },
                        },
                    },
                    ["afterAsk"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["enum"] = new JsonArray("wait", "continue"),
                        ["description"] =
                            "wait (default) ends the turn after this tool batch until the user answers. continue returns immediately so you can keep working; wait for the answer later with wait's waitQuestionIds if you need it.",
                    },
                    ["close"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] =
                            "ID of an open question to close instead of asking a new one.",
                    },
                    ["closeNote"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] =
                            "Short note shown to the user when closing, for example that it was answered in conversation.",
                    },
                },
            },
        };
}
