using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    internal static JsonArray Definitions() => new(
        new JsonObject
        {
            ["type"] = "function", ["name"] = "exec",
            ["description"] = "Run a shell command in the local tool workspace. Full output is saved to a log and a bounded preview is returned. If the command outlasts timeout, it continues in the background and returns an execId; completion is later reported to this session. Timeout, Stop, and normal host shutdown do not kill a command that has already started. Use read_exec to inspect its status or output. The working directory is not a security sandbox.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object", ["additionalProperties"] = false,
                ["properties"] = new JsonObject
                {
                    ["command"] = new JsonObject { ["type"] = "string", ["description"] = "Shell command or pipeline to execute." },
                    ["cwd"] = new JsonObject { ["type"] = "string", ["description"] = "Existing directory relative to the tool workspace. Omit to use the workspace root. Directory changes inside one command do not change the default for later calls." },
                    ["timeout"] = new JsonObject { ["type"] = "number", ["minimum"] = 1, ["description"] = "Seconds to wait before returning a still-running command in the background. Defaults to 15; values above 60 are reduced to 60 with a warning." }
                },
                ["required"] = new JsonArray("command")
            },
            ["strict"] = false
        },
        new JsonObject
        {
            ["type"] = "function", ["name"] = "read_exec",
            ["description"] = "Inspect an execution from the current session and read a bounded portion of its captured output. Use nextOffset from the result to read the next portion. Offsets count bytes in the original log.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object", ["additionalProperties"] = false,
                ["properties"] = new JsonObject
                {
                    ["execId"] = new JsonObject { ["type"] = "string", ["description"] = "Execution ID returned by exec in this session." },
                    ["offset"] = new JsonObject { ["type"] = "integer", ["minimum"] = 0, ["description"] = "Byte offset in the captured log. Defaults to 0." }
                },
                ["required"] = new JsonArray("execId")
            },
            ["strict"] = false
        });
}
