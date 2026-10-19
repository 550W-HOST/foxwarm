using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

internal sealed partial class NodeExecManager
{
    private sealed record Capture(
        string Text,
        bool Empty,
        bool EndedWithLf,
        bool Truncated,
        bool Oversized = false,
        long? Size = null,
        bool Converted = false,
        string[]? Notes = null
    );

    private const int FullCaptureBytes = 1048576;
    private const string ConversionNote =
        "Foxwarm \\xNN placeholders above are display conversions, not literal command output.";

    internal static (double Seconds, string? Warning) Timeout(JsonNode? value)
    {
        if (value is null)
            return (15, null);
        var seconds = Number(value);
        if (!double.IsFinite(seconds))
            throw new InvalidDataException("timeout must be a number between 1 and 60 seconds");
        if (seconds < 1)
            throw new InvalidDataException("timeout must be between 1 and 60 seconds");
        return seconds > 60
            ? (
                60,
                $"WARNING: Requested timeout {seconds.ToString(CultureInfo.InvariantCulture)}s exceeds the 60s maximum; using 60s."
            )
            : (seconds, null);
    }

    private static async Task<byte[]> Read(FileStream file, long offset, int count)
    {
        file.Position = offset;
        var bytes = new byte[count];
        await file.ReadExactlyAsync(bytes);
        return bytes;
    }

    private static async Task<Capture> CaptureLog(JsonObject entry, bool partial)
    {
        try
        {
            await using var file = new FileStream(
                Text(entry, "logPath")!,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite,
                65536,
                FileOptions.Asynchronous
            );
            var size = file.Length;
            if (size == 0)
                return new(
                    partial ? "(Command started, no output yet)" : "(No output)",
                    true,
                    false,
                    false
                );
            var maximum = partial ? 4000 : 20000;
            string text;
            bool ended;
            var converted = false;
            if (size > FullCaptureBytes)
            {
                var head = await Read(file, 0, 5000);
                var tail = await Read(file, size - 5000, 5000);
                ended = tail[^1] == 10;
                var sample = BoundedTextExcerpt.AnalyzeSamples(head, tail);
                if (sample.Binary)
                    return new(
                        BoundedTextExcerpt.BinaryPreview(head, tail, size, "oversized binary log")
                            + (partial ? "\n...(truncated)" : ""),
                        false,
                        ended,
                        true,
                        true,
                        size
                    );
                converted = sample.Escaped > 0;
                text =
                    sample.Head
                    + $"\n[foxwarm: oversized log middle omitted; showing bounded head and tail samples from a {size}-byte file{(converted ? $"; escaped {sample.Escaped} byte(s)" : "")}]\n"
                    + sample.Tail;
            }
            else
            {
                var bytes = await Read(file, 0, (int)size);
                text = Encoding.UTF8.GetString(bytes);
                ended = text.EndsWith('\n');
            }
            var excerpt = ExecDisplay.Truncate(
                text,
                maximum,
                text.Length > maximum,
                size > FullCaptureBytes
                    ? "this oversized log sample is too long"
                    : "this file is too long"
            );
            if (
                !partial
                && size <= FullCaptureBytes
                && !excerpt.Truncated
                && Math.Ceiling(text.Sum(character => character < 128 ? 0.33 : 1)) > 10000
            )
                excerpt = ExecDisplay.Truncate(text, 10000, true);
            text = excerpt.Text;
            var truncated = excerpt.Truncated || size > FullCaptureBytes;
            if (partial && truncated)
                text += (text.EndsWith('\n') ? "" : "\n") + "...(truncated)";
            return new(
                text,
                false,
                ended,
                truncated,
                size > FullCaptureBytes,
                size,
                converted,
                excerpt.Notes
            );
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return new(
                partial ? "(Command started, no output yet)" : "(No output)",
                true,
                false,
                false
            );
        }
    }

    internal static string CompletedDuration(JsonObject entry, JsonObject status)
    {
        var duration = Number(status["durationMs"]);
        if (status.ContainsKey("durationMs"))
            return ExecDuration.Format(duration) ?? "unknown";
        if (
            NodeFileTools.Flag(status, "finishedAtIsEstimated")
            || Text(status, "error") == MissingStatusError
        )
            return "unknown";
        return DateTimeOffset.TryParse(
            Text(status, "finishedAt"),
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal,
            out var finished
        )
            ? ExecDuration.Format(finished.ToUnixTimeMilliseconds() - Number(entry["startedAt"]))
                ?? "unknown"
            : "unknown";
    }

