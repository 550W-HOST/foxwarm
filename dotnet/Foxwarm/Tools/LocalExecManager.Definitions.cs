using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    internal static JsonArray Definitions() =>
        new(
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "exec",
                ["description"] =
                    "Run a shell command on Main. Full output is saved to a log and a bounded preview is returned. If the command outlasts timeout, it continues in the background and returns an execId; completion is later reported to this session. Timeout, Stop, and normal host shutdown do not kill a command that has already started. Use read_exec to inspect its status or output. The observed working directory can update this session's default for later calls. Child commands receive $fw_agentdir and $fw_tmp for the agent directory and its tmp directory. The working directory is not a security sandbox.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject
                    {
                        ["command"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Shell command or pipeline to execute.",
                        },
                        ["cwd"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Working-directory value for this command. Defaults to the session's cwd, or the agent directory when unset. Relative values resolve against the session's cwd, or the agent directory when unset. Absolute paths, ~/ paths, and leading $fw_agentdir or $fw_tmp are accepted subject to permissions. Other leading $ names are rejected.",
                        },
                        ["timeout"] = new JsonObject
                        {
                            ["type"] = "number",
                            ["minimum"] = 1,
                            ["description"] =
                                "Seconds to wait before returning a still-running command in the background. Defaults to 15; values above 60 are reduced to 60 with a warning.",
                        },
                    },
                    ["required"] = new JsonArray("command"),
                },
                ["strict"] = false,
            },
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "read_exec",
                ["description"] =
                    "Inspect an execution from the current session and read a bounded portion of its captured output. Use nextOffset from the result to read the next portion. Offsets count bytes in the original log.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject
                    {
                        ["execId"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Execution ID returned by exec in this session.",
                        },
                        ["offset"] = new JsonObject
                        {
                            ["type"] = "integer",
                            ["minimum"] = 0,
                            ["description"] = "Byte offset in the captured log. Defaults to 0.",
                        },
                    },
                    ["required"] = new JsonArray("execId"),
                },
                ["strict"] = false,
            }
        );
}
