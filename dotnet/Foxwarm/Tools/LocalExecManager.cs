using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;

namespace Foxwarm.Tools;

/// <summary>Main's persistent native and primitive-provider exec owner. Cwd is not an OS sandbox.</summary>
internal sealed partial class LocalExecManager : IAsyncDisposable
{
    internal static bool IsSupported => ExecNative.Supported;
    private readonly string registryPath;
    private readonly Func<string, string> workspaceForSession;
    private readonly Func<string, string> agentForSession;
    private readonly Func<string, string> resolveLifetime;
    private readonly Func<string, string, string, Task> notify;
    private readonly ConcurrentDictionary<string, ExecRecord> pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> completionGates = new(
        StringComparer.Ordinal
    );
    private readonly SemaphoreSlim mutation = new(1, 1);
    private readonly SemaphoreSlim reconciliation = new(1, 1);
    private readonly HashSet<string> reserved = new(StringComparer.Ordinal);
    private readonly List<string> recent = [];
    private readonly object initializationGate = new();
    private Task? registration;
    private CancellationTokenSource? reconcileStop;
    private Task? reconcileTask;
    private volatile bool closing;
    internal Func<long> Now { get; init; } = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    internal Func<string, string, bool>? RemoteIdentityReserved { get; set; }
    internal Func<string, string, ProviderExecBackend>? ResolveProviderBackend { get; set; }
    internal JsonObject[] Tracked => pending.Values.Select(record => record.ToJson()).ToArray();

    private sealed record ExecRecord(
        string SessionId,
        string Id,
        string Command,
        string Cwd,
        string AgentName,
        string NodeId,
        string LogPath,
        long StartedAt,
        bool Notify,
        long? Pid = null,
        string? StatusPath = null,
        string? CwdPath = null,
        string? CwdRaw = null,
        string? CwdSource = null,
        bool Recovered = false,
        string? ProcessStartTicks = null,
        string? ProviderId = null,
        string? Reference = null,
        string? CompletionCapability = null
    )
    {
        internal ExecObservation Observation { get; init; } = new();

        internal JsonObject ToJson()
        {
            var value = new JsonObject
            {
                ["id"] = Id,
                ["sessionId"] = SessionId,
                ["agentName"] = AgentName,
                ["nodeId"] = NodeId,
                ["command"] = Command,
                ["initialCwd"] = Cwd,
                ["logPath"] = LogPath,
                ["startedAt"] = StartedAt,
                ["notifyOnCompletion"] = Notify,
            };
            if (Pid is not null)
                value["pid"] = Pid;
            if (StatusPath is not null)
                value["statusPath"] = StatusPath;
            if (CwdPath is not null)
                value["cwdPath"] = CwdPath;
            if (CwdRaw is not null)
                value["cwdRaw"] = CwdRaw;
            if (CwdSource is not null)
                value["cwdSource"] = CwdSource;
            if (Recovered)
                value["recoveredAfterRestart"] = true;
            if (ProcessStartTicks is not null)
                value["processStartTicks"] = ProcessStartTicks;
            if (ProviderId is not null)
                value["backend"] = new JsonObject
                {
                    ["providerId"] = ProviderId,
                    ["ref"] = Reference,
                };
            if (Observation.Cwd is string cwd)
                value["resolvedCwd"] = cwd;
            if (CompletionCapability is not null)
                value["completionCapability"] = CompletionCapability;
            return value;
        }
    }

    private sealed class ExecObservation
    {
        internal string? Cwd;
        internal Task<JsonObject?>? Poll;
    }

    internal LocalExecManager(
        string dataRoot,
        Func<string, string> workspaceForSession,
        Func<string, string, string, Task> notify,
        Func<string, string>? resolveLifetime = null,
        Func<string, string>? agentForSession = null
    )
    {
        registryPath = Path.Combine(Path.GetFullPath(dataRoot), "state", "running-exec.json");
        this.workspaceForSession = workspaceForSession;
        this.notify = notify;
        this.resolveLifetime = resolveLifetime ?? (id => id);
        this.agentForSession = agentForSession ?? (_ => "main");
    }

    internal void RebindIdentity(string oldId, string newId) =>
        completionGates[newId] = completionGates.GetOrAdd(oldId, _ => new(1, 1));

    internal string[] OwnerIds =>
        pending
            .Values.Select(record => resolveLifetime(record.SessionId))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    internal bool IsOwnedActive(string sessionId, string execId) =>
        pending.TryGetValue(execId, out var record)
        && resolveLifetime(record.SessionId) == sessionId;

    internal void BeginShutdown() => closing = true;

    internal async Task InitializeAsync(Func<string, bool> hasSession)
    {
        await RegisterRecordsAsync(hasSession);
        await ReconcileNowAsync();
        StartReconciliation();
    }

    internal Task RegisterRecordsAsync(Func<string, bool> hasSession)
    {
        lock (initializationGate)
            return registration ??= LoadAsync(hasSession);
    }

    internal int TrackedCount => pending.Count;

