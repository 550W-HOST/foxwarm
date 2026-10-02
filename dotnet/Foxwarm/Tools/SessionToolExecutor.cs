using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed class SessionToolExecutor(ITurnToolExecutor workspace, SessionOwner hosted, SessionManager sessions, ToolRegistry registry)
    : ITurnToolExecutor, ITurnToolControl
{
    private int finishPending;
    private readonly List<string> explicitWaitIds = [];
    private readonly List<string> handoffTargets = [];
    internal SessionOwner Hosted => hosted;
    private SessionManager Manager => sessions;
    internal string CurrentCallId { get; private set; } = "";
    public void BeginTurn()
    {
        hosted.BeginLogicalTurn();
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
        if (!stopping && handoff && hosted.WaitSnapshot() is null) await sessions.StartHandoffWaitAsync(hosted, handoffTargets);
        handoffTargets.Clear();
        return finish || !stopping && (handoff || explicitStop && !errors);
    }
    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var name = SessionWait.Text(functionCall["name"]) ?? "";
            var args = functionCall["args"] as JsonObject ?? throw new InvalidDataException("Tool arguments must be an object.");
            var resolved = registry.Resolve(name, args);
            CurrentCallId = SessionWait.Text(functionCall["id"]) ?? "";
            hosted.SetToolActive(true);
            try { return await registry.ExecuteAsync(resolved, this, cancellationToken); }
            finally { hosted.SetToolActive(false); }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        { return UnsupportedTurnToolExecutor.ToolError("tool_call_cancelled", "Tool request canceled. Started effects may have occurred and were not reversed."); }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException or System.Text.Json.JsonException or NotSupportedException or TimeoutException)
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
        handlers["exec"] = (owner, args, token) => owner.Hosted.Executor.ExecuteAsync(owner.Hosted.Id, args, token);
        handlers["read_exec"] = (owner, args, _) => owner.Hosted.Executor.ReadAsync(owner.Hosted.Id, args);
        handlers["recall"] = (owner, args, token) => ArchiveRecallTool.ExecuteAsync(owner.Manager, owner.Hosted, args, token);
        handlers["wait"] = (owner, args, _) => owner.ExecuteWaitAsync(args);
        handlers["submit_compact_plan"] = (_, _, _) => Task.FromResult(UnsupportedTurnToolExecutor.ToolError("unknown_tool", "submit_compact_plan is available only to the dedicated compactor."));
        foreach (var name in new[] { "delete_session", "create_agent", "create_session", "create_child_session", "send_to_session", "refresh_session_snapshot", "skill", "set_agent_inherit", "session", "get_session_messages", "set_goal", "set_session_child_model", "set_session_compact_threshold", "compact_session" })
            handlers[name] = (owner, args, token) => owner.ExecuteAgentAsync(name, args, token);
        handlers["search_tools"] = (owner, args, token) => UnifiedTools.SearchAsync(registry, args, token);
        handlers["call_tool"] = (_, _, _) => throw new InvalidDataException("call_tool is a dispatcher, not a concrete target.");
        handlers["mcp_config"] = (_, args, token) => mcp.ConfigureAsync(args, token);
        handlers["list_mcp_servers"] = (_, args, token) => { ToolRegistry.Keys(args, []); return mcp.ListServersAsync(token); };
        foreach (var definition in definitions.OfType<JsonObject>())
        {
            var name = SessionWait.Text(definition["name"])!;
            var source = name is "read" or "write" or "edit" or "apply_patch" or "exec" ? "node" : "builtin";
            registry.Register(definition, source, name is not ("mcp_config" or "list_mcp_servers" or "delete_session"), handlers[name]);
        }
        return registry;
    }
}
