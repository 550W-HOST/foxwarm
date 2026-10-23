using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.ToolScript;

internal sealed partial class MainToolScript : IAsyncDisposable
{
    private readonly ToolScriptRunStore store;
    private readonly string binary;
    private readonly ConcurrentDictionary<string, ActiveRun> active = new(StringComparer.Ordinal);
    private volatile bool closing;
    private readonly HashSet<TaskCompletionSource> activities = [];
    private readonly object gate = new();
    internal ToolScriptRunStore Store => store;

    private sealed class ActiveRun : IDisposable
    {
        internal readonly JsonObject Record;
        internal readonly ToolScriptContext Context;
        internal readonly CancellationTokenSource Cancel;
        private readonly CancellationTokenSource hostCancellation;
        internal readonly CancellationToken Caller;
        internal readonly CancellationToken Token;
        internal readonly string RecordOwner;
        internal volatile string? CommittedStatus;

        internal ActiveRun(JsonObject record, ToolScriptContext context, CancellationToken token)
        {
            Record = record;
            Context = context;
            RecordOwner = Required(record, "ownerSessionId");
            // Foreground cancellation fences host effects; explicit run/shutdown cancellation owns the VM lifetime.
            Caller = token;
            Cancel = new CancellationTokenSource();
            hostCancellation = CancellationTokenSource.CreateLinkedTokenSource(token, Cancel.Token);
            Token = hostCancellation.Token;
            CommittedStatus = record["snapshotBase64"] is not null ? "waiting" : null;
        }

        internal void RequireHostAdmission()
        {
            Cancel.Token.ThrowIfCancellationRequested();
            if (Caller.IsCancellationRequested)
                throw new InvalidOperationException(
                    $"Tool call was not started because {Context.Owner.Entry.ToolCancellationSource} cancelled it; it was not executed."
                );
        }

        public void Dispose()
        {
            hostCancellation.Dispose();
            Cancel.Dispose();
        }

        internal void RequestCancel()
        {
            // A stale observer can race only with settled-owner disposal; no mutable record is read.
            try
            {
                Cancel.Cancel();
            }
            catch (ObjectDisposedException) { }
        }
    }

    internal MainToolScript(string root, string? binary = null)
    {
        store = new(root);
        this.binary = Path.GetFullPath(
            binary
                ?? Path.Combine(
                    AppContext.BaseDirectory,
                    "ToolScript",
                    "native",
                    OperatingSystem.IsWindows() ? "monty.exe" : "monty"
                )
        );
    }