    private async Task LoadAsync(Func<string, bool> hasSession)
    {
        if (!IsSupported)
            return;
        JsonObject? data;
        try
        {
            data = JsonNode.Parse(await File.ReadAllTextAsync(registryPath)) as JsonObject;
        }
        catch (FileNotFoundException)
        {
            return;
        }
        catch (DirectoryNotFoundException)
        {
            return;
        }
        catch (System.Text.Json.JsonException)
        {
            Console.Error.WriteLine("Failed to load running exec registry: invalid JSON.");
            return;
        }
        if (data is null)
            return;
        if (data["recentExecIds"] is JsonArray ids)
            recent.AddRange(
                ids.Select(value =>
                        value is JsonValue scalar && scalar.TryGetValue<string>(out var id)
                            ? id
                            : null
                    )
                    .OfType<string>()
                    .Where(SupportedId)
                    .Distinct(StringComparer.Ordinal)
                    .TakeLast(1024)
            );
        var changed = false;
        foreach (var raw in (data["execs"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var id = Text(raw, "id");
            var session = Text(raw, "sessionId");
            var log = Text(raw, "logPath");
            var started = SessionWait.Number(raw["startedAt"]);
            var backend = raw["backend"] as JsonObject;
            var provider = backend is null ? null : Text(backend, "providerId");
            var reference = backend is null ? null : Text(backend, "ref");
            var pid = SessionWait.Number(raw["pid"]);
            if (
                id is null
                || !SupportedId(id)
                || log is null
                || started is null
                || !double.IsFinite(started.Value)
                || raw.ContainsKey("externalOwner")
                || (raw.ContainsKey("backend") && (provider is null || reference is null))
                || (
                    provider is null
                    && (
                        Text(raw, "statusPath") is null
                        || pid is null
                        || !double.IsFinite(pid.Value)
                    )
                )
            )
                continue;
            if (session is null || !hasSession(resolveLifetime(session)))
                throw new InvalidDataException(
                    "Exec tracking references a missing or foreign Session authority."
                );
            var agent = Text(raw, "agentName") is { Length: > 0 } name ? name : "main";
            var record = new ExecRecord(
                session,
                id,
                Text(raw, "command") ?? "",
                Text(raw, "initialCwd") is { Length: > 0 } cwd
                    ? cwd
                    : workspaceForSession(resolveLifetime(session)),
                agent,
                Text(raw, "nodeId") is { Length: > 0 } node ? node : "master",
                log,
                checked((long)started.Value),
                true,
                pid is null ? null : checked((long)pid.Value),
                Text(raw, "statusPath"),
                Text(raw, "cwdPath") ?? log + ".cwd.txt",
                Text(raw, "cwdRaw"),
                Text(raw, "cwdSource"),
                raw["recoveredAfterRestart"]?.GetValue<bool>() == true
                    || raw["notifyOnCompletion"]?.GetValue<bool>() != true,
                Text(raw, "processStartTicks"),
                provider,
                reference,
                Text(raw, "completionCapability")
            );
            record.Observation.Cwd = Text(raw, "resolvedCwd");
            pending[id] = record;
            changed |= raw["notifyOnCompletion"]?.GetValue<bool>() != true;
        }
        if (changed)
            await SaveAsync();
    }

    private async Task SaveAsync()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(registryPath)!);
        await AtomicWriteAsync(
            registryPath,
            new JsonObject
            {
                ["execs"] = new JsonArray(
                    pending.Values.Select(record => (JsonNode)record.ToJson()).ToArray()
                ),
                ["recentExecIds"] = new JsonArray(
                    recent.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                ),
            }.ToJsonString(new() { WriteIndented = true }) + "\n"
        );
    }

    private async Task MutateAsync(Action action)
    {
        await mutation.WaitAsync();
        try
        {
            action();
            await SaveAsync();
        }
        finally
        {
            mutation.Release();
        }
    }

    private void Remove(ExecRecord record)
    {
        pending.TryRemove(record.Id, out _);
        if (!recent.Contains(record.Id))
            recent.Add(record.Id);
        if (recent.Count > 1024)
            recent.RemoveRange(0, recent.Count - 1024);
    }

    private Task FinalizeForegroundAsync(ExecRecord record) => MutateAsync(() => Remove(record));

    private async Task<ExecRecord> BackgroundAsync(ExecRecord record)
    {
        var updated = record with { Notify = true };
        await MutateAsync(() => pending[record.Id] = updated);
        return updated;
    }