    internal static async Task<string> Foreground(
        JsonObject entry,
        JsonObject status,
        string? warning
    )
    {
        var output = await CaptureLog(entry, false);
        var lines = new List<string>
        {
            "---",
            "Exit code: " + (status["exitCode"]?.ToJsonString() ?? "unknown"),
            "Duration: " + CompletedDuration(entry, status),
        };
        if (Text(status, "error") is { } error)
            lines.Add("Error: " + error);
        if (warning is not null)
            lines.Add(warning);
        if (output.Truncated)
        {
            lines.Add("Command output saved to: " + Text(entry, "logPath"));
            lines.Add("Output was shortened for inline display.");
        }
        if (output.Oversized)
            lines.Add($"Original log size: {output.Size} bytes.");
        else if (output.Notes is not null)
            lines.AddRange(output.Notes);
        if (!output.Empty && !output.EndedWithLf)
            lines.Add("Original command output had no trailing newline.");
        if (output.Converted)
            lines.Add(ConversionNote);
        return output.Text + (output.Text.EndsWith('\n') ? "" : "\n") + string.Join('\n', lines);
    }

    internal async Task<string> BackgroundOutput(
        JsonObject entry,
        double seconds,
        string? warning,
        bool stopped
    )
    {
        var output = await CaptureLog(entry, true);
        var notice = stopped
            ? "Stop or Run queued ended this call's wait. The command was already started and was not killed; it may still be running in the background. Completion will be reported separately."
            : $"[Process running longer than {seconds.ToString(CultureInfo.InvariantCulture)}s] Switched to background. The system will send a notification message when done. STOP calling tools to check status. Wait for notification unless working on other tasks in parallel; if you continue other work, remember this process remains outstanding until its completion message arrives.";
        var lines = new List<string> { "---", notice };
        if (!output.Empty && !output.EndedWithLf)
            lines.Add("Partial output captured so far had no trailing newline.");
        if (warning is not null)
            lines.Add(warning);
        lines.Add("execId: " + Text(entry, "id"));
        lines.Add(
            "Elapsed: " + (ExecDuration.Format(Now() - Number(entry["startedAt"])) ?? "unknown")
        );
        if (Text(entry, "nodeId") is { Length: > 0 } node && node != "master")
            lines.Add($"Node: `{node}`");
        lines.Add("PID: " + Number(entry["pid"]).ToString(CultureInfo.InvariantCulture));
        lines.Add(await ProcessTree((int)Number(entry["pid"])));
        lines.Add("Log file: " + Text(entry, "logPath"));
        if (output.Oversized)
            lines.Add($"Original log size: {output.Size} bytes.");
        if (output.Converted)
            lines.Add(ConversionNote);
        return "Partial Output:\n"
            + output.Text
            + (output.Text.EndsWith('\n') ? "" : "\n")
            + string.Join('\n', lines);
    }

    internal static async Task<string> ResolvedCwd(JsonObject entry)
    {
        try
        {
            var cwd = NodePaths.TrimSpace(await File.ReadAllTextAsync(Text(entry, "cwdPath")!));
            return cwd.Length > 0 ? cwd : Text(entry, "initialCwd")!;
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return Text(entry, "initialCwd")!;
        }
    }

    internal static async Task<JsonObject> Result(
        JsonObject entry,
        JsonObject? status,
        string output,
        bool programmatic
    )
    {
        var result = new JsonObject { ["output"] = output };
        if (!programmatic)
            return result;
        result["status"] = status is null ? "running" : "completed";
        if (status is not null)
            result["exitCode"] = status["exitCode"]?.DeepClone();
        result["execId"] = Text(entry, "id");
        result["logPath"] = Text(entry, "logPath");
        try
        {
            await using var file = new FileStream(
                Text(entry, "logPath")!,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite,
                65536,
                FileOptions.Asynchronous
            );
            var size = file.Length;
            result["sizeBytes"] = size;
            result["truncated"] = size > FullCaptureBytes;
            if (size <= FullCaptureBytes)
            {
                try
                {
                    result["content"] = Encoding.UTF8.GetString(await Read(file, 0, (int)size));
                }
                catch (EndOfStreamException)
                {
                    result["truncated"] = true;
                }
            }
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            result["truncated"] = true;
        }
        return result;
    }

    private static string Compact(string value) => Regex.Replace(value, "\\s+", " ").Trim();

