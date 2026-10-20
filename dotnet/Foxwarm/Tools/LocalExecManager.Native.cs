using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    private async Task<ExecRecord> StartNativeAsync(
        string session,
        string agent,
        string id,
        string command,
        string cwd,
        MainNativePaths paths,
        string? requestedCwd,
        CancellationToken stop,
        Action? beforeLaunch
    )
    {
        var date = DateTime.Now;
        var directory = Path.Combine(
            paths.AgentDirectory,
            ".temp",
            "exec",
            date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
        );
        Directory.CreateDirectory(directory);
        var token = date.ToString("HHmmssfff", CultureInfo.InvariantCulture);
        var windows = OperatingSystem.IsWindows();
        var script = Path.Combine(directory, id + ".command" + (windows ? ".ps1" : ".sh"));
        var userScript = Path.Combine(directory, id + ".user.ps1");
        var pathsFile = Path.Combine(directory, id + ".paths.json");
        var self = ExecNative.SelfStart(typeof(LocalExecManager).Assembly);
        if (windows)
            await File.WriteAllTextAsync(
                userScript,
                command + (command.EndsWith('\n') ? "" : "\n"),
                new UTF8Encoding(true)
            );
        await File.WriteAllTextAsync(
            script,
            windows
                ? NativeExecScripts.Windows
                : NativeExecScripts.Unix(ExecNative.Command(self))
                    + "\n"
                    + command
                    + (command.EndsWith('\n') ? "" : "\n"),
            new UTF8Encoding(windows)
        );
        if (!windows)
            File.SetUnixFileMode(
                script,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
        var launch = ExecNative.Launcher(script, cwd, self);
        foreach (var key in launch.Environment.Keys.ToArray())
            if ((windows ? key.ToLowerInvariant() : key) is "fw_agentdir" or "fw_tmp")
                launch.Environment.Remove(key);
        launch.Environment["fw_agentdir"] = paths.AgentDirectory;
        launch.Environment["fw_tmp"] = Path.Combine(paths.AgentDirectory, "tmp");
        launch.Environment["TERM"] = "xterm-256color";
        launch.Environment["FOXWARM_EXEC_LOG_DIR"] = directory;
        launch.Environment["FOXWARM_EXEC_TIME_TOKEN"] = token;
        launch.Environment["FOXWARM_EXEC_PATHS_PATH"] = pathsFile;
        if (windows)
            launch.Environment["FOXWARM_EXEC_COMMAND_PATH"] = userScript;
        beforeLaunch?.Invoke();
        stop.ThrowIfCancellationRequested();
        var started = Now();
        using var process =
            Process.Start(launch)
            ?? throw new IOException("Failed to start background process: missing pid");
        var pid = process.Id;
        var discovered = await ReadPathsAsync(pathsFile);
        var log = Path.Combine(directory, token + "_pid" + pid + ".log");
        var raw = !string.IsNullOrWhiteSpace(requestedCwd) ? requestedCwd : paths.SessionCwd;
        raw = raw is null
            ? null
            : MainNativePaths.ExpandAgentToken(
                MainNativePaths.SessionGoalTrim(raw),
                paths.AgentDirectory
            );
        return new ExecRecord(
            session,
            id,
            command,
            cwd,
            agent,
            "master",
            discovered is null ? log : Text(discovered, "logPath")!,
            started,
            false,
            pid,
            discovered is null ? log + ".exit.json" : Text(discovered, "statusPath"),
            discovered is null ? log + ".cwd.txt" : Text(discovered, "cwdPath"),
            raw,
            !string.IsNullOrWhiteSpace(requestedCwd) ? "explicit"
                : !string.IsNullOrWhiteSpace(paths.SessionCwd) ? "session"
                : "default",
            ProcessStartTicks: NativeProcessFacts.ReadIdentity(pid).Ticks
        );
    }

    private static async Task<JsonObject?> ReadPathsAsync(string path)
    {
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 1000)
        {
            try
            {
                if (
                    JsonNode.Parse(await File.ReadAllTextAsync(path)) is JsonObject paths
                    && Text(paths, "logPath") is not null
                    && Text(paths, "statusPath") is not null
                    && Text(paths, "cwdPath") is not null
                )
                {
                    File.Delete(path);
                    return paths;
                }
            }
            catch (FileNotFoundException) { }
            catch (System.Text.Json.JsonException) { }
            await Task.Delay(25);
        }
        return null;
    }

    private static void ValidateCwd(string path)
    {
        if (!Directory.Exists(path))
            throw new ArgumentException(
                $"Cannot start exec: working directory is invalid (not an accessible directory). Resolved cwd: `{path}`."
            );
        if (!OperatingSystem.IsWindows() && NativeProcessFacts.Access(path, 5) != 0)
            throw new UnauthorizedAccessException(
                $"Cannot start exec: working directory is not readable/searchable: `{path}`."
            );
    }

    private static async Task<string?> ReadFinishedCwdAsync(ExecRecord record)
    {
        if (record.ProviderId is not null)
            return record.Observation.Cwd;
        try
        {
            var cwd = MainNativePaths.SessionGoalTrim(await File.ReadAllTextAsync(record.CwdPath!));
            return cwd.Length > 0 ? cwd : null;
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
    }

    private static string? ReadLiveCwd(ExecRecord record)
    {
        if (record.ProviderId is not null)
            return record.Observation.Cwd;
        if (OperatingSystem.IsWindows())
            return null;
        var identity = NativeProcessFacts.ReadIdentity(checked((int)record.Pid!));
        if (
            identity.Ticks is null
            || record.ProcessStartTicks is not null && identity.Ticks != record.ProcessStartTicks
        )
            return null;
        try
        {
            return new DirectoryInfo($"/proc/{record.Pid}/cwd").LinkTarget;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private async Task<JsonObject?> ReadStatusAsync(ExecRecord record)
    {
        if (record.ProviderId is not null)
            return await ProviderStatusAsync(record);
        var path = record.StatusPath!;
        try
        {
            if (JsonNode.Parse(await File.ReadAllTextAsync(path)) is JsonObject raw)
            {
                var status = new JsonObject
                {
                    ["exitCode"] =
                        Sessions.SessionWait.Number(raw["exitCode"]) is double exit
                        && double.IsFinite(exit)
                            ? JsonValue.Create(exit)
                            : null,
                    ["finishedAt"] = Text(raw, "finishedAt") is { Length: > 0 } finished
                        ? finished
                        : DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                };
                if (
                    Text(raw, "finishedAt") is not { Length: > 0 }
                    || raw["finishedAtIsEstimated"]?.GetValue<bool>() == true
                )
                    status["finishedAtIsEstimated"] = true;
                if (raw["durationMs"] is not null)
                    status["durationMs"] = raw["durationMs"]!.DeepClone();
                if (Text(raw, "error") is string error)
                    status["error"] = error;
                return status;
            }
            throw new InvalidDataException("Invalid native exec status.");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        var observed = NativeProcessFacts.ReadIdentity(checked((int)record.Pid!));
        if (
            observed.Ticks is not null
            && (record.ProcessStartTicks is null || observed.Ticks == record.ProcessStartTicks)
            && observed.State != 'Z'
        )
            return null;
        if (Now() - record.StartedAt < 3000)
            return null;
        var fallback = new JsonObject
        {
            ["exitCode"] = null,
            ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            ["error"] = ExecOutput.MissingStatusError,
        };
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await AtomicWriteAsync(path, fallback.ToJsonString());
        return fallback;
    }

    private static string? Text(JsonObject value, string key) => ExecOutput.Text(value, key);

    private static bool SupportedId(string id) =>
        Regex.IsMatch(id, "^[a-z]+-[a-z]+$", RegexOptions.CultureInvariant)
        || Regex.IsMatch(id, "^exec_[A-Za-z0-9_-]{8,160}$", RegexOptions.CultureInvariant);

    private static JsonObject Error(string kind, string message) =>
        UnsupportedTurnToolExecutor.ToolError(kind, message);

    private static async Task AtomicWriteAsync(string path, string text)
    {
        var temporary =
            path + "." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, text);
            File.Move(temporary, path, true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }
}
