using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

// CLI registry and publication authority, deliberately separate from Main's local exec owner.
internal sealed partial class NodeExecManager(
    NodePaths paths,
    string registryPath,
    Func<JsonObject, JsonObject, string, Task> deliver
) : IAsyncDisposable
{
    internal const long RetentionMilliseconds = 24 * 60 * 60 * 1000;
    internal const string MissingStatusError = "Process exited but no status file was written.";
    private readonly ConcurrentDictionary<string, JsonObject> entries = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim mutation = new(1, 1);
    private readonly HashSet<string> reserved = new(StringComparer.Ordinal);
    private readonly List<string> recent = [];
    private readonly object initializationGate = new();
    private Task? initialization;
    private Task? reconciliation;
    private readonly CancellationTokenSource shutdown = new();
    internal Func<long> Now { get; init; } = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    internal bool ExternalNamespace { get; init; }
    internal Action? TrackingExpired { get; init; }
    internal Action? RegistryIdle { get; init; }
    internal Action? BeforeLaunch { get; init; }
    internal Func<ProcessStartInfo, int> Launch { get; init; } = ExecNative.Start;

    internal static string? Text(JsonObject entry, string key) => NodeFileTools.Text(entry[key]);

    internal static double Number(JsonNode? value) =>
        value is not JsonValue scalar ? double.NaN
        : scalar.TryGetValue<double>(out var number) ? number
        : scalar.TryGetValue<long>(out var integer) ? integer
        : scalar.TryGetValue<int>(out var small) ? small
        : double.NaN;

    internal static bool SupportedId(string id) =>
        Regex.IsMatch(id, "^[a-z]+-[a-z]+$", RegexOptions.CultureInvariant)
        || Regex.IsMatch(id, "^exec_[A-Za-z0-9_-]{8,160}$", RegexOptions.CultureInvariant);

    internal JsonObject[] Tracked =>
        entries.Values.Select(value => (JsonObject)value.DeepClone()).ToArray();

    internal Task Initialize()
    {
        lock (initializationGate)
            return initialization ??= InitializeOnce();
    }

    private async Task InitializeOnce()
    {
        try
        {
            if (JsonNode.Parse(await File.ReadAllTextAsync(registryPath)) is JsonObject data)
            {
                if (data["recentExecIds"] is JsonArray ids)
                    recent.AddRange(
                        ids.Select(NodeFileTools.Text)
                            .OfType<string>()
                            .Where(SupportedId)
                            .Distinct(StringComparer.Ordinal)
                            .TakeLast(1024)
                    );
                foreach (var raw in (data["execs"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    var id = Text(raw, "id");
                    if (
                        id is null
                        || !SupportedId(id)
                        || raw.ContainsKey("backend")
                        || (
                            raw.ContainsKey("externalOwner")
                            && (
                                !ExternalNamespace
                                || raw["externalOwner"] is not JsonObject owner
                                || Text(owner, "kind") != "external"
                                || string.IsNullOrEmpty(Text(owner, "externalId"))
                                || string.IsNullOrEmpty(Text(owner, "contextId"))
                            )
                        )
                        || Text(raw, "logPath") is null
                        || Text(raw, "statusPath") is null
                        || !double.IsFinite(Number(raw["startedAt"]))
                        || !double.IsFinite(Number(raw["pid"]))
                    )
                        continue;
                    var entry = (JsonObject)raw.DeepClone();
                    if (entry["externalOwner"] is not null)
                        entry.Remove("agentName");
                    else
                        entry["agentName"] = string.IsNullOrWhiteSpace(Text(entry, "agentName"))
                            ? "main"
                            : Text(entry, "agentName");
                    entry["initialCwd"] = string.IsNullOrWhiteSpace(Text(entry, "initialCwd"))
                        ? paths.StartupDirectory
                        : Text(entry, "initialCwd");
                    entry["nodeId"] = string.IsNullOrWhiteSpace(Text(entry, "nodeId"))
                        ? Environment.GetEnvironmentVariable("FOXWARM_NODE_ID") ?? "remote-node"
                        : Text(entry, "nodeId");
                    entry["command"] = Text(entry, "command") ?? "";
                    entry["cwdPath"] = string.IsNullOrWhiteSpace(Text(entry, "cwdPath"))
                        ? Text(entry, "logPath") + ".cwd.txt"
                        : Text(entry, "cwdPath");
                    if (!NodeFileTools.Flag(entry, "notifyOnCompletion"))
                    {
                        entry["notifyOnCompletion"] = true;
                        entry["recoveredAfterRestart"] = true;
                    }
                    entries[id] = entry;
                }
                await Save();
            }
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (System.Text.Json.JsonException)
        {
            Console.Error.WriteLine("[exec_registry] Invalid running exec registry");
        }
        await Reconcile();
        reconciliation = ReconcileLoop();
    }

    private async Task Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(registryPath)!);
        var temporary =
            registryPath
            + "."
            + Environment.ProcessId
            + "."
            + Guid.NewGuid().ToString("N")
            + ".tmp";
        try
        {
            await File.WriteAllTextAsync(
                temporary,
                new JsonObject
                {
                    ["execs"] = new JsonArray(
                        entries.Values.Select(entry => entry.DeepClone()).ToArray()
                    ),
                    ["recentExecIds"] = new JsonArray(
                        recent.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                    ),
                }.ToJsonString(new() { WriteIndented = true })
            );
            File.Move(temporary, registryPath, true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private async Task Mutate(Action action)
    {
        await mutation.WaitAsync();
        try
        {
            action();
            await Save();
        }
        finally
        {
            mutation.Release();
        }
    }

    internal async Task<JsonObject> Start(
        JsonObject frame,
        string? agent,
        string node,
        CancellationToken stop,
        Action started
    )
    {
        await Initialize();
        var args = frame["args"] as JsonObject ?? new JsonObject();
        var command =
            Text(args, "command")
            ?? (args["command"] is JsonObject ? "[object Object]" : args["command"]?.ToJsonString())
            ?? "";
        if (string.IsNullOrWhiteSpace(command))
            throw new InvalidDataException("exec requires command");
        var requested = Text(frame, "backgroundExecId");
        string id;
        await mutation.WaitAsync();
        try
        {
            if (requested is not null && !SupportedId(requested))
                throw new InvalidDataException(
                    "Persistent exec ID must be a lowercase adjective+noun petname such as `quiet-otter` or a supported legacy `exec_...` ID."
                );
            id = requested ?? "";
            for (var attempt = 0; ; attempt++)
            {
                if (requested is null)
                    id =
                        ExecPetnames.Adjectives[
                            System.Security.Cryptography.RandomNumberGenerator.GetInt32(
                                ExecPetnames.Adjectives.Length
                            )
                        ]
                        + "-"
                        + ExecPetnames.Nouns[
                            System.Security.Cryptography.RandomNumberGenerator.GetInt32(
                                ExecPetnames.Nouns.Length
                            )
                        ];
                if (!entries.ContainsKey(id) && !reserved.Contains(id) && !recent.Contains(id))
                    break;
                if (requested is not null)
                    throw new ExecCollisionException(id);
                if (attempt >= 127)
                    throw new InvalidDataException(
                        "Persistent exec petname space did not yield a unique ID after 128 attempts."
                    );
            }
            reserved.Add(id);
        }
        finally
        {
            mutation.Release();
        }
        try
        {
            if (agent is not null)
                Directory.CreateDirectory(Path.Combine(paths.AgentDirectory(agent), "tmp"));
            var (cwd, raw, source) = paths.ExecCwd(
                args["cwd"],
                Text(frame, "sessionCwd"),
                agent,
                node
            );
            var date = DateTime.Now;
            var directory = Path.Combine(
                agent is null
                    ? Path.Combine(Path.GetDirectoryName(registryPath)!, "logs")
                    : Path.GetDirectoryName(registryPath)!,
                date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            );
            Directory.CreateDirectory(directory);
            var token = date.ToString("HHmmssfff", CultureInfo.InvariantCulture);
            var windows = OperatingSystem.IsWindows();
            var script = Path.Combine(directory, id + ".command" + (windows ? ".ps1" : ".sh"));
            var pathsFile = Path.Combine(directory, id + ".paths.json");
            var userScript = Path.Combine(directory, id + ".user.ps1");
            if (windows)
                await File.WriteAllTextAsync(
                    userScript,
                    command + (command.EndsWith('\n') ? "" : "\n"),
                    new System.Text.UTF8Encoding(true)
                );
            await File.WriteAllTextAsync(
                script,
                windows
                    ? NativeExecScripts.Windows
                    : NativeExecScripts.Unix(ExecNative.SelfCommand)
                        + "\n"
                        + command
                        + (command.EndsWith('\n') ? "" : "\n"),
                new System.Text.UTF8Encoding(windows)
            );
            if (!windows)
                File.SetUnixFileMode(
                    script,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                );
            var launch = ExecNative.Launcher(script, cwd);
            foreach (var key in launch.Environment.Keys.ToArray())
                if ((windows ? key.ToLowerInvariant() : key) is "fw_agentdir" or "fw_tmp")
                    launch.Environment.Remove(key);
            if (agent is not null)
            {
                launch.Environment["fw_agentdir"] = paths.AgentDirectory(agent);
                launch.Environment["fw_tmp"] = Path.Combine(paths.AgentDirectory(agent), "tmp");
            }
            launch.Environment["TERM"] = "xterm-256color";
            launch.Environment["FOXWARM_EXEC_LOG_DIR"] = directory;
            launch.Environment["FOXWARM_EXEC_TIME_TOKEN"] = token;
            launch.Environment["FOXWARM_EXEC_PATHS_PATH"] = pathsFile;
            var windowsLog = windows ? Path.Combine(directory, token + "_" + id + ".log") : null;
            if (windows)
            {
                launch.Environment["FOXWARM_EXEC_COMMAND_PATH"] = userScript;
                launch.Environment["FOXWARM_EXEC_LOG_PATH"] = windowsLog;
                launch.Environment["FOXWARM_EXEC_STATUS_PATH"] = windowsLog + ".exit.json";
                launch.Environment["FOXWARM_EXEC_CWD_PATH"] = windowsLog + ".cwd.txt";
            }
            BeforeLaunch?.Invoke();
            if (stop.IsCancellationRequested)
                throw new InvalidDataException(
                    "Exec was not started because Stop or Run queued cancelled it; the command was not executed."
                );
            var time = Now();
            var pid = Launch(launch);
            started();
            var log = windowsLog ?? Path.Combine(directory, token + "_pid" + pid + ".log");
            var discovered = windows ? new JsonObject() : await ReadPaths(pathsFile);
            var entry = new JsonObject
            {
                ["id"] = id,
                ["pid"] = pid,
                ["nodeId"] = node,
                ["command"] = command,
                ["initialCwd"] = cwd,
                ["cwdSource"] = source,
                ["logPath"] = Text(discovered, "logPath") ?? log,
                ["statusPath"] = Text(discovered, "statusPath") ?? log + ".exit.json",
                ["cwdPath"] = Text(discovered, "cwdPath") ?? log + ".cwd.txt",
                ["startedAt"] = time,
                ["notifyOnCompletion"] = false,
            };
            if (agent is null)
                entry["externalOwner"] = frame["owner"]!.DeepClone();
            else
            {
                entry["sessionId"] = Text(frame, "sessionId") ?? Text(args, "sessionId") ?? "node";
                entry["agentName"] = agent;
            }
            if (raw is not null)
                entry["cwdRaw"] = raw;
            if (Text(frame, "completionCapability") is { } capability)
                entry["completionCapability"] = capability;
            await Mutate(() => entries[id] = entry);
            return entry;
        }
        finally
        {
            await mutation.WaitAsync();
            try
            {
                reserved.Remove(id);
            }
            finally
            {
                mutation.Release();
            }
        }
    }

    private static async Task<JsonObject> ReadPaths(string file)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 1000)
        {
            try
            {
                if (
                    JsonNode.Parse(await File.ReadAllTextAsync(file)) is JsonObject paths
                    && Text(paths, "logPath") is not null
                    && Text(paths, "statusPath") is not null
                    && Text(paths, "cwdPath") is not null
                )
                {
                    File.Delete(file);
                    return paths;
                }
            }
            catch (FileNotFoundException) { }
            catch (System.Text.Json.JsonException) { }
            await Task.Delay(25);
        }
        return new();
    }

    internal async Task<JsonObject?> Status(JsonObject entry)
    {
        var file = Text(entry, "statusPath")!;
        try
        {
            var raw = (JsonObject)JsonNode.Parse(await File.ReadAllTextAsync(file))!;
            var result = new JsonObject
            {
                ["exitCode"] = double.IsFinite(Number(raw["exitCode"]))
                    ? raw["exitCode"]!.DeepClone()
                    : null,
                ["finishedAt"] = Text(raw, "finishedAt") is { Length: > 0 } finished
                    ? finished
                    : DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            };
            if (Text(raw, "finishedAt") is not { Length: > 0 })
                result["finishedAtIsEstimated"] = true;
            if (Text(raw, "error") is { } error)
                result["error"] = error;
            return result;
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        { }
        if (
            ExecNative.IsRunning(checked((int)Number(entry["pid"])))
            || Now() - Number(entry["startedAt"]) < 3000
        )
            return null;
        var fallback = new JsonObject
        {
            ["exitCode"] = null,
            ["finishedAt"] = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            ["error"] = MissingStatusError,
        };
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + ".tmp." + Environment.ProcessId + "." + Guid.NewGuid().ToString("N");
        await File.WriteAllTextAsync(temporary, fallback.ToJsonString());
        File.Move(temporary, file, true);
        return fallback;
    }

    internal async Task<JsonObject?> Wait(JsonObject entry, double seconds, CancellationToken stop)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed.TotalSeconds < seconds)
        {
            if (!entries.ContainsKey(Text(entry, "id")!))
                return null;
            var status = await Status(entry); // Native completion wins over Stop at the same observation.
            if (status is not null)
                return status;
            if (stop.IsCancellationRequested)
                return null;
            try
            {
                await Task.Delay(
                    TimeSpan.FromMilliseconds(
                        Math.Min(
                            250,
                            Math.Max(0, seconds * 1000 - deadline.Elapsed.TotalMilliseconds)
                        )
                    ),
                    stop
                );
            }
            catch (OperationCanceledException) { }
        }
        return null;
    }

    internal Task Background(JsonObject entry) =>
        Mutate(() =>
        {
            var clone = (JsonObject)entry.DeepClone();
            clone["notifyOnCompletion"] = true;
            entries[Text(entry, "id")!] = clone;
        });

    internal async Task Remove(JsonObject entry)
    {
        await Mutate(() =>
        {
            var id = Text(entry, "id")!;
            entries.TryRemove(id, out _);
            if (!recent.Contains(id))
                recent.Add(id);
            if (recent.Count > 1024)
                recent.RemoveRange(0, recent.Count - 1024);
        });
        if (entries.IsEmpty)
            RegistryIdle?.Invoke();
    }

    internal async Task Reconcile()
    {
        await Task.WhenAll(
            entries.Values.Select(async entry =>
            {
                if (!NodeFileTools.Flag(entry, "notifyOnCompletion"))
                    return;
                try
                {
                    if (Now() - Number(entry["startedAt"]) > RetentionMilliseconds)
                    {
                        TrackingExpired?.Invoke();
                        await Remove(entry);
                        return;
                    }
                    var status = await Status(entry);
                    if (status is null)
                        return;
                    await deliver(entry, status, Completion(entry, status));
                    await Remove(entry);
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("[exec_retry] " + error.GetType().Name);
                }
            })
        );
    }

    private async Task ReconcileLoop()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(shutdown.Token))
                await Reconcile();
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
    }

    private Task? disposal;

    public ValueTask DisposeAsync()
    {
        lock (initializationGate)
            return new ValueTask(disposal ??= DisposeOnce());
    }

    private async Task DisposeOnce()
    {
        shutdown.Cancel();
        if (initialization is not null)
            await initialization;
        if (reconciliation is not null)
            await reconciliation;
        await mutation.WaitAsync();
        mutation.Release();
        shutdown.Dispose();
    }
}

internal sealed class ExecCollisionException(string id)
    : IOException(
        $"Persistent exec `{id}` already exists or is retained as a recent completion identity."
    );
