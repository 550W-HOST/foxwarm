using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.CliNode;

internal sealed partial class NodeClient
{
    // Process-local result authority. Retained directories are loaded only by an actual new exec.
    private readonly object externalGate = new();
    private readonly Dictionary<string, ExternalRuntime> externalExecRuntimes = new(
        StringComparer.Ordinal
    );
    private readonly Dictionary<string, Timer> releasedExternalOwners = new(StringComparer.Ordinal);

    private sealed class ExternalRuntime(string root)
    {
        internal readonly string Root = root;
        internal NodeExecManager Manager = null!;
        internal readonly Dictionary<string, (string Output, string Cwd)> Completed = new(
            StringComparer.Ordinal
        );
        internal readonly List<string> CompletionOrder = [];
        internal bool Released;
        internal bool UncertainRunning;
        internal int Inflight;
        internal bool Cleaning;
    }

    private static string ExternalKey(JsonObject owner) =>
        Text(owner, "externalId") + "\0" + Text(owner, "contextId");

    private static bool ExternalOwner(Connection connection, JsonObject? owner) =>
        connection.Protocol == 3
        && owner is not null
        && Text(owner, "kind") == "external"
        && Text(owner, "externalId") is not null
        && Text(owner, "contextId") is not null;

    private async Task<JsonObject> ExecuteExternal(
        Connection connection,
        JsonObject frame,
        Action started
    )
    {
        ExternalRuntime? runtime = null;
        string? key = null;
        try
        {
            var owner = frame["owner"] as JsonObject;
            if (
                !ExternalOwner(connection, owner)
                || !Regex.IsMatch(
                    Text(owner!, "externalId")!,
                    "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
                    RegexOptions.CultureInvariant
                )
                || !Regex.IsMatch(
                    Text(owner!, "contextId")!,
                    "^[a-fA-F0-9-]{36}$",
                    RegexOptions.CultureInvariant
                )
                || owner!.Any(pair => pair.Key is not ("kind" or "externalId" or "contextId"))
                || frame.ContainsKey("sessionId")
                || frame.ContainsKey("agentName")
            )
                throw new InvalidDataException("External Node owner is unsupported or invalid.");
            var tool = Text(frame, "tool") ?? "";
            if (
                tool
                    is not (
                        "read"
                        or "write"
                        or "edit"
                        or "apply_patch"
                        or "exec"
                        or "get_default_cwd"
                    )
                || tool == "exec" && !ExecNative.Supported
                || options.ToolCallInterceptor is not null
            )
                throw new InvalidDataException("This external Node tool is not available.");
            var cwd = Text(frame, "sessionCwd") is { Length: > 0 } supplied
                ? supplied
                : paths.StartupDirectory;
            if (tool != "exec")
                return await tools.Execute(tool, frame["args"] as JsonObject, null, cwd, false);
            var id = Text(frame, "backgroundExecId");
            var capability = Text(frame, "completionCapability");
            if (
                id is null
                || !Regex.IsMatch(id, "^[a-z]+-[a-z]+$", RegexOptions.CultureInvariant)
                || string.IsNullOrEmpty(capability)
            )
                throw new InvalidDataException(
                    "External exec requires a reserved execution ID and signed completion capability."
                );
            key = ExternalKey(owner!);
            var found = GetExternalRuntime(owner!);
            await found.Manager.Initialize();
            lock (externalGate)
            {
                if (found.Released)
                    throw new InvalidDataException("External execution context has expired.");
                found.Inflight++;
                runtime = found;
            }
            var args = frame["args"] as JsonObject ?? new();
            var timeout = NodeExecManager.Timeout(args["timeout"]);
            var launchFrame = (JsonObject)frame.DeepClone();
            launchFrame["sessionCwd"] = cwd;
            // External calls have no Session Stop controller. Their original effect outlives HTTP/WS waits.
            var entry = await runtime.Manager.Start(
                launchFrame,
                null,
                nodeId ?? requestedName,
                CancellationToken.None,
                started
            );
            var status = await runtime.Manager.Wait(entry, timeout.Seconds, CancellationToken.None);
            if (status is not null)
            {
                try
                {
                    var output = await NodeExecManager.Foreground(entry, status, timeout.Warning);
                    var finalCwd = await NodeExecManager.ResolvedCwd(entry);
                    RememberExternal(runtime, id, output, finalCwd);
                    return new JsonObject
                    {
                        ["output"] = output,
                        ["execId"] = id,
                        ["background"] = false,
                        ["cwd"] = finalCwd,
                    };
                }
                finally
                {
                    await runtime.Manager.Remove(entry);
                }
            }
            await connection.Send(
                new JsonObject
                {
                    ["type"] = "external_exec_background",
                    ["owner"] = owner!.DeepClone(),
                    ["execId"] = id,
                    ["completionCapability"] = capability,
                }
            );
            await runtime.Manager.Background(entry);
            return new JsonObject
            {
                ["output"] = await runtime.Manager.BackgroundOutput(
                    entry,
                    timeout.Seconds,
                    timeout.Warning,
                    false
                ),
                ["execId"] = id,
                ["background"] = true,
            };
        }
        finally
        {
            if (runtime is not null)
            {
                lock (externalGate)
                    runtime.Inflight--;
                CleanupExternal(key!);
            }
        }
    }

