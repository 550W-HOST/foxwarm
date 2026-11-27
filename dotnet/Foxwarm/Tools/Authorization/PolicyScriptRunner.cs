using System.ComponentModel;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.ToolScript;
using Monty.V1;

namespace Foxwarm.Tools;

/// <summary>
/// Evaluates deterministic, side-effect-free ToolScript policy generators in the packaged Monty
/// worker with all host calls, clock reads, sleeps, and unseeded entropy disabled.
/// </summary>
internal static class PolicyScriptRunner
{
    private const string TransientMarkerKey = "foxwarm.policyScript.transient";

    internal static InvalidDataException Transient(string message, System.Exception? inner = null)
    {
        var error = inner is null
            ? new InvalidDataException(message)
            : new InvalidDataException(message, inner);
        error.Data[TransientMarkerKey] = true;
        return error;
    }

    internal static bool IsTransient(System.Exception error) =>
        error is not InvalidDataException || error.Data.Contains(TransientMarkerKey);
    internal const int MaxScriptBytes = 64 * 1024;
    internal const ulong MaxMemoryBytes = 16 * 1024 * 1024;
    internal const ulong MaxRecursionDepth = 64;
    internal const ulong MaxCpuDurationMicros = 500_000;
    internal static readonly TimeSpan StartupWallClockLimit = TimeSpan.FromSeconds(15);
    internal static readonly TimeSpan WallClockLimit = TimeSpan.FromSeconds(2);
    internal const long MaxDataBudgetBytes = 4 * 1024 * 1024;

    private static readonly SemaphoreSlim Concurrency = new(2, 2);
    private static long compilationCount;

    // Test-only overrides for isolated determinism, timeout, and failure-recovery tests.
    internal static Func<string?>? BinaryOverride { get; set; }
    internal static Action? OnBeforeSpawn { get; set; }
    internal static TimeSpan? StartupWallClockOverride { get; set; }
    internal static TimeSpan? ExecutionWallClockOverride { get; set; }

    internal static long CompilationCount => Interlocked.Read(ref compilationCount);

    internal static string DefaultBinaryPath =>
        Path.Combine(
            AppContext.BaseDirectory,
            "ToolScript",
            "native",
            OperatingSystem.IsWindows() ? "monty.exe" : "monty"
        );

    internal static string ResolveBinary()
    {
        if (!MontyWorker.IsSupported)
            throw new InvalidDataException(
                "Policy scripts require the ToolScript Monty worker, which is not supported on this platform."
            );
        var path = BinaryOverride is not null ? BinaryOverride() : DefaultBinaryPath;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            throw Transient(
                "Policy scripts require the packaged ToolScript Monty worker, which is not installed."
            );
        return path;
    }

    internal static OsPolicy DeterministicOsPolicy() =>
        new()
        {
            CallHost = new Unit(),
            Timezone = new SandboxTimeZone { Utc = new Unit() },
            Sleep = new SleepMode { CallHost = new Unit() },
            RandomCallHost = new Unit(),
            Zero = new Unit(),
        };

    internal static ResourceLimits DeterministicLimits() =>
        new()
        {
            MaxMemoryBytes = MaxMemoryBytes,
            MaxRecursionDepth = MaxRecursionDepth,
            MaxSuspensions = 0,
            MaxFeedDurationMicros = MaxCpuDurationMicros,
        };

