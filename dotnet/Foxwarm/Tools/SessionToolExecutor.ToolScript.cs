using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    private sealed record ScriptScope(
        string LiteralOwner,
        ToolScriptDataBudget Budget,
        ToolScriptWaitScope WaitScope,
        string? RunId,
        ToolScriptDetach? Detach = null,
        // The model call that started the outermost script of this turn; null for unattended runs.
        string? RootCallId = null
    );

    private readonly AsyncLocal<ScriptScope?> scriptScope = new();

    private static JsonObject ConcreteDescriptor(ResolvedTool resolved)
    {
        var descriptor = new JsonObject { ["source"] = resolved.Source, ["name"] = resolved.Name };
        if (resolved.Source == "mcp")
            descriptor["server"] = resolved.Server;
        else if (resolved.Source == "node")
            descriptor["nodeId"] = resolved.ExecutionNode;
        return descriptor;
    }
    internal bool Programmatic => scriptScope.Value is not null;

    // The gate of a ToolScript model request, in its own approval scope like a nested call: an
    // outer approval never covers it, and a wait keeps the slice's deadline and wait accounting.
    // Version-1 asks on the slice's invocation ask once per slice: an approval of the slice, or
    // of an earlier model request of the slice, answers them. A deny always applies.
    private async Task AuthorizeModelRequestAsync(
        ResolvedTool slice,
        ToolApprovalScope? sliceScope,
        WorkspaceTools? files,
        string model,
        CancellationToken token
    )
    {
        var scope = new ToolApprovalScope(hosted) { Primary = slice };
        using var entered = ToolApprovalScope.Enter(scope);
        while (true)
        {
            var check = await sessions.AssessToolScriptModelAsync(hosted, slice, files, model, token);
            var assessment = check.Assessment;
            if (assessment.Denied is not null)
            {
                var lead = $"Model request `{model}` was not sent.";
                var denial = SessionManager.Denial(hosted, slice, assessment, lead);
                if (denial is ToolAuthorizationUnresolvedException)
                    throw new ToolAuthorizationUnresolvedException(lead + " " + denial.Message);
                // A rule's own reason leads; the model request is named before it.
                throw denial.Message.StartsWith(lead, StringComparison.Ordinal)
                    ? denial
                    : new ToolAuthorizationDeniedException($"Model request `{model}` was not sent: {denial.Message}");
            }
            if (
                assessment.Effect != ToolAuthorizationEffect.Ask
                || scope.Covers(hosted, check.Fingerprint)
                || check.SliceAsk && sliceScope?.Covers(hosted, check.SliceFingerprint) == true
            )
                return;
            var required = new ToolApprovalRequiredException(assessment, slice, check.Fingerprint);
            if (scope.Grants.Count > 0)
                throw required.ChangedAfterApproval();
            var pending = await sessions.BeginToolApprovalAsync(
                hosted,
                required,
                ApprovalOrigin(),
                unattended
            );
            var record = await AwaitApprovalAsync(pending, token);
            var grant = SessionManager.ApprovalOutcome(pending, record);
            scope.Add(grant);
            scope.Dispatched = true;
            if (check.SliceAsk)
                sliceScope?.Add(
                    new ToolApprovalGrant(
                        grant.ApprovalId,
                        new HashSet<string>(StringComparer.Ordinal) { check.SliceFingerprint },
                        grant.Note
                    )
                );
        }
    }
    internal ToolScriptDataBudget? ScriptBudget => scriptScope.Value?.Budget;

    // A detached run's calls no longer belong to the turn that started it.
    private bool ScriptDetached => scriptScope.Value?.Detach?.Detached == true;

    private async Task<JsonObject> ExecuteToolScriptAsync(
        string name,
        JsonObject args,
        CancellationToken token,
        // A runnable skill's entry, for run_skill: inline source plus provenance.
        SkillEntry? skill = null
    )
    {
        var rootCall = invocation.Value;
        // The slice's own invocation and approval scope: model requests are assessed as it.
        var slice = rootCall?.Resolved ?? new ResolvedTool(name, "builtin", name, args);
        var sliceScope =
            ToolApprovalScope.Current is { } owned && ReferenceEquals(owned.Owner, hosted)
                ? owned
                : null;
        var sliceFiles = rootCall?.ScriptSource?.Files ?? Files;
        var nested = Programmatic;
        var literal = scriptScope.Value?.LiteralOwner ?? hosted.Id;
        var waitScope = scriptScope.Value?.WaitScope ?? new ToolScriptWaitScope();
        var rootCallId = nested ? scriptScope.Value?.RootCallId : unattended ? null : rootCall?.CallId;
        // Only an attended top-level call can hand a background run off; timer, webhook and
        // nested runs keep the slice contract.
        var detach =
            !nested && !unattended && name is "run_script" or "continue_script" or "run_skill"
                ? new ToolScriptDetach
                {
                    // One event identity per detached segment; a run can detach again after
                    // an ask_agent continuation.
                    Finished = (outcome, deliveries) =>
                        sessions.DeliverToolScriptRunEventAsync(
                            hosted,
                            outcome,
                            Guid.NewGuid().ToString("N"),
                            deliveries
                        ),
                }
                : null;
        // A run nested in a detached run is detached from the turn as well.
        var effectiveDetach = detach ?? scriptScope.Value?.Detach;
        ToolScriptContext context = null!;
        context = new ToolScriptContext(
            hosted,
            literal,
            async (wrapper, budget, currentToken) =>
            {
                // seq.k.n below a model call (each slice has its own anchor); ts:runId.n for
                // slices without one (for example a timer or a detached run), numbered across
                // the whole run.
                var detached = effectiveDetach?.Detached == true;
                var parentDelivery = detached ? null : rootCall?.DeliverySeq(script: true);
                var subCallDelivery = SessionManager.SubCallDeliverySeq(
                    parentDelivery,
                    context.ToolScriptRunId,
                    parentDelivery is null ? context.RunSubCallOrdinal : context.SubCallOrdinal
                );
                var previous = scriptScope.Value;
                scriptScope.Value = new(
                    literal,
                    budget,
                    waitScope,
                    context.ToolScriptRunId,
                    effectiveDetach,
                    rootCallId
                );
                try
                {
                    var resolved = await registry.ResolveAsync(
                        "call_tool",
                        wrapper,
                        sessions.CurrentNode(hosted),
                        currentToken
                    );
                    var concrete = new JsonObject
                    {
                        ["name"] = resolved.Name,
                        ["args"] = resolved.Args.DeepClone(),
                    };
                    var planned = ToolCallControls.Plan([concrete])[0];
                    if (planned.Preset is not null)
                        return planned.Preset;
                    var request = (JsonObject)wrapper.DeepClone();
                    string? command = null;
                    // A ctl command naming a capability runs as that capability.
                    if (resolved.InvocationName == "ctl" && !IsCtlFrontEnd(resolved))
                    {
                        request = ConcreteDescriptor(resolved);
                        command = resolved.Command;
                    }
                    request["args"] = planned.Call["args"]!.DeepClone();
                    var effectStarted = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var execution = await ExecuteAttributedAsync(
                        new JsonObject
                        {
                            ["id"] = rootCall?.CallId ?? "",
                            ["name"] = "call_tool",
                            ["args"] = request,
                        },
                        currentToken,
                        scriptDelivery: subCallDelivery,
                        command: command
                    );
                    if (execution.SessionMessages is { Count: > 0 } deliveries)
                        foreach (var delivery in deliveries.OfType<JsonObject>())
                        {
                            context.SessionMessageDelivered?.Invoke(delivery);
                            // A nested run reports its deliveries as its own call's, so the
                            // calling run records them on the subcall that started it.
                            if (nested && rootCall is not null)
                                (rootCall.SessionMessages ??= new JsonArray()).Add(
                                    delivery.DeepClone()
                                );
                        }
                    if (execution.ExecPlacement is { } placement)
                        context.ExecPlacementObserved?.Invoke(placement);
                    if (execution.Target is { } target)
                        context.TargetObserved?.Invoke(target);
                    // Unattended and detached calls have no Session tool row; they are recorded directly.
                    if (unattended || detached)
                        sessions.Activity.RecordDirect(() =>
                            ArchiveToolEffects.FromDirectCall(
                                hosted.Id,
                                hosted.Agent,
                                unattended ? unattendedOrigin + "-script" : "model",
                                effectStarted,
                                execution.Target,
                                resolved.Name,
                                execution.ExecPlacement,
                                execution.Response,
                                SessionWait.Text(execution.Target?["summary"])
                                    ?? ActivitySummary(
                                        sessions,
                                        resolved.Name,
                                        resolved.Args,
                                        hosted.Id
                                    ),
                                unattended ? new(0, unattendedOrigin, unattendedOriginId) : null,
                                context.ToolScriptRunId,
                                execution.SessionMessages
                            )
                        );
                    if (
                        execution.Receipt is not null
                        && (
                            resolved.Name == "task"
                                && SessionWait.Text(resolved.Args["action"]) == "complete"
                            || execution.Receipt.CompletedTaskId is not null
                        )
                        && rootCall is not null
                        && effectiveDetach?.Detached != true
                    )
                        rootCall.Receipt = execution.Receipt;
                    if (PolicyUnavailable)
                        throw new ToolScriptHostFatalException(
                            new ToolAuthorizationUnavailableException()
                        );
                    hosted.Entry.RequireIdentityAuthority();
                    return await sessions.NormalizeToolScriptResultAsync(
                        execution.Response,
                        resolved.Name,
                        budget,
                        MainToolScript.ProducesImages(resolved) ? context.ImageProduced : null
                    );
                }
                catch (SessionIdentityUnavailableException error)
                {
                    throw new ToolScriptHostFatalException(error);
                }
                finally
                {
                    scriptScope.Value = previous;
                }
            },
            async (prompt, model, budget, currentToken) =>
            {
                // An unknown model is still authorized first, under the name the script gave, so
                // a denied slice reports its denial rather than the model error.
                string key;
                InvalidDataException? unknown = null;
                try
                {
                    key = sessions.ToolScriptModelKey(hosted, model);
                }
                catch (InvalidDataException error) when (model is { Length: > 0 })
                {
                    key = model;
                    unknown = error;
                }
                await AuthorizeModelRequestAsync(slice, sliceScope, sliceFiles, key, currentToken);
                if (unknown is not null)
                    throw unknown;
                return await sessions.RequestToolScriptModelAsync(
                    hosted,
                    prompt,
                    key,
                    budget,
                    currentToken
                );
            },
            async (file, budget, currentToken) =>
            {
                await sessions.WaitForIdentityMutationAsync(hosted.Id, currentToken);
                hosted.Entry.RequireIdentityAuthority();
                var source =
                    rootCall?.ScriptSource
                    ?? throw new InvalidOperationException(
                        "ToolScript source routing was not captured."
                    );
                var node = source.Node;
                var cwd = source.Cwd;
                var files = source.Files;
                if (node != "master")
                {
                    var raw = file;
                    await sessions.AuthorizeNodeFileAsync(
                        hosted,
                        node,
                        raw,
                        "read",
                        files,
                        currentToken
                    );
                    if (sessions.NodeProviders.IsProviderNode(node))
                    {
                        var sourceBytes = await sessions.NodeProviders.ReadSourceAsync(
                            node,
                            raw,
                            cwd,
                            currentToken,
                            size => budget.Charge(checked(8L * size))
                        );
                        return (
                            raw,
                            new System.Text.UTF8Encoding(false, true).GetString(sourceBytes)
                        );
                    }
                    var transferred = await sessions.ReadResidentSourceAsync(
                        hosted,
                        node,
                        file,
                        cwd,
                        files,
                        currentToken,
                        size => budget.Charge(checked(8L * size))
                    );
                    return (
                        transferred.Path,
                        new System.Text.UTF8Encoding(false, true).GetString(transferred.Bytes)
                    );
                }
                var actual = files.Paths.FilePath(file);
                await sessions.AuthorizeToolAsync(
                    hosted,
                    new ResolvedTool(
                        "read",
                        "node",
                        "read",
                        new JsonObject { ["filePath"] = file }
                    ),
                    files,
                    currentToken
                );
                if (!WorkspaceTools.RegularFile(actual))
                    throw new FileNotFoundException(
                        "ToolScript source must be a regular file.",
                        actual
                    );
                await using var stream = new FileStream(
                    actual,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite,
                    65536,
                    FileOptions.Asynchronous
                );
                var length = stream.Length;
                budget.Charge(checked(8 * length));
                if (length > int.MaxValue)
                    throw new ToolScriptDataLimitException(
                        "ToolScript source exceeds its materialization budget."
                    );
                var bytes = new byte[(int)length];
                await stream.ReadExactlyAsync(bytes, currentToken);
                return (actual, new System.Text.UTF8Encoding(false, true).GetString(bytes));
            },
            nested || unattended
                ? null
                : calls =>
                {
                    void Present()
                    {
                        if (rootCall is not null)
                            rootCall.ToolScriptSubCalls = (JsonArray)calls.DeepClone();
                        hosted.Emit(
                            SessionEventKind.ModelStream,
                            new JsonObject
                            {
                                ["type"] = "toolscript-progress",
                                ["toolUseId"] = rootCall?.CallId,
                                ["subCalls"] = calls.DeepClone(),
                            }
                        );
                    }
                    if (detach is null)
                    {
                        Present();
                        return;
                    }
                    // The tool row keeps the calls made before the run detached.
                    lock (detach.Gate)
                        if (!detach.Detached)
                            Present();
                },
            rootCall?.ScriptSource?.Node
        )
        {
            WaitScope = waitScope,
            Detach = detach,
            SourceSkill = skill,
        };
        try
        {
            // A skill entry starts as an inline run_script run.
            var result = await sessions.ToolScript.ExecuteAsync(
                name == "run_skill" ? "run_script" : name,
                args,
                context,
                token
            );
            if (SessionWait.Text(result["status"]) != "completed")
                waitScope.Pending = null;
            else if (!unattended && !nested && waitScope.Pending is { } pending)
            {
                waitScope.Pending = null;
                // Normal builtin resolution, authorization and live source validation own the effect.
                var armed = await ExecuteAttributedAsync(
                    new JsonObject
                    {
                        ["id"] = rootCall?.CallId ?? "",
                        ["name"] = "wait",
                        ["args"] = pending,
                    },
                    token
                );
                if (armed.Response is JsonObject response && response["error"] is not null)
                    return response;
            }
            return result;
        }
        catch
        {
            waitScope.Pending = null;
            throw;
        }
    }
}