    internal async Task<JsonObject> ExecuteAsync(
        string name,
        JsonObject args,
        ToolScriptContext context,
        CancellationToken token
    )
    {
        var activity = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (closing)
                throw new InvalidOperationException("ToolScript host is closing.");
            activities.Add(activity);
        }
        try
        {
            return await ExecuteAdmittedAsync(name, args, context, token);
        }
        finally
        {
            lock (gate)
                activities.Remove(activity);
            activity.TrySetResult();
        }
    }

    private async Task<JsonObject> ExecuteAdmittedAsync(
        string name,
        JsonObject args,
        ToolScriptContext context,
        CancellationToken token
    )
    {
        token.ThrowIfCancellationRequested();
        new ToolScriptDataBudget().JsonValue(args);
        switch (name)
        {
            case "run_script":
            case "start_toolscript_run":
                return await StartAsync(args, context, name == "start_toolscript_run", token);
            case "continue_script":
                return await ContinueAsync(args, context, token);
            case "get_toolscript_run":
                return Project(
                    await RequiredAsync(Required(args, "runId"), context, token),
                    lean: false
                );
            case "list_toolscript_runs":
                var count = Number(args["limit"], 20);
                var limit = double.IsFinite(count)
                    ? (int)Math.Clamp(Math.Truncate(count), 1, 200)
                    : 20;
                var status = Text(args["status"]);
                var rows = await store.ListAsync(context.LiteralOwner, limit, status, token);
                var budget = new ToolScriptDataBudget();
                var output = new JsonArray();
                foreach (var row in rows)
                {
                    budget.JsonValue(row);
                    output.Add(Project(row, lean: false));
                }
                return new JsonObject { ["runs"] = output };
            case "cancel_toolscript_run":
                return await CancelAsync(Required(args, "runId"), context, token);
            default:
                throw new InvalidDataException("Unknown ToolScript tool.");
        }
    }

    private async Task<JsonObject> StartAsync(
        JsonObject args,
        ToolScriptContext context,
        bool background,
        CancellationToken token
    )
    {
        if (closing)
            throw new InvalidOperationException("ToolScript host is closing.");
        args = NormalizeStartArgs(args, background);
        var supplied = Text(args["code"]);
        var file = Text(args["filePath"]) is { } filePath ? SessionGoal.Trim(filePath) : null;
        var sourceNode = Foxwarm.Tools.ToolRegistry.ToolScriptSourceNode(
            args,
            context.SourceNode
                ?? SessionManager.ResolveExecutionNode(
                    context.Owner.Entry.Snapshot().AuthorityEnvelope
                )
        );
        string code;
        string path;
        if (supplied is not null)
        {
            code = supplied;
            path = "<inline>";
        }
        else
            (path, code) = await context.ReadSource(
                SessionGoal.Trim(file!),
                new ToolScriptDataBudget(),
                token
            );
        var prep = new ToolScriptDataBudget();
        prep.JsonValue(args);
        var input = args["args"]!.DeepClone();
        prep.Charge(8L * System.Text.Encoding.UTF8.GetByteCount(code));
        if (Regex.IsMatch(code, @"^\s*def\s+main\s*\(\s*args\b", RegexOptions.Multiline))
            code = code.TrimEnd() + "\n\nmain(args)\n";
        var seconds = Number(args["timeoutSecs"], 30);
        var mode = Text(args["mode"])!;
        while (true)
        {
            var id =
                "tsr_"
                + Now()
                + "_"
                + System
                    .Security.Cryptography.RandomNumberGenerator.GetHexString(8)
                    .ToLowerInvariant();
            using var lane = await store.AcquireAsync(id, token);
            if (store.Exists(id))
                continue;
            var now = Now();
            var record = new JsonObject
            {
                ["runId"] = id,
                ["mode"] = mode,
                ["status"] = "running",
                ["ownerSessionId"] = context.Owner.Id,
                ["agentName"] = context.Owner.Agent,
                ["filePath"] = file ?? "<inline>",
                ["scriptPath"] = path,
                ["scriptName"] = path == "<inline>" ? "inline.py" : Path.GetFileName(path),
                ["vmRuntime"] = RuntimeIdentity(),
                ["stdout"] = "",
                ["executedTools"] = new JsonArray(),
                ["relatedManagedSessions"] = new JsonArray(),
                ["hostCallCount"] = 0,
                ["timeoutSecs"] = seconds,
                ["createdAt"] = now,
                ["updatedAt"] = now,
                ["startedAt"] = now,
            };
            if (sourceNode is not null)
                record["sourceNode"] = sourceNode;
            return await RunAsync(record, context, token, code, input, resume: null);
        }
    }

    // Shared starter intent normalization. No source reads or owner routing occur here.
    internal static JsonObject NormalizeStartArgs(JsonObject args, bool background = false)
    {
        var mode = Mode(args, background);
        var timeout = Timeout(args["timeoutSecs"], 30);
        var budget = new ToolScriptDataBudget();
        budget.JsonValue(args);
        JsonNode input;
        if (args["args"] is JsonObject primary)
            input = primary.DeepClone();
        else if (args.ContainsKey("argsJson"))
        {
            var json = Required(args, "argsJson");
            input =
                budget.ParseJson(System.Text.Encoding.UTF8.GetBytes(json))
                ?? throw new InvalidDataException("ToolScript argsJson must parse as an object.");
            if (input is not JsonObject)
                throw new InvalidDataException("ToolScript argsJson must parse as an object.");
        }
        else if (args.ContainsKey("args"))
            throw new InvalidDataException(
                "ToolScript args must be an object, or provide argsJson."
            );
        else
            input = new JsonObject();
        _ = Foxwarm.Tools.ToolRegistry.ToolScriptSourceNode(args, "master");
        var code = Text(args["code"]);
        var file = Text(args["filePath"]);
        var inline = !string.IsNullOrWhiteSpace(code);
        if (!inline && string.IsNullOrWhiteSpace(file))
            throw new InvalidDataException("Supply code or filePath for run_script.");
        var normalized = new JsonObject
        {
            [inline ? "code" : "filePath"] = inline ? code : file,
            ["args"] = input,
            ["mode"] = mode,
            ["timeoutSecs"] = timeout,
        };
        if (!inline && args.ContainsKey("node"))
            normalized["node"] = args["node"]?.DeepClone();
        return normalized;
    }

    private async Task<JsonObject> ContinueAsync(
        JsonObject args,
        ToolScriptContext context,
        CancellationToken token
    )
    {
        var id = Required(args, "runId");
        if (active.ContainsKey(id))
            throw new InvalidOperationException("ToolScript run is already executing.");
        using var lane = await store.AcquireAsync(id, token);
        var record = await RequiredAsync(id, context, token);
        ToolScriptRunStore.RequireUnmanaged(record);
        var waiting = record["waiting"] as JsonObject;
        if (
            Text(record["status"]) != "waiting"
            || waiting is null
            || Text(record["snapshotBase64"]) is not { Length: > 0 }
        )
            throw new InvalidDataException("ToolScript run is not waiting for continue_script.");
        if (Required(args, "continuationId") != Text(waiting["continuationId"]))
            throw new InvalidDataException(
                "continuationId does not match the pending ToolScript continuation."
            );
        var identity = record["vmRuntime"] as JsonObject;
        if (
            identity is null
            || Text(identity["engine"]) != "@pydantic/monty"
            || Text(identity["version"]) != MontyWorker.Version
            || Text(identity["snapshotFormat"]) != "monty-pool-snapshot-v0.0.19"
        )
            throw new NotSupportedException(
                "ToolScript snapshot runtime is incompatible. The historical record and snapshot were retained."
            );
        _ = new ToolScriptStdout(Text(record["stdout"]) ?? ""); // Reject over-budget old output before record mutation.
        JsonObject resume;
        if (Text(waiting["reason"]) == "agent")
            resume = new JsonObject { ["mode"] = "return", ["value"] = args["input"]?.DeepClone() };
        else if (
            Text(waiting["reason"]) == "timeout"
            && waiting["timeout"]?["pendingResume"] is JsonObject pending
        )
            resume = (JsonObject)pending.DeepClone();
        else
            throw new InvalidDataException(
                "ToolScript waiting record has no supported pending resume payload."
            );
        var snapshotText = Required(record, "snapshotBase64");
        var budget = new ToolScriptDataBudget();
        budget.Retain(
            System.Text.Encoding.UTF8.GetByteCount(Text(record["stdout"]) ?? ""),
            snapshotText.Length * 3L / 4
        );
        budget.JsonValue(record, "stdout", "snapshotBase64");
        budget.Charge(4L * snapshotText.Length * 3 / 4);
        var snapshot = Convert.FromBase64String(snapshotText); // Invalid old encoding must not enter the write lane as running.
        record["timeoutSecs"] = Timeout(args["timeoutSecs"], Number(record["timeoutSecs"], 30));
        return await RunAsync(record, context, token, null, null, resume, snapshot);
    }

    private async Task<JsonObject> RequiredAsync(
        string id,
        ToolScriptContext context,
        CancellationToken token
    )
    {
        var record =
            await store.ReadAsync(id, token)
            ?? throw new InvalidDataException("ToolScript run not found: " + id);
        ToolScriptRunStore.RequireOwned(record, context.LiteralOwner);
        return record;
    }

    private async Task<JsonObject> CancelAsync(
        string id,
        ToolScriptContext context,
        CancellationToken token
    )
    {
        if (active.TryGetValue(id, out var run))
        {
            if (run.RecordOwner != context.LiteralOwner)
                throw new InvalidDataException("ToolScript run is not owned by this session.");
            run.RequestCancel();
            return new JsonObject
            {
                ["runId"] = id,
                ["status"] = run.CommittedStatus ?? "running",
                ["cancellationRequested"] = true,
            };
        }
        using var lane = await store.AcquireAsync(id, token);
        var record = await RequiredAsync(id, context, token);
        ToolScriptRunStore.RequireUnmanaged(record);
        _ = new ToolScriptStdout(Text(record["stdout"]) ?? "");
        if (Text(record["status"]) is "completed" or "failed" or "cancelled")
            return Project(record, false);
        record["status"] = "cancelled";
        record.Remove("snapshotBase64");
        record.Remove("waiting");
        record["updatedAt"] = Now();
        record["cancelledAt"] = Now();
        await store.WriteAsync(record, token);
        return Project(record, false);
    }

    internal void CancelForegroundForShutdown(SessionEntry entry)
    {
        // Stop may already have taken the foreground handle. Timer slices do not carry its cancelled token.
        foreach (var run in active.Values)
            if (
                ReferenceEquals(run.Context.Owner.Entry, entry)
                && run.Caller.IsCancellationRequested
            )
                run.RequestCancel();
    }

    internal void BeginShutdown()
    {
        ActiveRun[] runs;
        lock (gate)
        {
            closing = true;
            runs = active.Values.ToArray();
        }
        foreach (var run in runs)
            run.RequestCancel();
    }

    internal async Task DrainAsync()
    {
        Task[] pending;
        lock (gate)
            pending = activities.Select(activity => activity.Task).ToArray();
        await Task.WhenAll(pending);
    }

    public async ValueTask DisposeAsync()
    {
        BeginShutdown();
        await DrainAsync();
    }

    private static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static string Required(JsonObject args, string key) =>
        Text(args[key]) is { Length: > 0 } text
            ? text
            : throw new InvalidDataException(key + " is required.");

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    internal static double Number(JsonNode? node, double fallback) =>
        node is JsonValue value
            ? value.TryGetValue<double>(out var number)
                ? number
                : value.TryGetValue<long>(out var integer)
                    ? integer
                    : value.TryGetValue<int>(out var int32)
                        ? int32
                        : value.TryGetValue<decimal>(out var decimalValue)
                            ? (double)decimalValue
                            : fallback
            : fallback;

    private static double Timeout(JsonNode? node, double fallback)
    {
        if (node is null || Text(node) == "")
            return fallback;
        var number = Number(node, double.NaN);
        return double.IsFinite(number) && number > 0
            ? number
            : throw new InvalidDataException("timeoutSecs must be a positive number.");
    }

    private static string Mode(JsonObject args, bool background)
    {
        JsonNode? value = args["mode"] ?? args["runMode"] ?? args["background"];
        if (background)
            value = Truthy(args["mode"]) ? args["mode"] : JsonValue.Create("background");
        if (value is null || Text(value) == "")
            return "foreground";
        if (value is JsonValue scalar && scalar.TryGetValue<bool>(out var flag))
            return flag ? "background" : "foreground";
        var text = Text(value);
        return text is "foreground" or "background"
            ? text
            : throw new InvalidDataException("mode must be foreground or background.");
    }

    private static bool Truthy(JsonNode? value) =>
        value switch
        {
            null => false,
            JsonValue scalar when scalar.TryGetValue<bool>(out var flag) => flag,
            JsonValue scalar when scalar.TryGetValue<string>(out var text) => text.Length > 0,
            JsonValue scalar when scalar.TryGetValue<double>(out var number) => number != 0
                && !double.IsNaN(number),
            _ => true,
        };

    private static JsonObject RuntimeIdentity() =>
        new()
        {
            ["engine"] = "@pydantic/monty",
            ["version"] = MontyWorker.Version,
            ["snapshotFormat"] = "monty-pool-snapshot-v0.0.19",
        };
}
