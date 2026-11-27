using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Google.Protobuf;
using Monty.V1;
using Exception = System.Exception;

namespace Foxwarm.ToolScript;

internal sealed partial class MainToolScript
{
    private async Task<JsonObject> RunAsync(
        JsonObject record,
        ToolScriptContext context,
        CancellationToken token,
        string? code,
        JsonNode? input,
        JsonObject? resume,
        byte[]? restoredSnapshot = null,
        ToolScriptDetach? detach = null
    )
    {
        var id = Required(record, "runId");
        var run = new ActiveRun(record, context, token);
        lock (gate)
        {
            if (closing)
            {
                run.Dispose();
                throw new InvalidOperationException("ToolScript host is closing.");
            }
            if (!active.TryAdd(id, run))
            {
                run.Dispose();
                throw new InvalidOperationException("ToolScript run is already executing.");
            }
        }
        MontyWorker? worker = null;
        IDisposable? processSlot = null;
        var stdout = new ToolScriptStdout(Text(record["stdout"]) ?? "");
        var offset = stdout.Count;
        // A detachable segment's output so far is read by its waiting call when it detaches.
        Action<string> print = stdout.Append;
        if (detach is not null)
        {
            print = text =>
            {
                lock (detach.Gate)
                    stdout.Append(text);
            };
            lock (detach.Gate)
                detach.Output = () => stdout.Delta(offset);
        }
        var oldSnapshot = Text(record["snapshotBase64"]);
        var persistenceFailure = false;
        var slice = Stopwatch.StartNew();
        // Time spent waiting for approval decisions does not count toward the slice limit.
        var approvalWait = new ToolApprovalWaitMeter();
        using var approvalMeter = ToolApprovalWaitMeter.Enter(approvalWait);
        TimeSpan Elapsed() => slice.Elapsed - approvalWait.Total;
        record["hostCallCount"] = 0;
        record["subCalls"] = new JsonArray();
        record.Remove("lastHostCall");
        JsonObject ProjectSlice()
        {
            context.Progress?.Invoke((JsonArray)record["subCalls"]!.DeepClone());
            return Project(record, true, stdout.Delta(offset));
        }
        async Task CommitAsync()
        {
            var budget = Budget();
            budget.Charge(2 * stdout.Bytes);
            record["stdout"] = stdout.Text();
            record["updatedAt"] = Now();
            try
            {
                await store.WriteAsync(record, CancellationToken.None, budget);
                run.CommittedStatus = Required(record, "status");
            }
            catch (AuthorityCommittedException)
            {
                run.CommittedStatus = Required(record, "status");
                persistenceFailure = true;
                throw;
            }
            catch
            {
                persistenceFailure = true;
                throw;
            }
        }
        ToolScriptDataBudget Budget()
        {
            var budget = new ToolScriptDataBudget();
            budget.Retain(stdout.Bytes, oldSnapshot is null ? 0 : oldSnapshot.Length * 3L / 4);
            budget.JsonValue(record, "stdout", "snapshotBase64");
            return budget;
        }
        try
        {
            context.Owner.Entry.RequireIdentityAuthority();
            record["status"] = "running";
            record["lastResumeAt"] = Now();
            await CommitAsync();
            run.Token.ThrowIfCancellationRequested();
            context.Owner.Entry.RequireIdentityAuthority();
            // One Monty process per running top-level segment, within the tenant's and the
            // replica's ToolScript slots; a run over them waits here. A nested run uses its root
            // run's slot, which that run holds while it waits for the nested call.
            if (AdmitProcess is { } admit && !context.Nested)
            {
                processSlot = await admit(run.Token);
                context.Owner.Entry.RequireIdentityAuthority();
            }
            worker = new MontyWorker(binary);
            WorkerEvent progress;
            ToolScriptDataBudget progressBudget;
            DateTimeOffset? sleepUntil = null;
            if (resume is null)
            {
                // A detachable run has no execution-time budget, like a background exec.
                var configured = await worker.ConfigureAsync(
                    Required(record, "scriptName"),
                    detach is null ? Number(record["timeoutSecs"], 30) : null,
                    Budget(),
                    run.Cancel.Token
                );
                if (configured.KindCase != WorkerEvent.KindOneofCase.Ok)
                    throw new InvalidDataException(
                        "Monty configure did not acknowledge the qualified version."
                    );
                var budget = Budget();
                budget.Charge(8L * System.Text.Encoding.UTF8.GetByteCount(code!));
                var (values, root) = MontyValues.FromJson(input, budget);
                var feed = new Feed { Code = code!, Values = values };
                feed.Inputs.Add(new NamedRef { Name = "args", Value = root });
                progressBudget = budget;
                progress = await worker.TurnAsync(
                    new() { Feed = feed },
                    progressBudget,
                    print,
                    run.Cancel.Token
                );
                code = null;
                input = null;
            }
            else
            {
                var budget = Budget();
                budget.Charge(4L * oldSnapshot!.Length * 3 / 4);
                var snapshot = restoredSnapshot!;
                progressBudget = budget;
                // The snapshot restores the limits; the session policy is applied by this Configure.
                var configured = await worker.ConfigureAsync(
                    Required(record, "scriptName"),
                    null,
                    Budget(),
                    run.Cancel.Token,
                    restoring: true
                );
                if (configured.KindCase != WorkerEvent.KindOneofCase.Ok)
                    throw new InvalidDataException(
                        "Monty configure did not acknowledge the qualified version."
                    );
                progress = await worker.TurnAsync(
                    new() { Load = new Load { State = ByteString.CopyFrom(snapshot) } },
                    progressBudget,
                    print,
                    run.Cancel.Token
                );
                var sleeping = Text(resume!["mode"]) == "sleep";
                if (
                    sleeping
                        ? SleepSeconds(progress) is null
                        : progress.KindCase != WorkerEvent.KindOneofCase.FunctionCall
                )
                    throw new InvalidDataException(
                        "ToolScript persisted snapshot is not a resumable host-call snapshot."
                    );
                context.WaitScope.Pending = record["waiting"]?["timeout"]?["pendingSessionWait"]
                    is JsonObject intent
                    ? (JsonObject)intent.DeepClone()
                    : null;
                record.Remove("waiting");
                record.Remove("snapshotBase64");
                oldSnapshot = null;
                restoredSnapshot = null;
                progressBudget = Budget();
                // A sleep paused at the time limit keeps its end instant; the loop waits out the rest.
                if (sleeping)
                    sleepUntil = DateTimeOffset.FromUnixTimeMilliseconds(
                        (long)Number(resume["untilUnixMs"], 0)
                    );
                else
                    progress = await ResumeAsync(
                        worker,
                        progress.FunctionCall.CallId,
                        resume,
                        progressBudget,
                        print,
                        run.Cancel.Token
                    );
                resume = null;
            }
            while (true)
            {
                run.Cancel.Token.ThrowIfCancellationRequested();
                context.Owner.Entry.RequireIdentityAuthority();
                if (progress.KindCase == WorkerEvent.KindOneofCase.Complete)
                {
                    var completed = MontyValues.ToJson(
                        progress.Complete.Values,
                        progress.Complete.Value,
                        progressBudget
                    );
                    // A run begun before image admission keeps the old promotion (no
                    // resultImages) for the result it eventually produces.
                    if (record.ContainsKey("producedImages"))
                        record["resultImages"] = AdmitResultImages(context.Owner, record, completed);
                    record["lastResult"] = completed;
                    record["status"] = "completed";
                    record["completedAt"] = Now();
                    record.Remove("waiting");
                    record.Remove("snapshotBase64");
                    await CommitAsync();
                    return ProjectSlice();
                }
                if (progress.KindCase == WorkerEvent.KindOneofCase.Error)
                    throw new InvalidDataException(
                        progress.Error.Exception.ExcType + ": " + progress.Error.Exception.Message
                    );
                if (progress.KindCase == WorkerEvent.KindOneofCase.NameLookup)
                {
                    var name = progress.NameLookup.Name;
                    progressBudget = Budget();
                    // Every name is offered as a host function; the call itself is admitted or refused
                    // by HostCallAsync. No host object exists, so a lazy attribute lookup finds nothing.
                    var lookup = new ResumeNameLookup();
                    if (progress.NameLookup.ObjectId is not null)
                        lookup.Undefined = new Unit();
                    else
                    {
                        lookup.Values = new Arena
                        {
                            NodeCount = 1,
                            Nodes =
                            {
                                new MontyNode { Function = new Monty.V1.Function { Name = name } },
                            },
                        };
                        lookup.Value = 0;
                    }
                    progress = await worker.TurnAsync(
                        new() { ResumeNameLookup = lookup },
                        progressBudget,
                        print,
                        run.Cancel.Token
                    );
                    continue;
                }
                if (SleepSeconds(progress) is double delay)
                {
                    context.WaitScope.Pending = null;
                    var until = sleepUntil ?? DateTimeOffset.UtcNow + TimeSpan.FromSeconds(delay);
                    sleepUntil = null;
                    var slept = await SleepAsync(until);
                    if (slept is null)
                    {
                        await WaitAsync(
                            "timeout",
                            null,
                            new JsonObject
                            {
                                ["mode"] = "sleep",
                                ["untilUnixMs"] = until.ToUnixTimeMilliseconds(),
                            },
                            progress.OsCall.CallCase == OsCall.CallOneofCase.AsyncSleep
                                ? "asyncio.sleep"
                                : "time.sleep"
                        );
                        return ProjectSlice();
                    }
                    progressBudget = Budget();
                    progress = await ResumeAsync(
                        worker,
                        progress.OsCall.CallId,
                        slept,
                        progressBudget,
                        print,
                        run.Cancel.Token
                    );
                    continue;
                }
                if (progress.KindCase == WorkerEvent.KindOneofCase.OsCall)
                {
                    context.WaitScope.Pending = null;
                    progressBudget = Budget();
                    progress = await worker.TurnAsync(
                        new()
                        {
                            ResumeCall = new ResumeCall
                            {
                                CallId = progress.OsCall.CallId,
                                Result = new() { NotHandled = new Unit() },
                            },
                        },
                        progressBudget,
                        print,
                        run.Cancel.Token
                    );
                    continue;
                }
                if (progress.KindCase != WorkerEvent.KindOneofCase.FunctionCall)
                    throw new InvalidDataException(
                        "Unsupported Monty suspension: " + progress.KindCase
                    );
                context.WaitScope.Pending = null;
                var call = progress.FunctionCall;
                if (call.ObjectId is not null)
                    throw new InvalidDataException("Unsupported Monty host object call.");
                var hostBudget = progressBudget;
                var positional = new JsonArray();
                var kwargs = new JsonObject();
                foreach (var value in call.Args)
                    positional.Add(MontyValues.ToJson(call.Values, value, hostBudget));
                foreach (var pair in call.Kwargs)
                    kwargs[
                        MontyValues.ToJson(call.Values, pair.Key, hostBudget)?.GetValue<string>()
                            ?? throw new InvalidDataException(
                                "Monty keyword name must be a string."
                            )
                    ] = MontyValues.ToJson(call.Values, pair.Value, hostBudget);
                if (call.FunctionName == "ask_agent")
                {
                    run.RequireHostAdmission();
                    var question = positional.Count > 0 ? positional[0] : kwargs["question"];
                    hostBudget.JsonValue(question);
                    var text =
                        question is JsonValue q && q.TryGetValue<string>(out var str)
                            ? str
                            : question?.ToJsonText() ?? "null";
                    record["hostCallCount"] = (int)Number(record["hostCallCount"], 0) + 1;
                    record["lastHostCall"] = new JsonObject
                    {
                        ["functionName"] = "ask_agent",
                        ["startedAt"] = Now(),
                        ["completedAt"] = Now(),
                        ["status"] = "completed",
                        ["durationMs"] = 0,
                    };
                    await WaitAsync("agent", new JsonObject { ["question"] = text }, null);
                    return ProjectSlice();
                }
                JsonObject outcome;
                try
                {
                    var value = await HostCallAsync(
                        call.FunctionName,
                        positional,
                        kwargs,
                        run,
                        hostBudget
                    );
                    hostBudget.JsonValue(value);
                    outcome = new JsonObject { ["mode"] = "return", ["value"] = value };
                }
                catch (Exception error)
                    when (error
                            is not OperationCanceledException
                                and not ToolScriptHostFatalException
                                and not ToolScriptDataLimitException
                                and not ToolScriptOutputLimitException
                                and not SessionIdentityUnavailableException
                    )
                {
                    outcome = Failure("RuntimeError", error.Message);
                }
                run.Cancel.Token.ThrowIfCancellationRequested();
                context.Owner.Entry.RequireIdentityAuthority();
                // Detachable segments do not pause at the time limit; only their caller's wait ends.
                if (detach is null && Elapsed().TotalSeconds >= Number(record["timeoutSecs"], 30))
                {
                    await WaitAsync("timeout", null, outcome);
                    return ProjectSlice();
                }
                progressBudget = Budget();
                progress = await ResumeAsync(
                    worker,
                    call.CallId,
                    outcome,
                    progressBudget,
                    print,
                    run.Cancel.Token
                );
            }
            // Waits until the sleep's end instant within the slice's time limit. Returns the answer
            // for the sleep, or null when the limit comes first and the run should pause there.
            async Task<JsonObject?> SleepAsync(DateTimeOffset until)
            {
                var stopped = Failure(
                    "RuntimeError",
                    $"Sleep was interrupted because {context.Owner.Entry.ToolCancellationSource} cancelled the tool call."
                );
                if (run.Caller.IsCancellationRequested)
                    return stopped;
                var rest = until - DateTimeOffset.UtcNow;
                var pause = false;
                // Detachable segments have no time limit, like a background exec.
                if (detach is null)
                {
                    var remaining = TimeSpan.FromSeconds(Number(record["timeoutSecs"], 30)) - Elapsed();
                    if (rest > remaining)
                        (rest, pause) = (remaining, true);
                }
                try
                {
                    // A timer can fire a little early; a sleep never ends before its time.
                    var waited = Stopwatch.StartNew();
                    for (var left = rest; left > TimeSpan.Zero; left = rest - waited.Elapsed)
                        await Task.Delay(
                            TimeSpan.FromMilliseconds(Math.Ceiling(left.TotalMilliseconds)),
                            run.Token
                        );
                }
                catch (OperationCanceledException) when (!run.Cancel.IsCancellationRequested)
                {
                    return stopped;
                }
                return pause ? null : new JsonObject { ["mode"] = "return", ["value"] = null };
            }
            async Task WaitAsync(
                string reason,
                JsonObject? fields,
                JsonObject? pending,
                string pausedAt = "call_tool"
            )
            {
                var budget = Budget();
                var dump = await worker.TurnAsync(
                    new() { Dump = new Dump() },
                    budget,
                    print,
                    run.Cancel.Token
                );
                if (dump.KindCase != WorkerEvent.KindOneofCase.DumpResult)
                    throw new InvalidDataException("Monty snapshot dump failed.");
                budget.Charge(4L * dump.DumpResult.State.Length);
                record["snapshotBase64"] = Convert.ToBase64String(dump.DumpResult.State.Span);
                var waiting = fields ?? new JsonObject();
                waiting["reason"] = reason;
                waiting["continuationId"] = "tsc_" + Guid.NewGuid().ToString("N");
                if (pending is not null)
                    waiting["timeout"] = new JsonObject
                    {
                        ["timeoutSecs"] = record["timeoutSecs"]!.DeepClone(),
                        ["pendingResume"] = pending,
                        ["elapsedMs"] = WholeMilliseconds(Elapsed()),
                        ["pausedAtFunctionName"] = pausedAt,
                        ["pausedAtSummaryName"] =
                            pausedAt == "call_tool"
                                ? record["lastHostCall"]?["functionName"]?.DeepClone()
                                : null,
                    };
                if (pending is not null && context.WaitScope.Pending is { } intent)
                    waiting["timeout"]!["pendingSessionWait"] = intent.DeepClone();
                record["waiting"] = waiting;
                record["status"] = "waiting";
                await CommitAsync();
            }
        }
        catch (Exception error)
        {
            worker?.Kill();
            if (!persistenceFailure)
            {
                record["status"] = error is OperationCanceledException ? "cancelled" : "failed";
                record["error"] =
                    error is OperationCanceledException && detach is not null && detachedClosing
                        ? ShutdownCancellation
                        : error.Message;
                record.Remove("lastResult");
                record.Remove("waiting");
                record.Remove("snapshotBase64");
                if (error is OperationCanceledException)
                    record["cancelledAt"] = Now();
                else
                    record["completedAt"] = Now();
                await CommitAsync();
            }
            if (error is ToolScriptHostFatalException)
                throw;
            record["status"] = run.CommittedStatus ?? "failed";
            var result = ProjectSlice();
            result["error"] = error.Message;
            if (persistenceFailure)
                result["recordPersistenceFailed"] = true;
            return result;
        }
        finally
        {
            try
            {
                if (worker is not null)
                {
                    await worker.DisposeAsync();
                    if (WorkerDisposedForTest is { } disposed)
                        await disposed();
                }
            }
            finally
            {
                processSlot?.Dispose();
                active.TryRemove(id, out _);
                run.Dispose();
            }
        }
    }

