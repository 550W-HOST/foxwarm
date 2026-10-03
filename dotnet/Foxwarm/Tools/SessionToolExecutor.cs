using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed class SessionToolExecutor(ITurnToolExecutor workspace, SessionOwner hosted, SessionManager sessions, ToolRegistry registry)
    : ITurnToolExecutor, ITurnToolControl
{
    private int finishPending;
    private int policyUnavailable;
    public bool PolicyUnavailable => Volatile.Read(ref policyUnavailable) != 0;
    internal WorkspaceTools? Files => workspace as WorkspaceTools;
    internal Task AuthorizeAsync(ResolvedTool resolved, CancellationToken token) => sessions.AuthorizeToolAsync(hosted, resolved, workspace as WorkspaceTools, token);
    private readonly List<string> explicitWaitIds = [];
    private readonly List<string> handoffTargets = [];
    internal SessionOwner Hosted => hosted;
    internal bool HandoffConfirmationEnabled => sessions.HandoffConfirmationEnabled;
    private SessionManager Manager => sessions;
    private readonly AsyncLocal<TurnToolInvocation?> invocation = new();
    private readonly AsyncLocal<string?> execWorkspace = new();
    internal string CurrentCallId => invocation.Value?.CallId ?? "";
    internal string? DirectExecWorkspace => execWorkspace.Value;
    internal IDisposable CaptureDirectExecSegment()
    {
        var previous = execWorkspace.Value;
        execWorkspace.Value = Files?.ToolDirectory;
        return new ExecSegmentScope(() => execWorkspace.Value = previous);
    }
    private sealed class ExecSegmentScope(Action restore) : IDisposable { public void Dispose() => restore(); }
    internal async Task<TurnToolExecution> ExecuteAttributedAsync(JsonObject call, CancellationToken token)
    {
        var previous = invocation.Value; var current = new TurnToolInvocation(SessionWait.Text(call["id"]) ?? ""); invocation.Value = current;
        try { return new(await ExecuteCoreAsync(call, token), current.Timing); }
        finally { invocation.Value = previous; }
    }
    public void BeginTurn()
    {
        hosted.BeginLogicalTurn();
        Volatile.Write(ref policyUnavailable, 0);
        Interlocked.Exchange(ref finishPending, 0);
        explicitWaitIds.Clear(); handoffTargets.Clear();
    }
    public bool ConsumeFinishAfterBatch() => Interlocked.Exchange(ref finishPending, 0) == 1;
    public async Task<bool> CompleteBatchAsync(JsonObject toolMessage, bool stopping)
    {
        var errors = toolMessage["parts"]!.AsArray().Any(part => part?["functionResponse"]?["response"]?["error"] is not null);
        var explicitStop = explicitWaitIds.Count > 0;
        if (errors || stopping) foreach (var id in explicitWaitIds) await hosted.Entry.SaveLane.ClearWaitAsync(id);
        explicitWaitIds.Clear();
        var finish = ConsumeFinishAfterBatch(); var handoff = handoffTargets.Count > 0;
        if (PolicyUnavailable) { handoffTargets.Clear(); throw new ToolAuthorizationUnavailableException(); }
        if (!stopping && handoff && hosted.WaitSnapshot() is null) await sessions.StartHandoffWaitAsync(hosted, handoffTargets);
        handoffTargets.Clear();
        return finish || !stopping && (handoff || explicitStop && !errors);
    }
    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken) => (await ExecuteAttributedAsync(functionCall, cancellationToken)).Response;
    private async Task<JsonObject> ExecuteCoreAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var name = SessionWait.Text(functionCall["name"]) ?? "";
            var args = functionCall["args"] as JsonObject ?? throw new InvalidDataException("Tool arguments must be an object.");
            var resolved = registry.Resolve(name, args);
            await AuthorizeAsync(resolved, cancellationToken);
            hosted.BeginTool();
            var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); var monotonic = System.Diagnostics.Stopwatch.GetTimestamp();
            try { return await registry.ExecuteAsync(resolved, this, cancellationToken); }
            finally
            {
                if (invocation.Value is { } current) current.Timing = new JsonObject { ["startedAt"] = startedAt, ["completedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["durationMs"] = System.Diagnostics.Stopwatch.GetElapsedTime(monotonic).TotalMilliseconds };
                hosted.EndTool();
            }
        }
        catch (ToolAuthorizationUnavailableException error)
        { Interlocked.Exchange(ref policyUnavailable, 1); return UnsupportedTurnToolExecutor.ToolError(ToolAuthorizationUnavailableException.Code, error.Message); }
        catch (ToolAuthorizationDeniedException error)
        { return UnsupportedTurnToolExecutor.ToolError("tool_authorization_denied", error.Message); }
        catch (ArgumentException error)
        { return UnsupportedTurnToolExecutor.ToolError("invalid_path", error.Message); }
        catch (UnauthorizedAccessException error)
        { return UnsupportedTurnToolExecutor.ToolError("tool_io_error", error.Message); }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        { return UnsupportedTurnToolExecutor.ToolError("tool_call_cancelled", "Tool request canceled. Started effects may have occurred and were not reversed."); }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException or System.Text.Json.JsonException or NotSupportedException or TimeoutException or System.ComponentModel.Win32Exception)
        { return UnsupportedTurnToolExecutor.ToolError("tool_error", error.Message); }
    }
    private Task<JsonObject> ExecuteWorkspaceAsync(string name, JsonObject args, CancellationToken token) => workspace.ExecuteAsync(new JsonObject { ["name"] = name, ["args"] = args.DeepClone() }, token);
    private async Task<JsonObject> ExecuteAgentAsync(string name, JsonObject args, CancellationToken cancellationToken)
    {
        var (response, finish) = await sessions.ExecuteAgentToolAsync(hosted, name, args, cancellationToken);
        if (response.Remove("__waitTarget", out var target) && SessionWait.Text(target) is string id) handoffTargets.Add(id);
        if (finish) Interlocked.Exchange(ref finishPending, 1);
        return response;
    }
    private async Task<JsonObject> ExecuteWaitAsync(JsonObject args)
    {
        try
        {
            var id = await sessions.DeclareWaitAsync(hosted, args); if (id is not null) explicitWaitIds.Add(id);
            return new JsonObject { ["output"] = "Waiting for new Session activity." };
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException)
        {
            if (error is CommittedWaitDeclarationException committed) explicitWaitIds.Add(committed.WaitId);
            return UnsupportedTurnToolExecutor.ToolError("wait_error", error.Message);
        }
    }
    internal static ToolRegistry CreateRegistry(JsonArray definitions, Foxwarm.McpClient mcp, Func<SessionOwner, string> path)
    {
        var registry = new ToolRegistry(mcp, path);
        var handlers = new Dictionary<string, Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonObject>>>(StringComparer.Ordinal);
        foreach (var name in new[] { "read", "write", "edit", "apply_patch" })
            handlers[name] = (owner, args, token) => owner.ExecuteWorkspaceAsync(name, args, token);
        handlers["exec"] = (owner, args, token) => owner.Hosted.Executor.ExecuteAsync(owner.Hosted.Id, args, token, owner.DirectExecWorkspace);
        handlers["read_exec"] = (owner, args, _) => owner.Hosted.Executor.ReadAsync(owner.Hosted.Id, args);
        handlers["recall"] = (owner, args, token) => ArchiveRecallTool.ExecuteAsync(owner.Manager, owner.Hosted, args, token);
        handlers["wait"] = (owner, args, _) => owner.ExecuteWaitAsync(args);
        handlers["submit_compact_plan"] = (_, _, _) => Task.FromResult(UnsupportedTurnToolExecutor.ToolError("unknown_tool", "submit_compact_plan is available only to the dedicated compactor."));
        foreach (var name in new[] { "delete_session", "create_agent", "create_session", "create_child_session", "send_to_session", "refresh_session_snapshot", "skill", "set_agent_inherit", "session", "get_session_messages", "set_goal", "set_session_child_model", "set_session_compact_threshold", "compact_session" })
            handlers[name] = (owner, args, token) => owner.ExecuteAgentAsync(name, args, token);
        handlers["set_tool_rules"] = (owner, args, token) => owner.Manager.InstallToolRulesAsync(owner.Hosted, owner.Files ?? throw new NotSupportedException("This executor has no file reader."), args, token);
        handlers["search_tools"] = (owner, args, token) => UnifiedTools.SearchAsync(registry, args, token, (source, name, server) => owner.Manager.ToolVisible(owner.Hosted, source, name, server));
        handlers["call_tool"] = (_, _, _) => throw new InvalidDataException("call_tool is a dispatcher, not a concrete target.");
        handlers["mcp_config"] = (_, args, token) => mcp.ConfigureAsync(args, token);
        handlers["list_mcp_servers"] = (_, args, token) => { ToolRegistry.Keys(args, []); return mcp.ListServersAsync(token); };
        foreach (var definition in definitions.OfType<JsonObject>())
        {
            var name = SessionWait.Text(definition["name"])!;
            var source = name is "read" or "write" or "edit" or "apply_patch" or "exec" ? "node" : "builtin";
            registry.Register(definition, source, name is not ("mcp_config" or "list_mcp_servers" or "delete_session" or "set_tool_rules"), handlers[name]);
        }
        return registry;
    }
}

internal sealed record TurnToolExecution(JsonObject Response, JsonObject? Timing = null);
internal sealed class TurnToolInvocation(string callId) { internal string CallId { get; } = callId; internal JsonObject? Timing { get; set; } }
