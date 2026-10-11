using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>Trusted single-host Linux exec with owned on-disk artifacts. Cwd is not an OS sandbox.</summary>
internal sealed partial class LocalExecManager : IAsyncDisposable
{
    private const int PageBytes = 16 * 1024;
    private const int DisplayChars = 16 * 1024;
    private readonly string directory;
    private readonly Func<string, string> workspaceForSession;
    private readonly Func<string, string> resolveLifetime;
    private readonly Func<string, string[]> historicalOwners;

    internal void RebindIdentity(string oldId, string newId)
    {
        var gate = completionGates.GetOrAdd(oldId, _ => new(1, 1));
        completionGates[newId] = gate;
    }

    private readonly ConcurrentDictionary<string, ExecRecord> pending = new(StringComparer.Ordinal);
    private readonly Func<string, string, string, Task> notify;
    private CancellationTokenSource? reconcileStop;
    private Task? reconcileTask;
    private volatile bool closing;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> completionGates = new(
        StringComparer.Ordinal
    );

    internal async Task RetireSessionAsync(string id)
    {
        var gate = completionGates.GetOrAdd(id, _ => new(1, 1));
        await gate.WaitAsync();
        try
        {
            foreach (
                var record in pending.Values.Where(record =>
                    resolveLifetime(record.SessionId) == id
                )
            )
            {
                File.Delete(Path.Combine(record.Directory, "tracking.json"));
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(record.Directory);
                pending.TryRemove(Key(record.SessionId, record.Id), out _);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private sealed record ExecRecord(
        string SessionId,
        string Id,
        string Command,
        string Cwd,
        int Pid,
        long StartedAt,
        string Directory,
        bool Notify,
        string? ProcessStartTicks = null
    );

    internal LocalExecManager(
        string dataRoot,
        Func<string, string> workspaceForSession,
        Func<string, string, string, Task> notify,
        Func<string, string>? resolveLifetime = null,
        Func<string, string[]>? historicalOwners = null
    )
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("Experimental persistent exec requires Linux.");
        directory = Path.Combine(Path.GetFullPath(dataRoot), "state", "exec");
        this.workspaceForSession = workspaceForSession;
        this.notify = notify;
        this.resolveLifetime = resolveLifetime ?? (id => id);
        this.historicalOwners = historicalOwners ?? (id => [id]);
        Directory.CreateDirectory(directory);
        SetPrivateMode(
            directory,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        );
    }

    internal async Task InitializeAsync(Func<string, bool> hasSession)
    {
        await RegisterRecordsAsync(hasSession);
        StartReconciliation();
    }

    internal string[] OwnerIds =>
        pending
            .Values.Select(record => resolveLifetime(record.SessionId))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    internal async Task RegisterRecordsAsync(Func<string, bool> hasSession)
    {
        foreach (
            var file in Directory.EnumerateFiles(
                directory,
                "tracking.json",
                SearchOption.AllDirectories
            )
        )
        {
            var path = Path.GetDirectoryName(file)!;
            var record = await ReadRecordAsync(path);
            if (
                !hasSession(resolveLifetime(record.SessionId))
                || !string.Equals(record.Id, Path.GetFileName(path), StringComparison.Ordinal)
                || !string.Equals(
                    SessionIdentity.ExecDirectorySegment(record.SessionId),
                    Path.GetFileName(Path.GetDirectoryName(path)),
                    StringComparison.Ordinal
                )
            )
                throw new InvalidDataException(
                    "Exec tracking references a missing or foreign Session authority."
                );
            // A clean restart may resume a command that was in its foreground wait at shutdown.
            if (!record.Notify)
            {
                record = record with { Notify = true };
                await AtomicWriteAsync(Path.Combine(path, "tracking.json"), "{\"notify\":true}\n");
            }
            pending[Key(record.SessionId, record.Id)] = record;
        }
    }

    internal void StartReconciliation()
    {
        reconcileStop = new CancellationTokenSource();
        reconcileTask = ReconcileAsync(reconcileStop.Token);
    }

    internal bool IsOwnedActive(string sessionId, string execId) =>
        pending.Values.Any(record =>
            record.Id == execId && resolveLifetime(record.SessionId) == sessionId
        );

    internal Func<string, string, bool>? RemoteIdentityReserved { get; set; }

    internal void BeginShutdown() => closing = true;

    internal async Task<JsonObject> ExecuteAsync(
        string sessionId,
        JsonObject? args,
        CancellationToken ct,
        MainNativePaths? paths = null,
        Action<string, string>? observeCwd = null,
        Foxwarm.ToolScript.ToolScriptDataBudget? programmatic = null
    )
    {
        if (closing)
            return Error("exec_unavailable", "Host is shutting down.");
        if (
            args is null
            || args.Count is < 1 or > 3
            || !String(args, "command", out var command)
            || (args.ContainsKey("cwd") && !String(args, "cwd", out _))
        )
            return Error(
                "invalid_tool_arguments",
                "exec requires command, optional cwd and optional timeout."
            );
        var seconds = 15.0;
        if (args.TryGetPropertyValue("timeout", out var timeoutNode))
        {
            if (
                timeoutNode is not JsonValue scalar
                || !scalar.TryGetValue<double>(out seconds)
                || !double.IsFinite(seconds)
                || seconds < 1
            )
                return Error(
                    "invalid_tool_arguments",
                    "timeout must be a finite number of at least 1 second."
                );
        }
        var warning =
            seconds > 60
                ? $"WARNING: Requested timeout {seconds.ToString(CultureInfo.InvariantCulture)}s exceeds the 60s maximum; using 60s.\n"
                : "";
        var waitSeconds = Math.Min(seconds, 60);
        paths ??= MainNativePaths.Default(workspaceForSession(sessionId));
        ct.ThrowIfCancellationRequested();
        Directory.CreateDirectory(Path.Combine(paths.AgentDirectory, "tmp"));
        string cwd;
        try
        {
            cwd = paths.ExecCwd(args["cwd"]?.GetValue<string>());
            ValidateCwd(cwd);
        }
        catch (ArgumentException error)
        {
            return Error("invalid_path", error.Message);
        }
        ct.ThrowIfCancellationRequested();
        var record = await StartAsync(sessionId, command, cwd, paths.AgentDirectory, ct);
        JsonObject? status = null;
        try
        {
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed.TotalSeconds < waitSeconds)
            {
                status = await ReadStatusAsync(record);
                if (status is not null)
                    break;
                await Task.Delay(100, ct);
            }
        }
        catch (OperationCanceledException)
        { /* A launched command survives Stop and is tracked below. */
        }
        status ??= await ReadStatusAsync(record);
        if (status is not null)
        {
            await FinalizeForegroundAsync(record);
            var preview = await PageAsync(record, 0, PageBytes);
            var trailer = preview["nextOffset"] is not null
                ? $"\nCommand output saved under execId: {record.Id}. Use read_exec for the complete log."
                : "";
            var exit =
                status["exitCode"]?.GetValue<int?>()?.ToString(CultureInfo.InvariantCulture)
                ?? "unknown";
            var finishedCwd = await ReadFinishedCwdAsync(record);
            if (finishedCwd is not null)
                observeCwd?.Invoke(record.Cwd, finishedCwd);
            var result = new JsonObject
            {
                ["output"] =
                    $"{preview["output"]?.GetValue<string>()}{trailer}\n---\nExit code: {exit}\nexecId: {record.Id}{(warning.Length > 0 ? "\n" + warning.TrimEnd() : "")}",
            };
            if (programmatic is not null)
                await AddProgrammaticAsync(result, record, status, programmatic);
            return result;
        }
        record = record with { Notify = true };
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "tracking.json"),
            "{\"notify\":true}\n"
        );
        pending[Key(sessionId, record.Id)] = record;
        var partial = await PageAsync(record, 0, 4096);
        var liveCwd = ReadLiveCwd(record);
        if (liveCwd is not null)
            observeCwd?.Invoke(record.Cwd, liveCwd);
        var running = new JsonObject
        {
            ["output"] =
                $"Partial Output:\n{partial["output"]?.GetValue<string>()}\n---\n{(ct.IsCancellationRequested ? "[Foreground wait ended by Stop or Run queued]" : $"[Process running longer than {waitSeconds.ToString(CultureInfo.InvariantCulture)}s]")} Switched to background. A completion event will arrive in this Session.\n{warning}execId: {record.Id}\nRead complete output with read_exec({{execId: \"{record.Id}\"}}).",
        };
        if (programmatic is not null)
            await AddProgrammaticAsync(running, record, null, programmatic);
        return running;
    }

    private static async Task AddProgrammaticAsync(
        JsonObject result,
        ExecRecord record,
        JsonObject? status,
        Foxwarm.ToolScript.ToolScriptDataBudget budget
    )
    {
        var path = Path.Combine(record.Directory, "output.log");
        result["status"] = status is null ? "running" : "completed";
        result["execId"] = record.Id;
        result["logPath"] = path;
        if (status is not null)
            result["exitCode"] = status["exitCode"]?.DeepClone();
        try
        {
            await using var log = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite,
                65536,
                FileOptions.Asynchronous
            );
            var length = log.Length;
            result["sizeBytes"] = length;
            result["truncated"] = length > 1048576;
            if (length <= 1048576)
            {
                budget.Charge(checked(8 * length + 65536));
                var bytes = new byte[(int)length];
                var read = 0;
                while (read < bytes.Length)
                {
                    var amount = await log.ReadAsync(bytes.AsMemory(read));
                    if (amount == 0)
                        break;
                    read += amount;
                }
                result["content"] = Encoding.UTF8.GetString(bytes.AsSpan(0, read));
            }
        }
        catch (FileNotFoundException)
        {
            result["truncated"] = true;
        }
    }

    internal async Task<JsonObject> ReadAsync(string sessionId, JsonObject? args)
    {
        if (
            args is null
            || args.Count is < 1 or > 2
            || !String(args, "execId", out var id)
            || !ValidId(id)
        )
            return Error(
                "invalid_tool_arguments",
                "read_exec requires a valid execId and optional offset."
            );
        long offset = 0;
        if (args.ContainsKey("offset"))
        {
            if (
                args["offset"] is not JsonValue value
                || !value.TryGetValue<long>(out offset)
                || offset < 0
            )
                return Error("invalid_tool_arguments", "offset must be a nonnegative integer.");
        }
        var candidates = historicalOwners(sessionId)
            .Select(owner =>
                Path.Combine(directory, SessionIdentity.ExecDirectorySegment(owner), id)
            )
            .Where(candidate => File.Exists(Path.Combine(candidate, "meta.json")))
            .ToArray();
        if (candidates.Length > 1)
            return Error(
                "exec_io_error",
                "Execution ID is ambiguous within this retained lifetime."
            );
        var path =
            candidates.FirstOrDefault()
            ?? Path.Combine(directory, SessionIdentity.ExecDirectorySegment(sessionId), id);
        if (!File.Exists(Path.Combine(path, "meta.json")))
            return Error("exec_not_found", "Execution was not found in this Session.");
        try
        {
            var record = await ReadRecordAsync(path);
            if (record.Id != id || resolveLifetime(record.SessionId) != sessionId)
                return Error("exec_not_found", "Execution was not found in this Session.");
            return await PageAsync(record, offset, PageBytes);
        }
        catch (IOException)
        {
            return Error("exec_io_error", "Execution log could not be read.");
        }
        catch (InvalidDataException)
        {
            return Error("exec_io_error", "Execution metadata is invalid.");
        }
        catch (JsonException)
        {
            return Error("exec_io_error", "Execution metadata is invalid.");
        }
    }

    private async Task<ExecRecord> StartAsync(
        string sessionId,
        string command,
        string cwd,
        string agentDirectory,
        CancellationToken ct
    )
    {
        var sessionDir = Path.Combine(directory, SessionIdentity.ExecDirectorySegment(sessionId));
        Directory.CreateDirectory(sessionDir);
        SetPrivateMode(
            sessionDir,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        );
        string id;
        string path;
        var reserved = false;
        for (var attempt = 0; attempt < 128; attempt++)
        {
            id =
                ExecPetnames.Adjectives[
                    RandomNumberGenerator.GetInt32(ExecPetnames.Adjectives.Length)
                ]
                + "-"
                + ExecPetnames.Nouns[RandomNumberGenerator.GetInt32(ExecPetnames.Nouns.Length)];
            if (RemoteIdentityReserved?.Invoke(sessionId, id) == true)
                continue;
            if (
                historicalOwners(sessionId)
                    .Any(owner =>
                        Directory.Exists(
                            Path.Combine(directory, SessionIdentity.ExecDirectorySegment(owner), id)
                        )
                    )
            )
                continue;
            path = Path.Combine(sessionDir, id);
            try
            {
                Directory.CreateDirectory(path);
            }
            catch (IOException)
            {
                continue;
            }
            SetPrivateMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
            // CreateDirectory is not exclusive: claim with CreateNew to reject every historical ID.
            try
            {
                using var claim = new FileStream(
                    Path.Combine(path, "claim"),
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                );
                reserved = true;
            }
            catch (IOException)
            {
                continue;
            }
            if (reserved)
                return await LaunchAsync(
                    new ExecRecord(
                        sessionId,
                        id,
                        command,
                        cwd,
                        0,
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        path,
                        false
                    ),
                    agentDirectory,
                    ct
                );
        }
        throw new IOException("Persistent exec ID allocation exhausted.");
    }

    private async Task<ExecRecord> LaunchAsync(
        ExecRecord allocated,
        string agentDirectory,
        CancellationToken ct
    )
    {
        var scriptPath = Path.Combine(allocated.Directory, "command.sh");
        // The wrapper owns its log/status descriptors and survives the ASP.NET host process.
        var wrapper =
            "#!/usr/bin/env bash\nset +e\nexec >> \"$FOXWARM_EXEC_LOG_PATH\" 2>&1\n"
            + "foxwarm_finalize() { code=$?; cwdtmp=\"$FOXWARM_EXEC_CWD_PATH.tmp.$$\"; pwd > \"$cwdtmp\"; mv \"$cwdtmp\" \"$FOXWARM_EXEC_CWD_PATH\"; tmp=\"$FOXWARM_EXEC_STATUS_PATH.tmp.$$\"; "
            + "printf '{\"exitCode\":%d,\"finishedAt\":\"%s\"}\\n' \"$code\" \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > \"$tmp\"; "
            + "mv \"$tmp\" \"$FOXWARM_EXEC_STATUS_PATH\"; }\ntrap foxwarm_finalize EXIT\n"
            + allocated.Command
            + (allocated.Command.EndsWith('\n') ? "" : "\n");
        await File.WriteAllTextAsync(scriptPath, wrapper, ct);
        SetPrivateMode(scriptPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        var start = new ProcessStartInfo("/bin/bash")
        {
            UseShellExecute = false,
            WorkingDirectory = allocated.Cwd,
        };
        start.ArgumentList.Add(scriptPath);
        // Retain the Main adapter's finite base before adding native reserved values.
        start.Environment.Clear();
        foreach (var key in new[] { "PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER" })
            if (Environment.GetEnvironmentVariable(key) is { Length: > 0 } value)
                start.Environment[key] = value;
        start.Environment["fw_agentdir"] = agentDirectory;
        start.Environment["fw_tmp"] = Path.Combine(agentDirectory, "tmp");
        if (!start.Environment.ContainsKey("PATH"))
            start.Environment["PATH"] = "/usr/bin:/bin";
        start.Environment["FOXWARM_EXEC_LOG_PATH"] = Path.Combine(
            allocated.Directory,
            "output.log"
        );
        start.Environment["FOXWARM_EXEC_STATUS_PATH"] = Path.Combine(
            allocated.Directory,
            "status.json"
        );
        start.Environment["FOXWARM_EXEC_CWD_PATH"] = Path.Combine(allocated.Directory, "cwd.txt");
        ct.ThrowIfCancellationRequested();
        using var process =
            Process.Start(start) ?? throw new IOException("Failed to launch shell.");
        var record = allocated with
        {
            Pid = process.Id,
            ProcessStartTicks = ReadProcessIdentity(process.Id).Ticks,
        };
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "meta.json"),
            JsonSerializer.Serialize(record) + "\n"
        );
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "tracking.json"),
            "{\"notify\":false}\n"
        );
        pending[Key(record.SessionId, record.Id)] = record;
        return record;
    }

    private static void ValidateCwd(string path)
    {
        if (!Directory.Exists(path))
            throw new ArgumentException(
                $"Cannot start exec: working directory is invalid (not an accessible directory). Resolved cwd: `{path}`."
            );
        if (Access(path, 5) != 0)
            throw new UnauthorizedAccessException(
                $"Cannot start exec: working directory is not readable/searchable: `{path}`."
            );
    }

    [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "access", SetLastError = true)]
    private static extern int Access(string path, int mode);

    private static async Task<string?> ReadFinishedCwdAsync(ExecRecord record)
    {
        var path = Path.Combine(record.Directory, "cwd.txt");
        if (!File.Exists(path))
            return null;
        var value = MainNativePaths.SessionGoalTrim(await File.ReadAllTextAsync(path));
        return value.Length > 0 ? value : null;
    }

    private static string? ReadLiveCwd(ExecRecord record)
    {
        var identity = ReadProcessIdentity(record.Pid);
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

    private static bool String(JsonObject args, string key, out string result)
    {
        result = "";
        return args[key] is JsonValue scalar && scalar.TryGetValue<string>(out result!);
    }

    private static bool ValidId(string id)
    {
        var dash = id.IndexOf('-');
        return dash > 0
            && dash < id.Length - 1
            && id.LastIndexOf('-') == dash
            && id.Where(ch => ch != '-').All(ch => ch is >= 'a' and <= 'z');
    }

    private static string Key(string sessionId, string id) => sessionId + "/" + id;

    private static void SetPrivateMode(string path, UnixFileMode mode)
    {
        if (OperatingSystem.IsLinux())
            File.SetUnixFileMode(path, mode);
    }

    private static JsonObject Error(string kind, string message) =>
        UnsupportedTurnToolExecutor.ToolError(kind, message);

    private static async Task AtomicWriteAsync(string path, string text)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, text);
            SetPrivateMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, true);
        }
        finally
        {
            if (File.Exists(temporary))
                File.Delete(temporary);
        }
    }

    private static async Task<ExecRecord> ReadRecordAsync(string path)
    {
        var record =
            JsonSerializer.Deserialize<ExecRecord>(
                await File.ReadAllTextAsync(Path.Combine(path, "meta.json"))
            ) ?? throw new InvalidDataException("Invalid exec metadata.");
        var trackingPath = Path.Combine(path, "tracking.json");
        var state = File.Exists(trackingPath)
            ? JsonNode.Parse(await File.ReadAllTextAsync(trackingPath)) as JsonObject
            : null;
        return record with
        {
            Directory = path,
            Notify = state?["notify"]?.GetValue<bool>() ?? false,
        };
    }

    private static async Task<JsonObject?> ReadStatusAsync(ExecRecord record)
    {
        var path = Path.Combine(record.Directory, "status.json");
        if (File.Exists(path))
            return JsonNode.Parse(await File.ReadAllTextAsync(path)) as JsonObject;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - record.StartedAt < 3000)
            return null;
        var observed = ReadProcessIdentity(record.Pid);
        if (
            observed.Ticks is not null
            && (record.ProcessStartTicks is null || observed.Ticks == record.ProcessStartTicks)
            && observed.State != 'Z'
        )
            return null;
        // PID reuse is observation only; never operate on the unrelated process.
        var fallback = new JsonObject
        {
            ["exitCode"] = null,
            ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            ["error"] = "Process exited but no status file was written.",
        };
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, fallback.ToJsonString());
            SetPrivateMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            try
            {
                File.Move(temporary, path);
            }
            catch (IOException) when (File.Exists(path))
            { /* The wrapper won the status race. */
            }
        }
        finally
        {
            if (File.Exists(temporary))
                File.Delete(temporary);
        }
        return JsonNode.Parse(await File.ReadAllTextAsync(path)) as JsonObject;
    }

    private static (string? Ticks, char State) ReadProcessIdentity(int pid)
    {
        try
        {
            var raw = File.ReadAllText($"/proc/{pid}/stat");
            var close = raw.LastIndexOf(')');
            if (close < 0 || close + 2 >= raw.Length)
                return (null, '?');
            var fields = raw[(close + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return fields.Length > 19 ? (fields[19], fields[0][0]) : (null, '?');
        }
        catch (IOException)
        {
            return (null, '?');
        }
        catch (UnauthorizedAccessException)
        {
            return (null, '?');
        }
    }

    private async Task<JsonObject> PageAsync(ExecRecord record, long offset, int byteCount)
    {
        var path = Path.Combine(record.Directory, "output.log");
        var status = await ReadStatusAsync(record);
        long size = 0;
        var output = new StringBuilder();
        long consumed = 0;
        if (File.Exists(path))
        {
            await using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite,
                8192,
                FileOptions.Asynchronous
            );
            size = stream.Length;
            if (offset < size)
            {
                stream.Position = offset;
                var bytes = new byte[(int)Math.Min(byteCount, size - offset)];
                var read = await stream.ReadAsync(bytes);
                var index = 0;
                while (index < read)
                {
                    var next = Render(bytes.AsSpan(index, read - index), out var used);
                    if (output.Length + next.Length > DisplayChars)
                        break;
                    output.Append(next);
                    index += used;
                }
                consumed = index;
            }
        }
        return new JsonObject
        {
            ["status"] = status is null ? "running" : "finished",
            ["exitCode"] = status?["exitCode"]?.DeepClone(),
            ["output"] = output.ToString(),
            ["offset"] = offset,
            ["nextOffset"] = offset + consumed < size ? offset + consumed : null,
            ["totalBytes"] = size,
        };
    }

    private static string Render(ReadOnlySpan<byte> data, out int used)
    {
        var value = data[0];
        if (value == '\n' || value == '\r' || value == '\t')
        {
            used = 1;
            return ((char)value).ToString();
        }
        if (value is >= 0x20 and <= 0x7e && value != '\\')
        {
            used = 1;
            return ((char)value).ToString();
        }
        var result = System.Text.Rune.DecodeFromUtf8(data, out var rune, out var consumed);
        if (result == System.Buffers.OperationStatus.Done && consumed > 1)
        {
            used = consumed;
            return rune.ToString();
        }
        used = 1;
        return "\\x" + value.ToString("X2", CultureInfo.InvariantCulture);
    }

    private async Task FinalizeForegroundAsync(ExecRecord record)
    {
        pending.TryRemove(Key(record.SessionId, record.Id), out _);
        var path = Path.Combine(record.Directory, "tracking.json");
        if (File.Exists(path))
            File.Delete(path);
        await Task.CompletedTask;
    }

    private async Task ReconcileAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(300));
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                if (closing)
                    continue;
                foreach (var record in pending.Values.Where(value => value.Notify))
                {
                    var completion = completionGates.GetOrAdd(
                        resolveLifetime(record.SessionId),
                        _ => new(1, 1)
                    );
                    await completion.WaitAsync(ct);
                    try
                    {
                        if (
                            !pending.TryGetValue(Key(record.SessionId, record.Id), out var current)
                            || !ReferenceEquals(current, record)
                        )
                            continue;
                        if (
                            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - record.StartedAt
                            > TimeSpan.FromHours(24).TotalMilliseconds
                        )
                        {
                            if (File.Exists(Path.Combine(record.Directory, "tracking.json")))
                                File.Delete(Path.Combine(record.Directory, "tracking.json"));
                            pending.TryRemove(Key(record.SessionId, record.Id), out _);
                            continue;
                        }
                        var status = await ReadStatusAsync(record);
                        if (status is null)
                            continue;
                        var code =
                            status["exitCode"]
                                ?.GetValue<int?>()
                                ?.ToString(CultureInfo.InvariantCulture)
                            ?? "unknown";
                        var message =
                            $"Background Process Finished\nexecId: {record.Id}\nExit code: {code}\nCommand output available with read_exec({{execId: \"{record.Id}\"}})";
                        await notify(record.SessionId, record.Id, message);
                        // A strict Session authority receipt now owns this event; remove only the active tracking flag.
                        if (File.Exists(Path.Combine(record.Directory, "tracking.json")))
                            File.Delete(Path.Combine(record.Directory, "tracking.json"));
                        pending.TryRemove(Key(record.SessionId, record.Id), out _);
                    }
                    catch (Exception)
                    { /* Keep tracking and retry after transient authority/host errors. */
                    }
                    finally
                    {
                        completion.Release();
                    }
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    public async ValueTask DisposeAsync()
    {
        closing = true;
        reconcileStop?.Cancel();
        if (reconcileTask is not null)
            await reconcileTask;
        reconcileStop?.Dispose();
    }
}