    /// <summary>The requested seconds when the worker suspends for a host-performed sleep.</summary>
    private static double? SleepSeconds(WorkerEvent progress) =>
        progress.KindCase != WorkerEvent.KindOneofCase.OsCall ? null
        : progress.OsCall.CallCase switch
        {
            OsCall.CallOneofCase.Sleep => progress.OsCall.Sleep.Seconds,
            OsCall.CallOneofCase.AsyncSleep => progress.OsCall.AsyncSleep.Delay,
            _ => null,
        };

    private static JsonObject Failure(string type, string message) =>
        new()
        {
            ["mode"] = "exception",
            ["exception"] = new JsonObject { ["type"] = type, ["message"] = message },
        };

    private static Task<WorkerEvent> ResumeAsync(
        MontyWorker worker,
        uint id,
        JsonObject outcome,
        ToolScriptDataBudget budget,
        Action<string> print,
        CancellationToken token
    )
    {
        var result = new ExtFunctionResult();
        var values = new Arena();
        if (Text(outcome["mode"]) == "exception")
            result.Error = new RaisedException
            {
                ExcType = Text(outcome["exception"]?["type"]) ?? "RuntimeError",
                Message = Text(outcome["exception"]?["message"]) ?? "ToolScript host call failed.",
            };
        else if (Text(outcome["mode"]) == "return")
            (values, result.ReturnValue) = MontyValues.FromJson(outcome["value"], budget);
        else
            throw new InvalidDataException("Unknown ToolScript pending resume mode.");
        return worker.TurnAsync(
            new()
            {
                ResumeCall = new ResumeCall
                {
                    CallId = id,
                    Result = result,
                    Values = values,
                },
            },
            budget,
            print,
            token
        );
    }
}

internal sealed class ToolScriptHostFatalException(Exception inner)
    : IOException(inner.Message, inner);
