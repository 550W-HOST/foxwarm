using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
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
        byte[]? restoredSnapshot = null
    )
    {
        var id = Required(record, "runId");
        var run = new ActiveRun(record, context, token);
        lock (gate)
        {
            if (closing)
            {
                run.Cancel.Dispose();
                throw new InvalidOperationException("ToolScript host is closing.");
            }
            if (!active.TryAdd(id, run))
            {
                run.Cancel.Dispose();
                throw new InvalidOperationException("ToolScript run is already executing.");
            }
        }
        MontyWorker? worker = null;
        var stdout = new ToolScriptStdout(Text(record["stdout"]) ?? "");
        var offset = stdout.Count;
        var oldSnapshot = Text(record["snapshotBase64"]);
        var persistenceFailure = false;
        var slice = Stopwatch.StartNew();
        record["hostCallCount"] = 0;
        record["subCalls"] = new JsonArray();
        record.Remove("lastHostCall");
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
            worker = new MontyWorker(binary);
            ChildEvent progress;
            ToolScriptDataBudget progressBudget;
            if (resume is null)
            {
                var configured = await worker.ConfigureAsync(
                    Required(record, "scriptName"),
                    Number(record["timeoutSecs"], 30),
                    Budget(),
                    run.Token
                );
                if (configured.KindCase != ChildEvent.KindOneofCase.Ok)
                    throw new InvalidDataException(
                        "Monty configure did not acknowledge the qualified version."
                    );
                var budget = Budget();
                budget.Charge(8L * System.Text.Encoding.UTF8.GetByteCount(code!));
                var feed = new Feed { Code = code! };
                feed.Inputs.Add(
                    new NamedValue { Name = "args", Value = MontyValues.FromJson(input, budget) }
                );
                progressBudget = budget;
                progress = await worker.TurnAsync(
                    new() { Feed = feed },
                    progressBudget,
                    stdout.Append,
                    run.Token
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
                progress = await worker.TurnAsync(
                    new() { Load = new Load { State = ByteString.CopyFrom(snapshot) } },
                    progressBudget,
                    stdout.Append,
                    run.Token
                );
                if (progress.KindCase != ChildEvent.KindOneofCase.FunctionCall)
                    throw new InvalidDataException(
                        "ToolScript persisted snapshot is not a resumable host-call snapshot."
                    );
                record.Remove("waiting");
                record.Remove("snapshotBase64");
                oldSnapshot = null;
                restoredSnapshot = null;
                progressBudget = Budget();
                progress = await ResumeAsync(
                    worker,
                    progress.FunctionCall.CallId,
                    resume,
                    progressBudget,
                    stdout,
                    run.Token
                );
                resume = null;
            }
            while (true)
            {
                run.Token.ThrowIfCancellationRequested();
                context.Owner.Entry.RequireIdentityAuthority();
                if (progress.KindCase == ChildEvent.KindOneofCase.Complete)
                {
                    record["lastResult"] = MontyValues.ToJson(
                        progress.Complete.Value,
                        progressBudget
                    );
                    record["status"] = "completed";
                    record["completedAt"] = Now();
                    record.Remove("waiting");
                    record.Remove("snapshotBase64");
                    await CommitAsync();
                    return Project(record, true, stdout.Delta(offset));
                }
                if (progress.KindCase == ChildEvent.KindOneofCase.Error)
                    throw new InvalidDataException(
                        progress.Error.Exception.ExcType + ": " + progress.Error.Exception.Message
                    );
                if (progress.KindCase == ChildEvent.KindOneofCase.NameLookup)
                {
                    var name = progress.NameLookup.Name;
                    progressBudget = Budget();
                    progress = await worker.TurnAsync(
                        new()
                        {
                            ResumeNameLookup = new ResumeNameLookup
                            {
                                Value = new() { Function = new Function { Name = name } },
                            },
                        },
                        progressBudget,
                        stdout.Append,
                        run.Token
                    );
                    continue;
                }
                if (progress.KindCase == ChildEvent.KindOneofCase.OsCall)
                {
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
                        stdout.Append,
                        run.Token
                    );
                    continue;
                }
                if (progress.KindCase != ChildEvent.KindOneofCase.FunctionCall)
                    throw new InvalidDataException(
                        "Unsupported Monty suspension: " + progress.KindCase
                    );
                var call = progress.FunctionCall;
                var hostBudget = progressBudget;
                var positional = new JsonArray();
                var kwargs = new JsonObject();
                foreach (var value in call.Args)
                    positional.Add(MontyValues.ToJson(value, hostBudget));
                foreach (var pair in call.Kwargs)
                    kwargs[
                        MontyValues.ToJson(pair.Key, hostBudget)?.GetValue<string>()
                            ?? throw new InvalidDataException(
                                "Monty keyword name must be a string."
                            )
                    ] = MontyValues.ToJson(pair.Value, hostBudget);
                if (call.FunctionName == "ask_agent")
                {
                    var question = positional.Count > 0 ? positional[0] : kwargs["question"];
                    hostBudget.JsonValue(question);
                    var text =
                        question is JsonValue q && q.TryGetValue<string>(out var str)
                            ? str
                            : question?.ToJsonString() ?? "null";
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
                    return Project(record, true, stdout.Delta(offset));
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
                run.Token.ThrowIfCancellationRequested();
                context.Owner.Entry.RequireIdentityAuthority();
                if (slice.Elapsed.TotalSeconds >= Number(record["timeoutSecs"], 30))
                {
                    await WaitAsync("timeout", null, outcome);
                    return Project(record, true, stdout.Delta(offset));
                }
                progressBudget = Budget();
                progress = await ResumeAsync(
                    worker,
                    call.CallId,
                    outcome,
                    progressBudget,
                    stdout,
                    run.Token
                );
            }
            async Task WaitAsync(string reason, JsonObject? fields, JsonObject? pending)
            {
                var budget = Budget();
                var dump = await worker.TurnAsync(
                    new() { Dump = new Dump() },
                    budget,
                    stdout.Append,
                    run.Token
                );
                if (dump.KindCase != ChildEvent.KindOneofCase.DumpResult)
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
                        ["elapsedMs"] = slice.Elapsed.TotalMilliseconds,
                        ["pausedAtFunctionName"] = "call_tool",
                        ["pausedAtSummaryName"] = record["lastHostCall"]
                            ?["functionName"]?.DeepClone(),
                    };
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
                record["error"] = error.Message;
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
            var result = Project(record, true, stdout.Delta(offset));
            result["error"] = error.Message;
            if (persistenceFailure)
                result["recordPersistenceFailed"] = true;
            return result;
        }
        finally
        {
            if (worker is not null)
                await worker.DisposeAsync();
            active.TryRemove(id, out _);
            run.Cancel.Dispose();
        }
    }

    private static JsonObject Failure(string type, string message) =>
        new()
        {
            ["mode"] = "exception",
            ["exception"] = new JsonObject { ["type"] = type, ["message"] = message },
        };

    private static Task<ChildEvent> ResumeAsync(
        MontyWorker worker,
        uint id,
        JsonObject outcome,
        ToolScriptDataBudget budget,
        ToolScriptStdout stdout,
        CancellationToken token
    )
    {
        var result = new ExtFunctionResult();
        if (Text(outcome["mode"]) == "exception")
            result.Error = new RaisedException
            {
                ExcType = Text(outcome["exception"]?["type"]) ?? "RuntimeError",
                Message = Text(outcome["exception"]?["message"]) ?? "ToolScript host call failed.",
            };
        else if (Text(outcome["mode"]) == "return")
            result.ReturnValue = MontyValues.FromJson(outcome["value"], budget);
        else
            throw new InvalidDataException("Unknown ToolScript pending resume mode.");
        return worker.TurnAsync(
            new()
            {
                ResumeCall = new ResumeCall { CallId = id, Result = result },
            },
            budget,
            stdout.Append,
            token
        );
    }
}

internal sealed class ToolScriptHostFatalException(Exception inner)
    : IOException(inner.Message, inner);