    internal static string Completion(JsonObject entry, JsonObject status)
    {
        var command = Compact(Text(entry, "command") ?? "");
        if (command.Length > 100)
        {
            const string marker = "...[foxwarm: command middle omitted]...";
            var head = (int)Math.Ceiling((100 - marker.Length) * 0.6);
            command = command[..head] + marker + command[^(100 - marker.Length - head)..];
        }
        var node = Text(entry, "nodeId");
        var error = Text(status, "error");
        return $"Background Process Finished\nexecId: {Text(entry, "id")}\ncommand: `{command.Replace("`", "\\`", StringComparison.Ordinal)}`{(node is not null && node != "master" ? $"\nNode: `{node}`" : "")}\nExit code: {status["exitCode"]?.ToJsonString() ?? "unknown"}\nDuration: {CompletedDuration(entry, status)}{(error is null ? "" : "\nError: " + error)}\nCommand output in {Text(entry, "logPath")}";
    }

    private static async Task<string> ProcessTree(int root)
    {
        var heading =
            $"Process tree (best-effort live snapshot; managed shell-script root PID {root}):";
        try
        {
            var start = new ProcessStartInfo(OperatingSystem.IsWindows() ? "powershell.exe" : "ps")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            foreach (
                var argument in OperatingSystem.IsWindows()
                    ? new[]
                    {
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $items = @(Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;cmdline=$(if ($_.CommandLine) {[string]$_.CommandLine} else {[string]$_.Name})} }); ConvertTo-Json -InputObject $items -Compress",
                    }
                    : new[] { "-A", "-o", "pid=", "-o", "ppid=", "-o", "command=" }
            )
                start.ArgumentList.Add(argument);
            using var process =
                Process.Start(start) ?? throw new IOException("Process inspection failed");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            string output;
            try
            {
                var buffer = new char[1048577];
                var count = 0;
                var errors = process.StandardError.ReadToEndAsync(timeout.Token);
                while (count < buffer.Length)
                {
                    var read = await process.StandardOutput.ReadAsync(
                        buffer.AsMemory(count),
                        timeout.Token
                    );
                    if (read == 0)
                        break;
                    count += read;
                }
                if (count > 1048576)
                    throw new IOException("Process snapshot exceeded limit");
                await process.WaitForExitAsync(timeout.Token);
                await errors;
                if (process.ExitCode != 0)
                    throw new IOException("Process inspection failed");
                output = new string(buffer, 0, count);
            }
            finally
            {
                if (!process.HasExited)
                    process.Kill(true);
            }
            var items = new Dictionary<int, (int Parent, string Command)>();
            if (OperatingSystem.IsWindows())
            {
                var parsed = JsonNode.Parse(output);
                foreach (
                    var item in (parsed as JsonArray ?? new JsonArray(parsed)).OfType<JsonObject>()
                )
                    items.TryAdd(
                        (int)Number(item["pid"]),
                        ((int)Number(item["parentPid"]), Text(item, "cmdline") ?? "")
                    );
            }
            else
                foreach (var line in output.Split('\n'))
                {
                    var match = Regex.Match(line, "^\\s*(\\d+)\\s+(\\d+)\\s*(.*)$");
                    if (match.Success)
                        items.TryAdd(
                            int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture),
                            (
                                int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture),
                                match.Groups[3].Value
                            )
                        );
                }
            if (!items.ContainsKey(root))
                return heading
                    + "\n(Process tree unavailable: the root process was no longer visible during inspection.)";
            var lines = new List<string>();
            var visited = new HashSet<int>();
            var pending = new Stack<(int Pid, int Depth)>();
            pending.Push((root, 0));
            while (pending.TryPop(out var current))
            {
                if (!visited.Add(current.Pid))
                    continue;
                if (lines.Count < 40)
                {
                    var command = Compact(items[current.Pid].Command);
                    if (command.Length == 0)
                        command = "[cmdline unavailable]";
                    var characters = command.EnumerateRunes().ToArray();
                    if (characters.Length > 100)
                        command =
                            string.Concat(characters.Take(99).Select(value => value.ToString()))
                            + "…";
                    lines.Add(
                        new string(' ', Math.Min(current.Depth * 2, 20))
                            + $"PID {current.Pid}: {command}"
                    );
                }
                foreach (
                    var child in items
                        .Where(pair => pair.Value.Parent == current.Pid)
                        .OrderByDescending(pair => pair.Key)
                )
                    pending.Push((child.Key, current.Depth + 1));
            }
            if (visited.Count > 40)
                lines.Add(
                    $"[foxwarm: {visited.Count - 40} additional descendant process(es) omitted]"
                );
            return heading + "\n" + string.Join('\n', lines);
        }
        catch (Exception)
        {
            return heading
                + "\n(Process tree unavailable: process inspection failed or is unsupported on this platform.)";
        }
    }
}
