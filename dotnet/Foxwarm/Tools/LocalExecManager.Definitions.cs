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
                    "Run a shell command on the current Node. Adjacent exec calls in the same response may run concurrently. Set cwd directly instead of using a preceding exec to change directories. Use one command with && for dependent shell steps, or run_script when later calls depend on earlier results. Output is saved in a command log and shown as a bounded preview. If the command outlasts timeout, it continues in the background and returns an execId; a later event reports completion. The timeout does not kill the command. On supported Nodes, Stop or Run queued ends the wait without killing the command, returning available output and an execId; completion is reported later. Avoid adding head or tail just to shorten the preview: that changes the captured output. If you need both a complete log and a filtered view, save the complete output separately or use tee with a filter that consumes the whole stream. For temporary files, prefer $fw_tmp ($env:fw_tmp in PowerShell) over /tmp; fw_agentdir gives the Agent directory. These environment variables are set for Agent-owned commands on Main and CLI Nodes.",
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
                                "Working directory for this command. Relative paths use the session working directory, or the Node's default directory if unset. When omitted, execution uses that same default chain; on master, the final default is the agent directory. On Main and CLI Nodes, a leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory. Other leading $ names are rejected.",
                        },
                        ["timeout"] = new JsonObject
                        {
                            ["type"] = "number",
                            ["minimum"] = 1,
                            ["description"] =
                                "Seconds to wait before returning a still-running command as a background execution. Defaults to 15; values above 60 are reduced to 60 with a warning.",
                        },
                    },
                    ["required"] = new JsonArray("command"),
                },
                ["strict"] = false,
            }
        );
}
