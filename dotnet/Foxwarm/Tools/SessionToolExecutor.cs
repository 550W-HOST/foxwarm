using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor(
    ITurnToolExecutor workspace,
    SessionOwner hosted,
    SessionManager sessions,
    ToolRegistry registry
) : ITurnToolExecutor, ITurnToolControl
{
    private int finishPending;
    private int policyUnavailable;
    public bool PolicyUnavailable => Volatile.Read(ref policyUnavailable) != 0;
    internal WorkspaceTools? Files =>
        invocation.Value?.Files
        ?? (workspace is WorkspaceTools ? sessions.IdentityWorkspace(hosted) : null);

    internal Task AuthorizeAsync(ResolvedTool resolved, CancellationToken token) =>
        sessions.AuthorizeToolAsync(
            hosted,
            resolved,
            resolved.Name == "exec" ? ExecFiles : Files,
            token
        );

    private readonly List<string> explicitWaitIds = [];
    private readonly List<string> handoffTargets = [];
    internal SessionOwner Hosted => hosted;
    internal bool HandoffConfirmationEnabled => sessions.HandoffConfirmationEnabled;
    private SessionManager Manager => sessions;
    private readonly AsyncLocal<TurnToolInvocation?> invocation = new();

    private sealed record ExecSnapshot(string? Cwd);

    private readonly AsyncLocal<ExecSnapshot?> execSnapshot = new();
    internal string CurrentCallId => invocation.Value?.CallId ?? "";
    internal string? DirectExecWorkspace => execSnapshot.Value?.Cwd;
    private WorkspaceTools ExecFiles =>
        invocation.Value?.ExecFiles ?? sessions.IdentityWorkspace(hosted, execSnapshot.Value?.Cwd);

    internal IDisposable CaptureDirectExecSegment()
    {
        var previous = execSnapshot.Value;
        var raw = SessionWait.Text(hosted.Entry.Snapshot().AuthorityEnvelope["cwd"]);
        execSnapshot.Value = new(raw);
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
            var resolved = registry.Resolve("exec", args);
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
        CancellationToken token
    )
    {
        await sessions.WaitForIdentityMutationAsync(hosted.Id, token);
        hosted.Entry.RequireIdentityAuthority();
        var previous = invocation.Value;
        var current = new TurnToolInvocation(SessionWait.Text(call["id"]) ?? "")
        {
            Files = workspace is WorkspaceTools ? sessions.IdentityWorkspace(hosted) : null,
        };
        invocation.Value = current;
        try
        {
            var response = await ExecuteCoreAsync(call, token);
            return new(
                response,
                current.Timing,
                response["error"] is null ? current.ResolvedPaths : null,
                current.DeferredCwd,
                current.ToolScriptSubCalls
            );
        }
        finally
        {
            invocation.Value = previous;
        }
    }

    public void BeginTurn()
    {
        hosted.BeginLogicalTurn();
        Volatile.Write(ref policyUnavailable, 0);
        Interlocked.Exchange(ref finishPending, 0);
        explicitWaitIds.Clear();
        handoffTargets.Clear();
    }

    public bool ConsumeFinishAfterBatch() => Interlocked.Exchange(ref finishPending, 0) == 1;

    public async Task<bool> CompleteBatchAsync(JsonObject toolMessage, bool stopping)
    {
        var errors = toolMessage["parts"]!
            .AsArray()
            .Any(part => part?["functionResponse"]?["response"]?["error"] is not null);
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
        if (!stopping && handoff && hosted.WaitSnapshot() is null)
            await sessions.StartHandoffWaitAsync(hosted, handoffTargets);
        handoffTargets.Clear();
        return finish || !stopping && (handoff || explicitStop && !errors);
    }

    public async Task<JsonObject> ExecuteAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    ) => (await ExecuteAttributedAsync(functionCall, cancellationToken)).Response;

    private async Task<JsonObject> ExecuteCoreAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var name = SessionWait.Text(functionCall["name"]) ?? "";
            var args =
                functionCall["args"] as JsonObject
                ?? throw new InvalidDataException("Tool arguments must be an object.");
            var resolved = registry.Resolve(name, args);
            while (true)
            {
                await sessions.WaitForIdentityMutationAsync(hosted.Id, cancellationToken);
                hosted.Entry.RequireIdentityAuthority();
                var identity = hosted.Id;
                if (invocation.Value is { } current && workspace is WorkspaceTools)
                {
                    current.Files = sessions.IdentityWorkspace(hosted);
                    current.ExecFiles = sessions.IdentityWorkspace(hosted, execSnapshot.Value?.Cwd);
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
            hosted.BeginTool();
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
                hosted.EndTool();
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
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return UnsupportedTurnToolExecutor.ToolError(
                "tool_call_cancelled",
                "Tool request canceled. Started effects may have occurred and were not reversed."
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

    private async Task<JsonObject> ExecuteExecAsync(JsonObject args, CancellationToken token)
    {
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
            programmatic: ScriptBudget
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

    internal async Task<TurnToolExecution> ReplayCwdAsync(TurnToolExecution execution)
    {
        if (execution.DeferredCwd is not string cwd)
            return execution;
        try
        {
            return execution with
            {
                Response = await ApplyCwdAsync(execution.Response, cwd),
                DeferredCwd = null,
            };
        }
        catch (Exception error)
            when (error is IOException or InvalidOperationException or ArgumentException)
        {
            return execution with
            {
                Response = UnsupportedTurnToolExecutor.ToolError("tool_error", error.Message),
                DeferredCwd = null,
                ResolvedPaths = null,
            };
        }
    }

    private async Task<JsonObject> ApplyCwdAsync(JsonObject response, string cwd)
    {
        var change = await hosted.UpdateCwdAsync(cwd);
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

    private Task<JsonObject> ExecuteWorkspaceAsync(
        string name,
        JsonObject args,
        CancellationToken token
    ) =>
        (Files as ITurnToolExecutor ?? workspace).ExecuteAsync(
            new JsonObject { ["name"] = name, ["args"] = args.DeepClone() },
            token
        );

    private async Task<JsonObject> ExecuteAgentAsync(
        string name,
        JsonObject args,
        CancellationToken cancellationToken
    )
    {
        var (response, finish) = await sessions.ExecuteAgentToolAsync(
            hosted,
            name,
            args,
            cancellationToken
        );
        if (
            response.Remove("__waitTarget", out var target) && SessionWait.Text(target) is string id
        )
            handoffTargets.Add(id);
        if (finish)
            Interlocked.Exchange(ref finishPending, 1);
        return response;
    }

    private async Task<JsonObject> ExecuteWaitAsync(JsonObject args)
    {
        try
        {
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
        Func<SessionOwner, string> path
    )
    {
        var registry = new ToolRegistry(mcp, path);
        var handlers = new Dictionary<
            string,
            Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonObject>>
        >(StringComparer.Ordinal);
        foreach (var name in new[] { "read", "write", "edit", "apply_patch" })
            handlers[name] = (owner, args, token) => owner.ExecuteWorkspaceAsync(name, args, token);
        handlers["exec"] = (owner, args, token) => owner.ExecuteExecAsync(args, token);
        handlers["read_exec"] = (owner, args, _) =>
            owner.Hosted.Executor.ReadAsync(owner.Hosted.Id, args);
        handlers["recall"] = (owner, args, token) =>
            ArchiveRecallTool.ExecuteAsync(owner.Manager, owner.Hosted, args, token);
        handlers["get_archived_messages"] = (owner, args, token) =>
            ArchiveControlTools.ReadMessagesAsync(owner.Manager, owner.Hosted, args, token);
        handlers["get_archived_blocks"] = (owner, args, token) =>
            ArchiveControlTools.ReadBlocksAsync(owner.Manager, owner.Hosted, args, token);
        handlers["stop_session"] = (owner, args, token) =>
            ArchiveControlTools.StopAsync(owner.Manager, owner.Hosted, args, token);
        handlers["wait"] = (owner, args, _) => owner.ExecuteWaitAsync(args);
        handlers["submit_compact_plan"] = (_, _, _) =>
            Task.FromResult(
                UnsupportedTurnToolExecutor.ToolError(
                    "unknown_tool",
                    "submit_compact_plan is available only to the dedicated compactor."
                )
            );
        handlers["task"] = async (owner, args, _) =>
            await owner.Manager.Tasks.ExecuteForToolAsync(owner.Hosted, args);
        foreach (
            var name in new[]
            {
                "move_session",
                "delete_session",
                "create_agent",
                "create_session",
                "create_child_session",
                "send_to_session",
                "refresh_session_snapshot",
                "skill",
                "set_agent_inherit",
                "session",
                "get_session_messages",
                "set_goal",
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
        handlers["send_file"] = (owner, args, token) =>
            owner.Manager.SendFileAsync(
                owner.Hosted,
                owner.Files
                    ?? throw new NotSupportedException("This executor has no file resolver."),
                args,
                token
            );
        handlers["image_write_to_file"] = (owner, args, token) =>
            owner.Manager.ExportImageAsync(
                owner.Hosted,
                owner.Files
                    ?? throw new NotSupportedException("This executor has no file resolver."),
                args,
                token
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
        handlers["set_tool_rules"] = (owner, args, token) =>
            owner.Manager.InstallToolRulesAsync(
                owner.Hosted,
                owner.Files ?? throw new NotSupportedException("This executor has no file reader."),
                args,
                token
            );
        handlers["search_tools"] = (owner, args, token) =>
            UnifiedTools.SearchAsync(
                registry,
                args,
                token,
                (source, name, server) =>
                    owner.Manager.ToolVisible(owner.Hosted, source, name, server),
                owner.ScriptBudget
            );
        handlers["call_tool"] = (_, _, _) =>
            throw new InvalidDataException("call_tool is a dispatcher, not a concrete target.");
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
                        "mcp_config"
                        or "list_mcp_servers"
                        or "delete_session"
                        or "set_tool_rules"
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
        return registry;
    }
}

internal sealed record TurnToolPreparation(JsonObject Response, bool PolicyUnavailable = false);

internal sealed record TurnToolExecution(
    JsonObject Response,
    JsonObject? Timing = null,
    JsonArray? ResolvedPaths = null,
    string? DeferredCwd = null,
    JsonArray? ToolScriptSubCalls = null
);

internal sealed class TurnToolInvocation(string callId)
{
    internal string CallId { get; } = callId;
    internal WorkspaceTools? Files { get; set; }
    internal WorkspaceTools? ExecFiles { get; set; }
    internal JsonObject? Timing { get; set; }
    internal JsonArray? ResolvedPaths { get; set; }
    internal string? DeferredCwd { get; set; }
    internal JsonArray? ToolScriptSubCalls { get; set; }
}