    private ExternalRuntime GetExternalRuntime(JsonObject owner)
    {
        var key = ExternalKey(owner);
        lock (externalGate)
        {
            if (releasedExternalOwners.ContainsKey(key))
                throw new InvalidDataException("External execution context has expired.");
            if (externalExecRuntimes.TryGetValue(key, out var existing))
                return existing;
            var state = options.CredentialsFile is not null
                ? Path.GetDirectoryName(
                    Path.GetFullPath(options.CredentialsFile, paths.StartupDirectory)
                )!
                : Path.Combine(paths.StartupDirectory, "state");
            var root = Path.Combine(
                state,
                "external-exec",
                Convert.ToHexStringLower(
                    SHA256.HashData(Encoding.UTF8.GetBytes(Text(owner, "externalId")!))
                ),
                Text(owner, "contextId")!
            );
            var runtime = new ExternalRuntime(root);
            runtime.Manager = new NodeExecManager(
                paths,
                Path.Combine(root, "running.json"),
                async (entry, status, _) =>
                {
                    if (entry["externalOwner"] is not JsonObject entryOwner)
                        throw new InvalidDataException("External exec lacks its owner.");
                    lock (externalGate)
                        if (runtime.Released)
                            return;
                    var output = await NodeExecManager.Foreground(entry, status, null);
                    var cwd = await NodeExecManager.ResolvedCwd(entry);
                    RememberExternal(runtime, Text(entry, "id")!, output, cwd);
                    var active =
                        registeredConnection
                        ?? throw new IOException("Remote node is not connected to master");
                    await active.Request(
                        new JsonObject
                        {
                            ["type"] = "external_exec_completed",
                            ["owner"] = entryOwner.DeepClone(),
                            ["execId"] = entry["id"]!.DeepClone(),
                            ["completionCapability"] = entry["completionCapability"]?.DeepClone(),
                            ["output"] = output,
                            ["cwd"] = cwd,
                        }
                    );
                }
            )
            {
                ExternalNamespace = true,
                TrackingExpired = () =>
                {
                    lock (externalGate)
                        runtime.UncertainRunning = true;
                },
                RegistryIdle = () => CleanupExternal(key),
            };
            externalExecRuntimes.Add(key, runtime);
            return runtime;
        }
    }

    private void RememberExternal(ExternalRuntime runtime, string id, string output, string cwd)
    {
        lock (externalGate)
        {
            if (!runtime.Completed.ContainsKey(id))
                runtime.CompletionOrder.Add(id);
            runtime.Completed[id] = (output, cwd);
            if (runtime.CompletionOrder.Count > 20)
            {
                runtime.Completed.Remove(runtime.CompletionOrder[0]);
                runtime.CompletionOrder.RemoveAt(0);
            }
        }
    }

