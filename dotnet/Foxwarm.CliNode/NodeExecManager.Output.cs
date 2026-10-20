using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

internal sealed partial class NodeExecManager
{
    internal static (double Seconds, string? Warning) Timeout(JsonNode? value) =>
        ExecOutput.Timeout(value);

    internal static string CompletedDuration(JsonObject entry, JsonObject status) =>
        ExecOutput.CompletedDuration(entry, status);

    internal static Task<string> Foreground(JsonObject entry, JsonObject status, string? warning) =>
        ExecOutput.Foreground(entry, status, warning);

    internal Task<string> BackgroundOutput(
        JsonObject entry,
        double seconds,
        string? warning,
        bool stopped
    ) => ExecOutput.BackgroundOutput(entry, seconds, warning, stopped, Now());

    internal static Task<string> ResolvedCwd(JsonObject entry) => ExecOutput.ResolvedCwd(entry);

    internal static Task<JsonObject> Result(
        JsonObject entry,
        JsonObject? status,
        string output,
        bool programmatic
    ) => ExecOutput.Result(entry, status, output, programmatic);

    internal static string Completion(JsonObject entry, JsonObject status) =>
        ExecOutput.Completion(entry, status);
}
