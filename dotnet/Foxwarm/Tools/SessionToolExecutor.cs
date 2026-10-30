using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor(
    ITurnToolExecutor workspace,
    SessionOwner hosted,
    SessionManager sessions,
    ToolRegistry registry,
    bool unattended = false
) : ITurnToolExecutor, ITurnToolControl
{
    private int finishPending;
    private long? foregroundBatch;
    internal bool BatchCompacted { get; private set; }
    private int policyUnavailable;
    private readonly List<TurnToolReceipt> turnReceipts = [];
    public bool PolicyUnavailable => Volatile.Read(ref policyUnavailable) != 0;
    internal WorkspaceTools? Files =>
        invocation.Value?.Files
        ?? (workspace is WorkspaceTools ? sessions.IdentityWorkspace(hosted) : null);

    internal ClaudeRuntimeRun? ExternalRun { get; set; }

    internal async Task AuthorizeAsync(ResolvedTool resolved, CancellationToken token)
    {
        void RequireRuntime()
        {
            if (
                ClaudeRuntimeState.IsExternal(hosted.Entry.Snapshot().AuthorityEnvelope)
                && !unattended
            )
            {
                (
                    ExternalRun
                    ?? throw new InvalidOperationException("No current external runtime run.")
                ).Require();
                ClaudeRuntimeToolSupport.Require(hosted, sessions, resolved);
            }
        }
        RequireRuntime();
        await sessions.AuthorizeToolAsync(
            hosted,
            resolved,
            resolved.Name is "run_script" or "start_toolscript_run"
                    ? invocation.Value?.ScriptSource?.Files ?? Files
                : resolved.Name == "artifact" && ToolRegistry.ArtifactFileSource(resolved.Args)
                    ? ArtifactFiles(resolved.ExecutionNode)
                : resolved.Name == "exec" ? ExecFiles
                : Files,
            token
        );
        RequireRuntime();
    }

    private readonly List<string> explicitWaitIds = [];
    private readonly List<string> handoffTargets = [];
    internal SessionOwner Hosted => hosted;
    internal MainBrowserTools Browser => sessions.Browser;
    internal bool HandoffConfirmationEnabled => sessions.HandoffConfirmationEnabled;
    private SessionManager Manager => sessions;
    private readonly AsyncLocal<TurnToolInvocation?> invocation = new();

    private sealed record ExecSnapshot(string Node, string? Cwd);

    internal string ExecutionNode =>
        invocation.Value?.Node ?? execSnapshot.Value?.Node ?? sessions.CurrentNode(hosted);
    internal string? ExecutionCwd =>
        invocation.Value is { } active ? active.Cwd
        : execSnapshot.Value is { } captured ? captured.Cwd
        : SessionWait.Text(hosted.Entry.Snapshot().AuthorityEnvelope["cwd"]);

    private readonly AsyncLocal<ExecSnapshot?> execSnapshot = new();

    internal Action<JsonNode?>? RemoteCodePaths(ResolvedTool resolved)
    {
        var active = invocation.Value;
        if (active is null || resolved.Name is not ("read" or "write" or "edit" or "apply_patch"))
            return null;
        var nodeId = resolved.ExecutionNode;
        return raw =>
        {
            if (
                raw is not JsonObject value
                || value["__foxwarmResolvedToolPaths"] is not JsonArray paths
                || paths.Count is < 1 or > 100
            )
                return;
            var captured = new JsonArray();
            foreach (var item in paths)
            {
                if (
                    item is not JsonObject path
                    || SessionWait.Text(path["raw"]) is not string original
                    || SessionWait.Text(path["resolved"]) is not string remotePath
                    || !remotePath.StartsWith('/')
                    || remotePath.Contains('\0')
                    || remotePath.Length > 4096
                )
                    return;
                captured.Add(
                    new JsonObject
                    {
                        ["raw"] = original,
                        ["resolved"] = remotePath,
                        ["nodeId"] = nodeId,
                    }
                );
            }
            // Display-only evidence in the captured remote namespace, never Main path/control authority.
            active.ResolvedPaths = captured;
        };
    }

    internal bool ToolScriptExecution => invocation.Value?.ToolScriptSubCalls is not null;
    internal string CurrentCallId => invocation.Value?.CallId ?? "";
    internal string? DirectExecWorkspace => execSnapshot.Value?.Cwd;
    private WorkspaceTools ExecFiles =>
        invocation.Value?.ExecFiles ?? sessions.IdentityWorkspace(hosted, execSnapshot.Value?.Cwd);

    internal IDisposable CaptureDirectExecSegment()
    {
        var previous = execSnapshot.Value;
        var placement = sessions.ExecutionPlacement(hosted);
        execSnapshot.Value = new(placement.Node, placement.Cwd);
        return new ExecSegmentScope(() => execSnapshot.Value = previous);
    }

    private sealed class ExecSegmentScope(Action restore) : IDisposable
    {
        public void Dispose() => restore();
    }

    internal async Task<TurnToolPreparation?> PrepareDirectExecAsync(
        JsonObject call,
        CancellationToken token
    )
    {
        try
        {
            var args =
                call["args"] as JsonObject
                ?? throw new InvalidDataException("Tool arguments must be an object.");
            var resolved = await registry.ResolveAsync(
                "exec",
                args,
                execSnapshot.Value?.Node ?? sessions.CurrentNode(hosted),
                token
            );
            await AuthorizeAsync(resolved, token);
            return null;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return new(
                UnsupportedTurnToolExecutor.ToolError(
                    "tool_call_cancelled",
                    "Tool call canceled before execution."
                )
            );
        }
        catch (ToolAuthorizationUnavailableException error)
        {
            return new(
                UnsupportedTurnToolExecutor.ToolError(
                    ToolAuthorizationUnavailableException.Code,
                    error.Message
                ),
                true
            );
        }
        catch (ToolAuthorizationDeniedException error)
        {
            return new(
                UnsupportedTurnToolExecutor.ToolError("tool_authorization_denied", error.Message)
            );
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or InvalidOperationException
                        or IOException
                        or ArgumentException
                        or NotSupportedException
            )
        {
            return new(UnsupportedTurnToolExecutor.ToolError("tool_error", error.Message));
        }
    }

    internal TurnToolExecution PreparedFailure(TurnToolPreparation prepared)
    {
        if (prepared.PolicyUnavailable)
            Interlocked.Exchange(ref policyUnavailable, 1);
        return new((JsonObject)prepared.Response.DeepClone());
    }

    internal async Task<TurnToolExecution> ExecuteAttributedAsync(
        JsonObject call,
        CancellationToken token,
        int? index = null,
        int? total = null
    )
    {
        await sessions.WaitForIdentityMutationAsync(hosted.Id, token);
        hosted.Entry.RequireIdentityAuthority();
        var previous = invocation.Value;
        var placement = sessions.ExecutionPlacement(hosted);
        var captured =
            (!Programmatic ? execSnapshot.Value : null)
            ?? new ExecSnapshot(placement.Node, placement.Cwd);
        var current = new TurnToolInvocation(SessionWait.Text(call["id"]) ?? "")
        {
            Files = workspace is WorkspaceTools ? sessions.IdentityWorkspace(hosted) : null,
            Node = captured.Node,
            Cwd = captured.Cwd,
            Index = index,
            Total = total,
        };
        invocation.Value = current;
        try
        {
            var response = await ExecuteCoreAsync(call, token);
            if (!unattended && !Programmatic && current.Receipt is not null)
                turnReceipts.Add(current.Receipt);
            return new(
                response,
                current.Timing,
                (response as JsonObject)?["error"] is null ? current.ResolvedPaths : null,
                current.DeferredCwd,
                current.ToolScriptSubCalls,
                current.Receipt,
                current.SessionMessages,
                current.DeferredCwdNode
            );
        }
        finally
        {
            invocation.Value = previous;
        }
    }

    internal void BeginBatch(JsonObject canonicalAssistant)
    {
        foregroundBatch = CompactCandidateBuilder.Number(canonicalAssistant["__meta"]?["seq"]);
        BatchCompacted = false;
    }

    internal async Task EndBatchAsync()
    {
        var sequence = foregroundBatch;
        foregroundBatch = null;
        if (sequence is long seq)
            await hosted.Compactor.DiscardUnpairedInContextAsync(seq);
    }

    public void BeginTurn()
    {
        hosted.BeginLogicalTurn();
        Volatile.Write(ref policyUnavailable, 0);
        Interlocked.Exchange(ref finishPending, 0);
        explicitWaitIds.Clear();
        handoffTargets.Clear();
        turnReceipts.Clear();
    }

    internal IReadOnlyList<TurnToolReceipt> ConsumeReceipts()
    {
        var receipts = turnReceipts.ToArray();
        turnReceipts.Clear();
        return receipts;
    }

    public bool ConsumeFinishAfterBatch() => Interlocked.Exchange(ref finishPending, 0) == 1;

    public async Task<TurnBatchEnding> CompleteBatchAsync(JsonObject toolMessage, bool stopping)
    {
        var errors = toolMessage["parts"]!
            .AsArray()
            .Any(part =>
                (part?["functionResponse"]?["response"] as JsonObject)?["error"] is not null
            );
        var explicitStop = explicitWaitIds.Count > 0;
        if (errors || stopping)
            foreach (var id in explicitWaitIds)
                await hosted.Entry.SaveLane.ClearWaitAsync(id);
        explicitWaitIds.Clear();
        var finish = ConsumeFinishAfterBatch();
        var handoff = handoffTargets.Count > 0;
        if (PolicyUnavailable)
        {
            handoffTargets.Clear();
            throw new ToolAuthorizationUnavailableException();
        }
        if (!errors && !stopping && handoff && hosted.WaitSnapshot() is null)
            await sessions.StartHandoffWaitAsync(hosted, handoffTargets);
        handoffTargets.Clear();
        var ending =
            errors ? TurnBatchEnding.Continue
            : finish ? TurnBatchEnding.Finished
            : !stopping && (handoff || explicitStop) ? TurnBatchEnding.Suspended
            : TurnBatchEnding.Continue;
        if (
            foregroundBatch is not null
            && hosted.Compactor.PairInContextSubmission(toolMessage)
            && ending != TurnBatchEnding.Continue
            && !stopping
        )
            BatchCompacted = await hosted.Compactor.SafePointAsync() == true;
        return ending;
    }

    public async Task<JsonNode?> ExecuteAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    ) => (await ExecuteAttributedAsync(functionCall, cancellationToken)).Response;

    private JsonObject ToolRuntime(ResolvedTool resolved)
    {
        var current = invocation.Value;
        var result = new JsonObject
        {
            ["id"] = current?.CallId,
            ["name"] = resolved.Name,
            ["source"] = resolved.Source,
            ["index"] = current?.Index,
            ["total"] = current?.Total,
            ["executionNode"] = resolved.ExecutionNode,
            ["argsPreview"] = ToolArgsPreview(resolved.Name, resolved.Args),
            ["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        if (resolved.Name != resolved.InvocationName)
            result["invocationName"] = resolved.InvocationName;
        if (resolved.Server is not null)
            result["server"] = resolved.Server;
        if (
            resolved.Source == "builtin"
            && resolved.Name == "node"
            && SessionWait.Text(resolved.Args["action"]) is { } action
        )
            result["action"] = SessionOwner.Bound(action, 64);
        if (
            resolved.Source == "node"
            && resolved.Name == "read"
            && SessionWait.Text(resolved.Args["filePath"]) is { } file
        )
            result["target"] = SessionOwner.Bound(file.Split(['/', '\\']).Last(), 160);
        return result;
    }

    internal void BroadcastVerboseToolStart(JsonObject call)
    {
        if (
            Programmatic
            || unattended
            || !hosted.Entry.WithState(state =>
                SessionCatalog.Flag(state.AuthorityEnvelope["verbose"])
            )
        )
            return;
        var name = SessionWait.Text(call["name"]) ?? "";
        var raw = SessionWait.Text(call["argsParseError"]) is { Length: > 0 }
            ? SessionWait.Text(call["rawArgsText"])
            : null;
        sessions.BroadcastTransientText(
            hosted,
            $"🛠 *[{name}]*: `{ToolArgsPreview(name, call["args"] as JsonObject ?? new JsonObject(), raw)}`"
        );
    }

    internal static string ToolArgsPreview(string name, JsonObject args, string? rawArgsText = null)
    {
        static string Text(JsonNode? value) =>
            SessionWait.Text(value) ?? (value is null ? "null" : EcmaJson.Stringify(value));
        var preview =
            rawArgsText
            ?? (
                name switch
                {
                    "exec" => Text(args["command"]),
                    "edit" or "write" or "edit_memory" or "write_memory" or "delete_memory" => Text(
                        args["filePath"]
                    ),
                    "apply_patch" or "apply_patch_memory" => SessionWait.Text(args["input"]) ?? "",
                    "read" or "read_memory" => (SessionWait.Text(args["filePath"]) ?? "")
                        + (
                            SessionWait.Number(args["startLine"]) is > 0
                                ? $" (lines {Text(args["startLine"])}-{Text(args["endLine"])})"
                                : ""
                        ),
                    _ => args.Count == 1
                        ? Text(args.First().Value)
                        : string.Join(
                            '\n',
                            args.Select(pair => pair.Key + ": " + Text(pair.Value))
                        ),
                }
            );
        return preview.Length > 200 ? preview[..197] + "..." : preview;
    }

    private async Task<JsonNode?> ExecuteCoreAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        var dispatched = false;
        try
        {
            if (!unattended)
                hosted.Registry.Runner.AssertCanContinue();
            var name = SessionWait.Text(functionCall["name"]) ?? "";
            var args =
                functionCall["args"] as JsonObject
                ?? throw new InvalidDataException("Tool arguments must be an object.");
            var compactCall = CompactSubmissionCall(functionCall);
            if (compactCall?["argsParseError"] is not null && name == "call_tool")
            {
                args = (JsonObject)args.DeepClone();
                args.Remove("argsJson");
                args["args"] = new JsonObject();
            }
            if (invocation.Value is { } compactInvocation)
                compactInvocation.CompactCall = compactCall;
            var resolved = await registry.ResolveAsync(
                name,
                args,
                ExecutionNode,
                cancellationToken
            );
            if (
                resolved.Name is "run_script" or "start_toolscript_run"
                && invocation.Value is { } scriptCall
            )
            {
                var sourceNode = ToolRegistry.ToolScriptSourceNode(resolved.Args, scriptCall.Node);
                if (sourceNode is not null)
                {
                    var cwd =
                        sourceNode == "master" || sourceNode == scriptCall.Node
                            ? scriptCall.Cwd
                            : null;
                    scriptCall.ScriptSource = new(
                        sourceNode,
                        cwd,
                        sessions.IdentityWorkspace(hosted, cwd, "master", useLiveCwd: false)
                    );
                }
            }
            while (true)
            {
                await sessions.WaitForIdentityMutationAsync(hosted.Id, cancellationToken);
                hosted.Entry.RequireIdentityAuthority();
                var identity = hosted.Id;
                if (invocation.Value is { } current && workspace is WorkspaceTools)
                {
                    current.Files = sessions.IdentityWorkspace(hosted, current.Cwd, current.Node);
                    current.ExecFiles = sessions.IdentityWorkspace(
                        hosted,
                        current.Cwd,
                        current.Node
                    );
                }
                if (invocation.Value?.Files is { } files)
                {
                    files.Programmatic = Programmatic;
                    files.ScriptBudget = ScriptBudget;
                    files.ResolvedPaths = paths =>
                        invocation.Value!.ResolvedPaths = (JsonArray)paths.DeepClone();
                }
                await AuthorizeAsync(resolved, cancellationToken);
                if (identity == hosted.Id)
                    break;
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (!unattended)
                hosted.Registry.Runner.AssertCanContinue();
            BroadcastVerboseToolStart(functionCall);
            dispatched = true;
            var runtimeLease =
                Programmatic || unattended ? null : hosted.BeginTool(ToolRuntime(resolved));
            var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var monotonic = System.Diagnostics.Stopwatch.GetTimestamp();
            try
            {
                return await registry.ExecuteAsync(resolved, this, cancellationToken);
            }
            finally
            {
                if (invocation.Value is { } current)
                    current.Timing = new JsonObject
                    {
                        ["startedAt"] = startedAt,
                        ["completedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        ["durationMs"] = System
                            .Diagnostics.Stopwatch.GetElapsedTime(monotonic)
                            .TotalMilliseconds,
                    };
                if (runtimeLease is not null)
                    hosted.EndTool(runtimeLease);
            }
        }
        catch (TaskError error)
        {
            return UnsupportedTurnToolExecutor.ToolError(error.Code, error.Message);
        }
        catch (ToolAuthorizationUnavailableException error)
        {
            Interlocked.Exchange(ref policyUnavailable, 1);
            return UnsupportedTurnToolExecutor.ToolError(
                ToolAuthorizationUnavailableException.Code,
                error.Message
            );
        }
        catch (ToolAuthorizationDeniedException error)
        {
            if (Programmatic)
                throw;
            return UnsupportedTurnToolExecutor.ToolError(
                "tool_authorization_denied",
                error.Message
            );
        }
        catch (ArgumentException error)
        {
            if (Programmatic)
                throw;
            return UnsupportedTurnToolExecutor.ToolError("invalid_path", error.Message);
        }
        catch (UnauthorizedAccessException error)
        {
            if (Programmatic)
                throw;
            return UnsupportedTurnToolExecutor.ToolError("tool_io_error", error.Message);
        }
        catch (OperationCanceledException error)
            when (cancellationToken.IsCancellationRequested || error is SessionTurnShutdownException
            )
        {
            var source =
                hosted.Registry.Runner.Closing && !hosted.Entry.WithState(state => state.Stopping)
                    ? "process shutdown"
                    : hosted.Entry.ToolCancellationSource;
            return UnsupportedTurnToolExecutor.ToolError(
                "tool_call_cancelled",
                dispatched
                    ? $"Tool request canceled by {source} after dispatch. Started effects may have occurred and were not reversed."
                    : $"Tool call was not started because {source} cancelled it; it was not executed."
            );
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or InvalidOperationException
                        or IOException
                        or System.Text.Json.JsonException
                        or NotSupportedException
                        or TimeoutException
                        or System.ComponentModel.Win32Exception
            )
        {
            if (Programmatic)
                throw;
            return UnsupportedTurnToolExecutor.ToolError("tool_error", error.Message);
        }
    }

    private async Task<JsonObject> ExecuteTaskAsync(JsonObject args, CancellationToken token)
    {
        var (response, completionTarget) = await Manager
            .Tasks.ExecuteForToolWithReceiptAsync(Hosted, args)
            .ConfigureAwait(false);
        var action = SessionWait.Text(args["action"]);
        var visible =
            action is "create" or "claim" or "assign" or "update" or "complete" or "cancel"
            && response["task"] is JsonObject taskResult
                ? new JsonObject
                {
                    ["taskId"] = SessionWait.Text(taskResult["id"]),
                    ["status"] = SessionWait.Text(taskResult["status"]),
                    ["ownerSessionId"] = taskResult["ownerSessionId"]?.DeepClone(),
                }
                : response;
        if (response["sentNotifications"] is JsonNode sent)
            visible["sentNotifications"] = sent.DeepClone();
        if (response["warning"] is JsonNode warning)
            visible["warning"] = warning.DeepClone();
        if (
            SessionWait.Text(args["action"]) == "complete"
            && response["task"] is JsonObject task
            && SessionWait.Text(task["attachedSessionId"]) == Hosted.Id
        )
        {
            invocation.Value!.Receipt = new TurnToolReceipt(
                null,
                SessionWait.Text(task["id"]),
                Hosted.Id
            );
        }
        else if (completionTarget is not null)
            invocation.Value!.Receipt = new TurnToolReceipt(completionTarget, null, null);
        return visible;
    }

    private async Task<JsonObject> ExecuteExecAsync(JsonObject args, CancellationToken token)
    {
        await hosted.Entry.SaveLane.SaveStrictAsync();
        string? initial = null;
        string? observed = null;
        var response = await hosted.Executor.ExecuteAsync(
            hosted.Id,
            args,
            token,
            paths: ExecFiles.Paths,
            observeCwd: (start, end) =>
            {
                initial = start;
                observed = end;
            },
            programmatic: ScriptBudget,
            cancellationSource: () => hosted.Entry.ToolCancellationSource,
            beforeLaunch: () =>
            {
                hosted.Entry.RequireIdentityAuthority();
                if (!unattended)
                    hosted.Registry.Runner.AssertCanContinue();
            }
        );
        if (observed is null)
            return response;
        if (execSnapshot.Value is not null)
        {
            if (invocation.Value is { } current)
                current.DeferredCwd = observed;
            return response;
        }
        return observed == initial ? response : await ApplyCwdAsync(response, observed);
    }

    internal async Task<JsonObject> ExecuteProviderExecAsync(
        ResolvedTool resolved,
        CancellationToken token
    )
    {
        var backend = await registry.Providers!.AdmitExecAsync(resolved.ExecutionNode, token);
        string? observed = null;
        var response = await hosted.Executor.ExecuteAsync(
            hosted.Id,
            resolved.Args,
            token,
            observeCwd: (_, end) => observed = end,
            programmatic: ScriptBudget,
            cancellationSource: () => hosted.Entry.ToolCancellationSource,
            backend: backend,
            providerCwd: ExecutionNode == resolved.ExecutionNode ? ExecutionCwd : null,
            beforeLaunch: () =>
            {
                hosted.Entry.RequireIdentityAuthority();
                if (!unattended)
                    hosted.Registry.Runner.AssertCanContinue();
            },
            hardCancellation: hosted.Entry.IdentityLossToken
        );
        if (observed is null)
            return response;
        if (execSnapshot.Value is not null)
        {
            if (invocation.Value is { } current)
            {
                current.DeferredCwd = observed;
                current.DeferredCwdNode = resolved.ExecutionNode;
            }
            return response;
        }
        return await ApplyCwdAsync(response, observed, resolved.ExecutionNode);
    }

    internal async Task<TurnToolExecution> ReplayCwdAsync(TurnToolExecution execution)
    {
        if (execution.DeferredCwd is not string cwd)
            return execution;
        try
        {
            return execution with
            {
                Response = await ApplyCwdAsync(
                    execution.Response!.AsObject(),
                    cwd,
                    execution.DeferredCwdNode
                ),
                DeferredCwd = null,
                DeferredCwdNode = null,
            };
        }
        catch (Exception error)
            when (error is IOException or InvalidOperationException or ArgumentException)
        {
            return execution with
            {
                Response = UnsupportedTurnToolExecutor.ToolError("tool_error", error.Message),
                DeferredCwd = null,
                DeferredCwdNode = null,
                ResolvedPaths = null,
            };
        }
    }

    private async Task<JsonObject> ApplyCwdAsync(
        JsonObject response,
        string cwd,
        string? providerNode = null
    )
    {
        var change = providerNode is null
            ? await hosted.UpdateCwdAsync(cwd)
            : await sessions.UpdateProviderExecCwdAsync(hosted, providerNode, cwd);
        if (change["changed"]?.GetValue<bool>() != true)
            return response;
        var copy = (JsonObject)response.DeepClone();
        var previous = SessionWait.Text(change["previous"]);
        var notice = previous is null
            ? $"SESSION CWD CHANGED: `{cwd}`."
            : $"SESSION CWD CHANGED: `{previous}` → `{cwd}`.";
        copy["output"] =
            (SessionWait.Text(copy["output"]) ?? "(No output)")
            + "\n\n"
            + notice
            + " This cwd will be used as the default cwd for subsequent exec/read/edit/write/apply_patch tool calls.";
        return copy;
    }

    private async Task<JsonObject> ExecuteWorkspaceAsync(
        string name,
        JsonObject args,
        CancellationToken token
    ) =>
        (
            await (Files as ITurnToolExecutor ?? workspace).ExecuteAsync(
                new JsonObject { ["name"] = name, ["args"] = args.DeepClone() },
                token
            )
        )!.AsObject();

    private async Task<JsonObject> ExecuteAgentAsync(
        string name,
        JsonObject args,
        CancellationToken cancellationToken
    )
    {
        sessions.BeginSuccessfulSendReceipt();
        var (response, finish) = await sessions.ExecuteAgentToolAsync(
            hosted,
            name,
            args,
            cancellationToken,
            (target, body) =>
            {
                if (invocation.Value is not { } current)
                    return;
                var delivery = new JsonObject
                {
                    ["id"] = current.CallId,
                    ["targetSessionId"] = target,
                    ["message"] = SessionOwner.Bound(body, 32768),
                };
                if (body.Length > 32768)
                    delivery["truncated"] = true;
                current.SessionMessages = new JsonArray(delivery);
            },
            scriptScope.Value?.RunId
        );
        if (
            !unattended
            && !Programmatic
            && sessions.ConsumeSuccessfulSendReceipt() is { } receiptTarget
        )
            invocation.Value!.Receipt = new TurnToolReceipt(receiptTarget, null, null);
        if (
            response.Remove("__waitTarget", out var target) && SessionWait.Text(target) is string id
        )
            if (!unattended)
                handoffTargets.Add(id);
        if (finish && !unattended)
            Interlocked.Exchange(ref finishPending, 1);
        return response;
    }

    private async Task<JsonObject> ExecuteWaitAsync(JsonObject args)
    {
        try
        {
            if (scriptScope.Value is { } script)
            {
                sessions.ValidateWait(hosted, args);
                script.WaitScope.Pending = (JsonObject)args.DeepClone();
                return new JsonObject { ["output"] = "Waiting for new Session activity." };
            }
            var id = await sessions.DeclareWaitAsync(hosted, args);
            if (id is not null)
                explicitWaitIds.Add(id);
            return new JsonObject { ["output"] = "Waiting for new Session activity." };
        }
        catch (Exception error)
            when (error is InvalidDataException or InvalidOperationException or IOException)
        {
            if (error is CommittedWaitDeclarationException committed)
                explicitWaitIds.Add(committed.WaitId);
            return UnsupportedTurnToolExecutor.ToolError("wait_error", error.Message);
        }
    }

    internal static ToolRegistry CreateRegistry(
        JsonArray definitions,
        Foxwarm.McpClient mcp,
        Func<SessionOwner, string> path,
        Foxwarm.Nodes.NodeConnectionHub? nodes = null,
        Foxwarm.Nodes.NodeProviderRegistry? providers = null
    )
    {
        var registry = new ToolRegistry(mcp, path, nodes, providers);
        var handlers = new Dictionary<
            string,
            Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonObject>>
        >(StringComparer.Ordinal);
        foreach (var name in new[] { "read", "write", "edit", "apply_patch" })
            handlers[name] = (owner, args, token) => owner.ExecuteWorkspaceAsync(name, args, token);
        handlers["exec"] = (owner, args, token) => owner.ExecuteExecAsync(args, token);
        handlers["artifact"] = (owner, args, token) => owner.ExecuteArtifactAsync(args, token);
        handlers["recall"] = (owner, args, token) =>
            ArchiveRecallTool.ExecuteAsync(owner.Manager, owner.Hosted, args, token);
        handlers["get_archived_messages"] = (owner, args, token) =>
            ArchiveControlTools.ReadMessagesAsync(owner.Manager, owner.Hosted, args, token);
        handlers["get_archived_blocks"] = (owner, args, token) =>
            ArchiveControlTools.ReadBlocksAsync(owner.Manager, owner.Hosted, args, token);
        handlers["stop_session"] = (owner, args, token) =>
            ArchiveControlTools.StopAsync(owner.Manager, owner.Hosted, args, token);
        handlers["wait"] = (owner, args, _) => owner.ExecuteWaitAsync(args);
        handlers["submit_compact_plan"] = (owner, args, token) =>
            owner.SubmitCompactPlanAsync(args, token);
        handlers["task"] = (owner, args, token) => owner.ExecuteTaskAsync(args, token);
        foreach (
            var name in new[]
            {
                "move_session",
                "delete_session",
                "create_agent",
                "set_agent_isolated",
                "create_session",
                "create_child_session",
                "send_to_session",
                "refresh_session_snapshot",
                "skill",
                "set_agent_inherit",
                "set_agent_rules",
                "session",
                "view_session",
                "set_session_child_model",
                "set_session_compact_threshold",
                "compact_session",
            }
        )
            handlers[name] = (owner, args, token) => owner.ExecuteAgentAsync(name, args, token);
        foreach (
            var name in new[]
            {
                "run_script",
                "start_toolscript_run",
                "continue_script",
                "list_toolscript_runs",
                "get_toolscript_run",
                "cancel_toolscript_run",
            }
        )
            handlers[name] = (owner, args, token) =>
                owner.ExecuteToolScriptAsync(name, args, token);
        foreach (
            var name in new[] { "create_timer", "list_timers", "update_timer", "delete_timer" }
        )
            handlers[name] = (owner, args, token) =>
                owner.Manager.ExecuteTimerToolAsync(owner.Hosted, name, args, token);
        handlers["copy_between_nodes"] = (owner, args, token) =>
            owner.Manager.CopyBetweenNodesAsync(owner.Hosted, args, token);
        handlers["send_file"] = (owner, args, token) =>
            owner.Manager.SendFileAsync(
                owner.Hosted,
                owner.Files
                    ?? throw new NotSupportedException("This executor has no file resolver."),
                args,
                token,
                owner.ExecutionNode
            );
        handlers["image_write_to_file"] = (owner, args, token) =>
            owner.Manager.ExportImageAsync(
                owner.Hosted,
                owner.Files
                    ?? throw new NotSupportedException("This executor has no file resolver."),
                args,
                token,
                owner.ExecutionNode
            );
        handlers["image_crop"] = (owner, args, token) =>
            owner.Manager.CropImageAsync(owner.Hosted, args, token);
        foreach (
            var name in new[]
            {
                "read_memory",
                "write_memory",
                "edit_memory",
                "delete_memory",
                "apply_patch_memory",
            }
        )
            handlers[name] = (owner, args, token) =>
                MemoryTools.ExecuteAsync(owner.Hosted, owner.Manager, name, args, token);
        handlers["list_agents"] = (owner, _, _) =>
            Task.FromResult(new JsonObject { ["output"] = owner.Manager.ListAgentsText() });
        handlers["set_config"] = (owner, args, token) =>
            owner.Manager.InstallConfigAsync(
                owner.Hosted,
                owner.Files ?? throw new NotSupportedException("This executor has no file reader."),
                args,
                token
            );
        handlers["node"] = (owner, args, token) =>
            owner.Manager.ExecuteNodeToolAsync(owner.Hosted, args, token, owner.Programmatic);
        handlers["node_create_auth_token"] = (owner, args, token) =>
            owner.Manager.CreateNodeAuthTokenAsync(owner.Hosted, args, token);
        handlers["node_remove"] = (owner, args, token) =>
            owner.Manager.RemoveNodeAsync(owner.Hosted, args, token);
        handlers["node_bootstrap_info"] = (owner, args, _) =>
            Task.FromResult(owner.Manager.NodeBootstrapInfo(args));
        handlers["node_pair_list"] = (owner, args, _) =>
            Task.FromResult(owner.Manager.NodePairList(args));
        handlers["node_pair_approve"] = (owner, args, _) =>
            owner.Manager.NodePairApproveAsync(args, owner.Hosted);
        handlers["search_tools"] = (owner, args, token) =>
            UnifiedTools.SearchAsync(
                registry,
                args,
                token,
                (source, name, server) =>
                    owner.Manager.ToolVisible(
                        owner.Hosted,
                        source,
                        name,
                        source == "mcp" ? server : null,
                        node: source == "node" ? server : null
                    ),
                owner.ScriptBudget,
                owner.Hosted
            );
        handlers["call_tool"] = (_, _, _) =>
            throw new InvalidDataException("call_tool is a dispatcher, not a concrete target.");
        handlers["mcp_notifications"] = (owner, args, token) =>
            owner.Manager.ManageMcpNotificationsAsync(owner.Hosted, args, token);
        handlers["send_to_channel"] = (owner, args, token) =>
            owner.Manager.SendToChannelAsync(owner.Hosted, args, token);
        handlers["mcp_config"] = (_, args, token) => mcp.ConfigureAsync(args, token);
        handlers["list_mcp_servers"] = (_, args, token) =>
        {
            ToolRegistry.Keys(args, []);
            return mcp.ListServersAsync(token);
        };
        foreach (var definition in definitions.OfType<JsonObject>())
        {
            var name = SessionWait.Text(definition["name"])!;
            var source = name is "read" or "write" or "edit" or "apply_patch" or "exec"
                ? "node"
                : "builtin";
            registry.Register(
                definition,
                source,
                name
                    is not (
                        "set_session_child_model"
                        or "set_session_compact_threshold"
                        or "refresh_session_snapshot"
                        or "compact_session"
                        or "create_agent"
                        or "create_session"
                        or "set_agent_inherit"
                        or "set_agent_rules"
                        or "artifact"
                        or "mcp_config"
                        or "mcp_notifications"
                        or "set_agent_isolated"
                        or "node_create_auth_token"
                        or "node_remove"
                        or "node_bootstrap_info"
                        or "node_pair_list"
                        or "node_pair_approve"
                        or "list_mcp_servers"
                        or "delete_session"
                        or "set_config"
                        or "move_session"
                        or "create_timer"
                        or "list_timers"
                        or "update_timer"
                        or "delete_timer"
                        or "start_toolscript_run"
                        or "list_toolscript_runs"
                        or "get_toolscript_run"
                        or "cancel_toolscript_run"
                        or "get_archived_messages"
                        or "get_archived_blocks"
                        or "stop_session"
                    ),
                handlers[name]
            );
        }
        foreach (var definition in MainBrowserDefinitions.All().OfType<JsonObject>())
            registry.RegisterBrowser(definition);
        return registry;
    }
}

internal sealed record TurnToolPreparation(JsonObject Response, bool PolicyUnavailable = false);

internal sealed record TurnToolExecution(
    JsonNode? Response,
    JsonObject? Timing = null,
    JsonArray? ResolvedPaths = null,
    string? DeferredCwd = null,
    JsonArray? ToolScriptSubCalls = null,
    TurnToolReceipt? Receipt = null,
    JsonArray? SessionMessages = null,
    string? DeferredCwdNode = null
);

internal sealed record TurnToolReceipt(
    string? SuccessfulSendTarget,
    string? CompletedTaskId,
    string? AttachedSessionId
);

internal sealed record ToolScriptSourcePlacement(string Node, string? Cwd, WorkspaceTools Files);

internal sealed class TurnToolInvocation(string callId)
{
    internal JsonObject? CompactCall { get; set; }
    internal string CallId { get; } = callId;
    internal int? Index { get; set; }
    internal int? Total { get; set; }
    internal string Node { get; set; } = "master";
    internal string? Cwd { get; set; }
    internal WorkspaceTools? Files { get; set; }
    internal WorkspaceTools? ExecFiles { get; set; }
    internal ToolScriptSourcePlacement? ScriptSource { get; set; }
    internal JsonObject? Timing { get; set; }
    internal JsonArray? ResolvedPaths { get; set; }
    internal string? DeferredCwd { get; set; }
    internal string? DeferredCwdNode { get; set; }
    internal JsonArray? ToolScriptSubCalls { get; set; }
    internal TurnToolReceipt? Receipt { get; set; }
    internal JsonArray? SessionMessages { get; set; }
}
