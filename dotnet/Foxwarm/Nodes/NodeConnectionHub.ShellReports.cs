using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    private static readonly UTF8Encoding ShellStrictUtf8 = new(false, true);

    private static string? ShellFullText(byte[] sample)
    {
        if (sample.Contains((byte)0)) return null;
        try { return ShellStrictUtf8.GetString(sample); }
        catch (DecoderFallbackException) { return null; }
    }

    private static string ShellOutput(byte[] sample, long total, int exit)
    {
        var text = ShellFullText(sample);
        var rendered = text ?? "[Binary output sample, hexadecimal]\n" + Convert.ToHexStringLower(sample);
        if (rendered.Length == 0) rendered = "(No output)";
        var truncated = total > ShellOutputBytes ? "\n[Output truncated: first 4096 and last 4096 bytes; full output was not retained.]" : "";
        return $"{rendered}{truncated}\n\nExit code: {exit}\nTotal output bytes: {total}";
    }

    private async Task ReportShell(HttpContext context, string node)
    {
        ShellTask? task;
        lock (gate) shellTasks.TryGetValue(ShellHeader(context.Request, "X-Foxwarm-Task"), out task);
        if (task is null || !task.Delivered || task.Runtime.Connection.Id != node
            || task.Runtime.Id != ShellHeader(context.Request, "X-Foxwarm-Connection")
            || DateTimeOffset.UtcNow - task.Started > TimeSpan.FromHours(24))
        { context.Response.StatusCode = 410; return; }
        var kind = ShellHeader(context.Request, "X-Foxwarm-Result");
        if (kind is not ("background" or "finished")) throw new InvalidDataException("Invalid result.");
        var sample = await ShellBody(context.Request, ShellOutputBytes, context.RequestAborted);
        var bytesField = ShellHeader(context.Request, "X-Foxwarm-Bytes");
        var exitField = ShellHeader(context.Request, "X-Foxwarm-Exit");
        long total = 0;
        int exit = 0;
        if (kind == "finished" && (
            !Unsigned(bytesField) || !Unsigned(exitField)
            || !long.TryParse(bytesField, NumberStyles.None, CultureInfo.InvariantCulture, out total)
            || total > 9007199254740991L
            || !int.TryParse(exitField, NumberStyles.None, CultureInfo.InvariantCulture, out exit)
            || exit > 255 || sample.Length != Math.Min(total, ShellOutputBytes)))
            throw new InvalidDataException("Invalid result metadata.");
        await task.Serial.WaitAsync(context.RequestAborted);
        try
        {
            if (task.State != "finished")
            {
                var claim = task.Call.Claim!;
                if (kind == "background")
                {
                    if (task.State == "foreground")
                    {
                        await (BackgroundRegistration ?? throw new InvalidOperationException("Node Session events are unavailable."))(node, new JsonObject
                        {
                            ["sessionId"] = claim.OriginalSessionId,
                            ["execId"] = claim.ExecId,
                            ["completionCapability"] = claim.Grant,
                        });
                        lock (gate) task.State = "background";
                        var result = new JsonObject
                        {
                            ["execId"] = claim.ExecId,
                            ["output"] = task.Warning + $"Command continues in background. Exec ID: {claim.ExecId}. Completion will be reported to the originating Session; full output is not retained.",
                        };
                        if (task.Programmatic) { result["status"] = "running"; result["truncated"] = true; }
                        HandleToolReply(task.Runtime.Connection, new JsonObject { ["callId"] = task.CallId, ["result"] = result }, true);
                    }
                }
                else
                {
                    var output = task.Warning + ShellOutput(sample, total, exit);
                    if (task.State == "background")
                    {
                        try
                        {
                            // The client supplies neither owner nor grant. ACK follows the existing strict save lane.
                            await (SessionEvent ?? throw new InvalidOperationException("Node Session events are unavailable."))(node, new JsonObject
                            {
                                ["sessionId"] = claim.OriginalSessionId,
                                ["message"] = $"Shell Node exec {claim.ExecId} completed.\n{output}",
                                ["eventType"] = "background",
                                ["eventId"] = "remote-exec-completion:" + claim.ExecId,
                                ["execId"] = claim.ExecId,
                                ["completionCapability"] = claim.Grant,
                                ["eventTimestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            });
                        }
                        catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException)
                        { context.Response.StatusCode = 503; return; }
                    }
                    else
                    {
                        var result = new JsonObject { ["output"] = output, ["exitCode"] = exit, ["totalBytes"] = total, ["truncated"] = total > ShellOutputBytes };
                        if (task.Programmatic)
                        {
                            var full = total <= ShellOutputBytes ? ShellFullText(sample) : null;
                            result["status"] = "completed";
                            result["execId"] = claim.ExecId;
                            result["sizeBytes"] = total;
                            result["truncated"] = full is null;
                            if (full is not null) result["content"] = full;
                        }
                        HandleToolReply(task.Runtime.Connection, new JsonObject { ["callId"] = task.CallId, ["result"] = result }, true);
                    }
                    lock (gate)
                    {
                        task.State = "finished";
                        task.Script = "";
                        var completed = shellTasks.Values.Where(t => t.Runtime.Connection.Id == node && t.State == "finished").OrderBy(t => t.Started).ToArray();
                        foreach (var old in completed.Take(Math.Max(0, completed.Length - ShellMaxTasks))) shellTasks.Remove(old.Id);
                    }
                }
            }
            ShellAck(context);
        }
        finally { task.Serial.Release(); }
    }

    private static bool Unsigned(string value) => value.Length > 0 && value.All(c => c is >= '0' and <= '9');
}