    internal async Task RetireSessionAsync(string id)
    {
        var gate = completionGates.GetOrAdd(id, _ => new(1, 1));
        await gate.WaitAsync();
        try
        {
            await MutateAsync(() =>
            {
                foreach (
                    var record in pending.Values.Where(value =>
                        resolveLifetime(value.SessionId) == id
                    )
                )
                    Remove(record);
            });
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<string> ReserveAsync(string session)
    {
        await mutation.WaitAsync();
        try
        {
            for (var attempt = 0; attempt < 128; attempt++)
            {
                var id =
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
                if (
                    pending.ContainsKey(id)
                    || reserved.Contains(id)
                    || recent.Contains(id)
                    || RemoteIdentityReserved?.Invoke(session, id) == true
                )
                    continue;
                reserved.Add(id);
                return id;
            }
            throw new IOException(
                "Persistent exec petname space did not yield a unique ID after 128 attempts."
            );
        }
        finally
        {
            mutation.Release();
        }
    }

    internal async Task<JsonObject> ExecuteAsync(
        string sessionId,
        JsonObject? args,
        CancellationToken ct,
        MainNativePaths? paths = null,
        Action<string, string>? observeCwd = null,
        ToolScriptDataBudget? programmatic = null,
        Func<string>? cancellationSource = null,
        ProviderExecBackend? backend = null,
        string? providerCwd = null,
        Action? beforeLaunch = null,
        CancellationToken hardCancellation = default
    )
    {
        if (!IsSupported)
            return Error(
                "exec_unavailable",
                "Local shell execution is not supported on this platform. Select a supported Node."
            );
        if (closing)
            return Error("exec_unavailable", "Host is shutting down.");
        if (
            args is null
            || args.Count is < 1 or > 3
            || Text(args, "command") is not string command
            || (args.ContainsKey("cwd") && Text(args, "cwd") is null)
        )
            return Error(
                "invalid_tool_arguments",
                "exec requires command, optional cwd and optional timeout."
            );
        double seconds;
        string? warning;
        try
        {
            (seconds, warning) = ExecOutput.Timeout(args["timeout"]);
        }
        catch (InvalidDataException error)
        {
            return Error("invalid_tool_arguments", error.Message);
        }
        ct.ThrowIfCancellationRequested();
        paths ??= MainNativePaths.Default(workspaceForSession(sessionId));
        if (backend is not null && string.IsNullOrWhiteSpace(command))
            return Error("invalid_tool_arguments", "exec requires command.");
        string? cwd = Text(args, "cwd") ?? providerCwd;
        if (backend is null)
        {
            Directory.CreateDirectory(Path.Combine(paths.AgentDirectory, "tmp"));
            try
            {
                cwd = paths.ExecCwd(Text(args, "cwd"));
                ValidateCwd(cwd);
            }
            catch (ArgumentException error)
            {
                return Error("invalid_path", error.Message);
            }
        }
        else if (cwd is { Length: 0 })
            return Error("invalid_tool_arguments", "Exec cwd must be a non-empty string.");
        // A supported identity move may commit while reservation or start is awaiting a receipt.
        var agent = agentForSession(sessionId);
        var id = await ReserveAsync(sessionId);
        ExecRecord record;
        try
        {
            record = backend is null
                ? await StartNativeAsync(
                    sessionId,
                    agent,
                    id,
                    command,
                    cwd!,
                    paths,
                    Text(args, "cwd"),
                    ct,
                    beforeLaunch
                )
                : await StartProviderAsync(
                    sessionId,
                    agent,
                    id,
                    command,
                    cwd,
                    backend,
                    () =>
                    {
                        ct.ThrowIfCancellationRequested();
                        beforeLaunch?.Invoke();
                        hardCancellation.ThrowIfCancellationRequested();
                    },
                    hardCancellation
                );
            await MutateAsync(() => pending[record.Id] = record);
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
        var clock = Stopwatch.StartNew();
        var status = await WaitAsync(record, seconds, ct, hardCancellation);
        if (status is null)
        {
            var liveCwd = ReadLiveCwd(record);
            record = await BackgroundAsync(record);
            if (liveCwd is not null)
                observeCwd?.Invoke(record.Cwd, liveCwd);
        }
        using var output = CancellationTokenSource.CreateLinkedTokenSource(ct, hardCancellation);
        ExecOutput.Files? files = null;
        if (record.ProviderId is not null)
        {
            var budget = status is null
                ? TimeSpan.FromMilliseconds(500)
                : TimeSpan.FromSeconds(seconds) - clock.Elapsed;
            if (budget <= TimeSpan.Zero)
                output.Cancel();
            else
                output.CancelAfter(budget);
            files = ProviderOutput(record, providerCwd, output.Token);
        }
        try
        {
            var entry = record.ToJson();
            var text = status is null
                ? await ExecOutput.BackgroundOutput(
                    entry,
                    seconds,
                    warning,
                    ct.IsCancellationRequested || hardCancellation.IsCancellationRequested,
                    Now(),
                    cancellationSource?.Invoke(),
                    files
                )
                : await ExecOutput.Foreground(entry, status, warning, files);
            if (status is not null && await ReadFinishedCwdAsync(record) is string finalCwd)
                observeCwd?.Invoke(record.Cwd, finalCwd);
            return await ExecOutput.Result(
                entry,
                status,
                text,
                programmatic is not null,
                files,
                programmatic is null ? null : programmatic.Charge
            );
        }
        finally
        {
            if (status is not null)
                await FinalizeForegroundAsync(record);
        }
    }
}