    /// <summary>
    /// Runs a pure policy generator script and returns its raw strict-JSON result (not yet
    /// rule-normalized). Primarily used by tests and by <see cref="EvaluateRulesAsync"/>.
    /// </summary>
    internal static async Task<JsonNode?> EvaluateRawAsync(
        string script,
        JsonNode? data,
        string scriptName = "policy-script",
        CancellationToken cancellationToken = default
    )
    {
        if (string.IsNullOrWhiteSpace(script))
            throw new InvalidDataException("Policy script must be a non-empty string.");
        if (Encoding.UTF8.GetByteCount(script) > MaxScriptBytes)
            throw new InvalidDataException(
                $"Policy script exceeds the {MaxScriptBytes}-byte limit."
            );
        var binary = ResolveBinary();
        await Concurrency.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Interlocked.Increment(ref compilationCount);

            var startupBudget = StartupWallClockOverride ?? StartupWallClockLimit;
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startup.CancelAfter(startupBudget);

            MontyWorker worker;
            try
            {
                OnBeforeSpawn?.Invoke();
                startup.Token.ThrowIfCancellationRequested();
                worker = new MontyWorker(binary);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw Transient(
                    "Policy script worker startup timed out before execution began."
                );
            }
            catch (System.Exception error)
                when (error is IOException or Win32Exception or InvalidOperationException)
            {
                throw Transient(
                    "Policy script worker failed to start: " + error.Message,
                    error
                );
            }

            await using (worker.ConfigureAwait(false))
            {
                WorkerEvent configured;
                try
                {
                    var budget = new ToolScriptDataBudget(MaxDataBudgetBytes);
                    configured = await worker
                        .ConfigureAsync(
                            scriptName,
                            DeterministicLimits(),
                            DeterministicOsPolicy(),
                            ExecutionClock.Cpu,
                            budget,
                            startup.Token
                        )
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (!cancellationToken.IsCancellationRequested)
                {
                    throw Transient(
                        "Policy script worker startup timed out while configuring the sandbox."
                    );
                }
                catch (TimeoutException error)
                {
                    throw Transient(
                        "Policy script worker startup timed out while configuring the sandbox.",
                        error
                    );
                }
                catch (IOException error)
                {
                    throw Transient(
                        "Policy script worker exited during startup: " + error.Message,
                        error
                    );
                }

                if (
                    configured.KindCase != WorkerEvent.KindOneofCase.Ok
                    || !configured.HasExecutionClock
                    || configured.ExecutionClock != ExecutionClock.Cpu
                )
                    throw Transient(
                        "Policy script worker failed to acknowledge deterministic CPU-clock configuration."
                    );

                var feedBudget = new ToolScriptDataBudget(MaxDataBudgetBytes);
                Feed feed;
                try
                {
                    feedBudget.Charge(8L * Encoding.UTF8.GetByteCount(script));
                    var input = data ?? new JsonObject();
                    var (values, root) = MontyValues.FromJson(input, feedBudget);
                    feed = new Feed { Code = script, Values = values };
                    feed.Inputs.Add(new NamedRef { Name = "data", Value = root });
                }
                catch (ToolScriptDataLimitException error)
                {
                    throw new InvalidDataException(
                        "Policy script exceeded its data limit: " + error.Message
                    );
                }

                // Start the script's wall clock only after Configure is acknowledged so process
                // startup and AV/OS overhead never consume script execution time.
                var executionBudget = ExecutionWallClockOverride ?? WallClockLimit;
                using var execution = CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken
                );
                execution.CancelAfter(executionBudget);

                WorkerEvent reply;
                try
                {
                    reply = await worker
                        .TurnAsync(
                            new ClientRequest { Feed = feed },
                            feedBudget,
                            _ => { },
                            execution.Token
                        )
                        .ConfigureAwait(false);
                }
                catch (TimeoutException error)
                {
                    throw Transient(
                        "Policy script exceeded its execution time limit.",
                        error
                    );
                }
                catch (OperationCanceledException)
                    when (!cancellationToken.IsCancellationRequested)
                {
                    throw Transient(
                        "Policy script exceeded its execution wall-clock time limit."
                    );
                }
                catch (ToolScriptDataLimitException error)
                {
                    throw new InvalidDataException(
                        "Policy script exceeded its data limit: " + error.Message
                    );
                }
                catch (IOException error)
                {
                    throw Transient(
                        "Policy script worker exited unexpectedly during execution: "
                            + error.Message,
                        error
                    );
                }

                try
                {
                    return reply.KindCase switch
                    {
                        WorkerEvent.KindOneofCase.Complete => ToStrictJson(
                            reply.Complete.Values,
                            reply.Complete.Value,
                            feedBudget
                        ),
                        WorkerEvent.KindOneofCase.Error => throw ClassifyScriptError(
                            reply.Error.Exception
                        ),
                        WorkerEvent.KindOneofCase.OsCall => throw new InvalidDataException(
                            FormatRefusedOsCall(script, reply.OsCall)
                        ),
                        WorkerEvent.KindOneofCase.NameLookup => throw new InvalidDataException(
                            FormatRefusedNameLookup(script, reply.NameLookup)
                        ),
                        WorkerEvent.KindOneofCase.FunctionCall => throw new InvalidDataException(
                            FormatRefusedCall(
                                script,
                                reply.FunctionCall.Position,
                                $"host function `{reply.FunctionCall.FunctionName}` is not available in policy scripts."
                            )
                        ),
                        WorkerEvent.KindOneofCase.ResolveFutures => throw new InvalidDataException(
                            FormatRefusedCall(
                                script,
                                reply.ResolveFutures.Position,
                                "external async futures are not available in policy scripts."
                            )
                        ),
                        _ => throw Transient(
                            $"Policy script ended with unsupported worker event `{reply.KindCase}`."
                        ),
                    };
                }
                catch (ToolScriptDataLimitException error)
                {
                    throw new InvalidDataException(
                        "Policy script exceeded its data limit: " + error.Message
                    );
                }
            }
        }
        finally
        {
            Concurrency.Release();
        }
    }

    internal static JsonArray EvaluateRules(
        string script,
        JsonNode? data,
        string scriptName = "policy-script"
    ) =>
        Task.Run(() => EvaluateRulesAsync(script, data, scriptName, CancellationToken.None))
            .GetAwaiter()
            .GetResult();

    internal static async Task<JsonArray> EvaluateRulesAsync(
        string script,
        JsonNode? data,
        string scriptName = "policy-script",
        CancellationToken cancellationToken = default
    )
    {
        var raw = await EvaluateRawAsync(script, data, scriptName, cancellationToken)
            .ConfigureAwait(false);
        if (raw is not JsonArray array)
            throw new InvalidDataException(
                "Policy script must return a list of rule objects."
            );
        if (array.Count > 256)
            throw new InvalidDataException(
                $"Policy script returned {array.Count} rules, exceeding the 256-rule limit."
            );
        var serializedBytes = Encoding.UTF8.GetByteCount(array.ToJsonString());
        if (serializedBytes > ToolAuthorizationPolicy.MaxBytes)
            throw new InvalidDataException(
                $"Policy script output exceeds the {ToolAuthorizationPolicy.MaxBytes}-byte limit."
            );
        return array;
    }

    /// <summary>
    /// Converts a Monty arena value to strict JSON (null, boolean, finite number, string, list/tuple,
    /// or string-keyed dict). Rejects sets, bytes, datetimes, class instances, non-finite floats,
    /// and duplicate dict keys so script output is strictly deterministic JSON.
    /// </summary>
    internal static JsonNode? ToStrictJson(
        Arena arena,
        uint index,
        ToolScriptDataBudget budget,
        int depth = 0
    ) => ToStrictJson(arena, index, uint.MaxValue, budget, depth);

    private static JsonNode? ToStrictJson(
        Arena arena,
        uint index,
        uint holder,
        ToolScriptDataBudget budget,
        int depth
    )
    {
        if (depth > 48)
            throw new InvalidDataException("Policy script output exceeds nesting depth limit.");
        if (index >= arena.Nodes.Count || holder != uint.MaxValue && index >= holder)
            throw new InvalidDataException("Policy script returned an invalid value arena.");
        var value = arena.Nodes[(int)index];
        budget.Charge(96);
        switch (value.KindCase)
        {
            case MontyNode.KindOneofCase.None_:
                return null;
            case MontyNode.KindOneofCase.Boolean:
                return JsonValue.Create(value.Boolean);
            case MontyNode.KindOneofCase.Int:
                budget.Charge(128);
                return JsonValue.Create(value.Int);
            case MontyNode.KindOneofCase.Float:
                if (!double.IsFinite(value.Float))
                    throw new InvalidDataException(
                        "Policy script output contains a non-finite float."
                    );
                budget.Charge(128);
                return JsonValue.Create(value.Float);
            case MontyNode.KindOneofCase.Str:
                budget.Charge(8L * Encoding.UTF8.GetByteCount(value.Str));
                return JsonValue.Create(value.Str);
            case MontyNode.KindOneofCase.List:
                return StrictList(arena, value.List.Items, index, budget, depth);
            case MontyNode.KindOneofCase.Tuple:
                return StrictList(arena, value.Tuple.Items, index, budget, depth);
            case MontyNode.KindOneofCase.Dict:
                var map = new JsonObject();
                foreach (var pair in value.Dict.Pairs)
                {
                    if (pair.Key >= index)
                        throw new InvalidDataException(
                            "Policy script returned an invalid dict key index."
                        );
                    var keyNode = arena.Nodes[(int)pair.Key];
                    if (keyNode.KindCase != MontyNode.KindOneofCase.Str)
                        throw new InvalidDataException(
                            $"Policy script dict keys must be strings, got `{keyNode.KindCase}`."
                        );
                    var key = keyNode.Str;
                    if (map.ContainsKey(key))
                        throw new InvalidDataException(
                            $"Policy script returned duplicate dict key `{key}`."
                        );
                    budget.Charge(64 + 8L * Encoding.UTF8.GetByteCount(key));
                    map[key] = ToStrictJson(arena, pair.Value, index, budget, depth + 1);
                }
                return map;
            default:
                throw new InvalidDataException(
                    $"Policy script returned unsupported value type `{value.KindCase}`; output must be JSON-compatible data."
                );
        }
    }

    private static JsonArray StrictList(
        Arena arena,
        IList<uint> items,
        uint holder,
        ToolScriptDataBudget budget,
        int depth
    )
    {
        var array = new JsonArray();
        foreach (var item in items)
            array.Add(ToStrictJson(arena, item, holder, budget, depth + 1));
        return array;
    }

    private static InvalidDataException ClassifyScriptError(RaisedException error)
    {
        var message = FormatException(error);
        return string.Equals(error.ExcType, "TimeoutError", StringComparison.Ordinal)
            ? Transient(message)
            : new InvalidDataException(message);
    }

    private static string FormatException(RaisedException error)
    {
        var frame = error.Traceback.LastOrDefault(item => item.Start is not null);
        var location = frame?.Start is { Line: > 0 } start ? $" at line {start.Line}" : "";
        var detail = string.IsNullOrEmpty(error.Message)
            ? error.ExcType
            : $"{error.ExcType}: {error.Message}";
        return $"Policy script error{location}: {detail}";
    }

    private static string FormatRefusedOsCall(string script, OsCall call)
    {
        var what = call.CallCase switch
        {
            OsCall.CallOneofCase.DateToday => "clock access (`date.today`)",
            OsCall.CallOneofCase.DateTimeNow => "clock access (`datetime.now`)",
            OsCall.CallOneofCase.Time =>
                string.IsNullOrEmpty(call.Time?.Caller)
                    ? "clock access (`time`)"
                    : $"clock access (`{call.Time.Caller}`)",
            OsCall.CallOneofCase.Urandom => "randomness / OS entropy (`random` / `os.urandom`)",
            OsCall.CallOneofCase.Sleep or OsCall.CallOneofCase.SystemSleep =>
                "sleep (`time.sleep`)",
            OsCall.CallOneofCase.AsyncSleep or OsCall.CallOneofCase.AsyncSystemSleep =>
                "sleep (`asyncio.sleep`)",
            OsCall.CallOneofCase.Getenv or OsCall.CallOneofCase.GetEnviron =>
                "environment access (`os.getenv` / `os.environ`)",
            OsCall.CallOneofCase.Import or OsCall.CallOneofCase.ImportStubs =>
                string.IsNullOrEmpty(call.Import?.Module)
                    ? "host module import"
                    : $"module import (`{call.Import.Module}`)",
            _ => $"OS / filesystem call (`{call.CallCase}`)",
        };
        return FormatRefusedCall(
            script,
            call.Position,
            $"{what} is not allowed in deterministic policy scripts."
        );
    }

    private static string FormatRefusedNameLookup(string script, NameLookup lookup) =>
        FormatRefusedCall(
            script,
            lookup.Position,
            $"undefined name `{lookup.Name}` (host calls are not available in policy scripts)."
        );

    private static string FormatRefusedCall(string script, SourceRange? position, string detail)
    {
        var line = LineNumber(script, position);
        var where = line is > 0 ? $" at line {line}" : "";
        return $"Policy script error{where}: {detail}";
    }

    private static int? LineNumber(string script, SourceRange? position)
    {
        if (position is null || position.Start == 0 && position.End == 0)
            return null;
        var bytes = Encoding.UTF8.GetBytes(script);
        var offset = (int)Math.Min(position.Start, (uint)bytes.Length);
        var line = 1;
        for (var i = 0; i < offset; i++)
            if (bytes[i] == (byte)'\n')
                line++;
        return line;
    }
}