    private void ReleaseExternal(Connection connection, JsonObject? owner)
    {
        if (!ExternalOwner(connection, owner))
            return;
        var key = ExternalKey(owner!);
        lock (externalGate)
        {
            // Source's one-hour tombstone starts at the first release, not at every retry.
            if (!releasedExternalOwners.ContainsKey(key))
                releasedExternalOwners.Add(
                    key,
                    new Timer(
                        _ =>
                        {
                            lock (externalGate)
                                if (releasedExternalOwners.Remove(key, out var timer))
                                    timer.Dispose();
                        },
                        null,
                        TimeSpan.FromHours(1),
                        Timeout.InfiniteTimeSpan
                    )
                );
            if (externalExecRuntimes.TryGetValue(key, out var runtime))
            {
                runtime.Released = true;
                runtime.Completed.Clear();
                runtime.CompletionOrder.Clear();
            }
        }
        CleanupExternal(key);
    }

    private void CleanupExternal(string key)
    {
        ExternalRuntime runtime;
        lock (externalGate)
        {
            if (
                !externalExecRuntimes.TryGetValue(key, out runtime!)
                || !runtime.Released
                || runtime.Inflight > 0
                || runtime.UncertainRunning
                || runtime.Manager.Tracked.Length > 0
                || runtime.Cleaning
            )
                return;
            runtime.Cleaning = true;
        }
        // An idle callback can originate inside reconciliation; it cannot await its own shutdown.
        _ = Task.Run(async () =>
        {
            try
            {
                await runtime.Manager.DisposeAsync();
                if (runtime.Manager.Tracked.Length > 0)
                    return;
                if (Directory.Exists(runtime.Root))
                    Directory.Delete(runtime.Root, true);
                lock (externalGate)
                    if (externalExecRuntimes.GetValueOrDefault(key) == runtime)
                        externalExecRuntimes.Remove(key);
            }
            catch (Exception error)
            {
                Log("external_cleanup", error.GetType().Name);
            }
            finally
            {
                lock (externalGate)
                    runtime.Cleaning = false;
            }
        });
    }

    private void ScheduleExternalQuery(Connection connection, JsonObject frame)
    {
        var sequence = Interlocked.Increment(ref dispatchSequence);
        var task = Task.Run(() => QueryExternal(connection, frame));
        dispatches[sequence] = (task, true);
        _ = task.ContinueWith(
            _ =>
            {
                dispatches.TryRemove(sequence, out var removed);
            },
            TaskScheduler.Default
        );
    }

    private async Task QueryExternal(Connection connection, JsonObject frame)
    {
        var response = new JsonObject
        {
            ["type"] = "external_exec_result_response",
            ["requestId"] = frame["requestId"]?.DeepClone(),
        };
        try
        {
            var owner = frame["owner"] as JsonObject;
            var id = Text(frame, "execId");
            if (!ExternalOwner(connection, owner) || id is null)
                throw new InvalidDataException();
            ExternalRuntime runtime;
            lock (externalGate)
            {
                if (
                    !externalExecRuntimes.TryGetValue(ExternalKey(owner!), out runtime!)
                    || runtime.Released
                )
                    throw new InvalidDataException();
                if (runtime.Completed.TryGetValue(id, out var completed))
                    response["result"] = new JsonObject
                    {
                        ["state"] = "completed",
                        ["output"] = completed.Output,
                        ["cwd"] = completed.Cwd,
                    };
            }
            if (response["result"] is null)
            {
                var entry = runtime.Manager.Tracked.FirstOrDefault(entry =>
                    Text(entry, "id") == id
                );
                if (
                    entry?["externalOwner"] is not JsonObject entryOwner
                    || Text(entryOwner, "externalId") != Text(owner!, "externalId")
                    || Text(entryOwner, "contextId") != Text(owner!, "contextId")
                )
                    throw new InvalidDataException();
                var status = await runtime.Manager.Wait(entry, 0.020, CancellationToken.None);
                response["result"] = new JsonObject
                {
                    ["state"] = status is null ? "running" : "completed",
                    ["output"] = status is null
                        ? await runtime.Manager.BackgroundOutput(entry, 0, null, false)
                        : await NodeExecManager.Foreground(entry, status, null),
                    ["cwd"] = await NodeExecManager.ResolvedCwd(entry),
                };
            }
        }
        catch
        {
            response["error"] = "Execution is unavailable.";
        }
        await connection.Send(response);
    }
}
