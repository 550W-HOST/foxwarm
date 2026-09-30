using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed class SessionToolExecutor(ITurnToolExecutor inner, SessionOwner hosted, SessionManager sessions)
    : ITurnToolExecutor, ITurnToolControl
{
    private int finishPending;
    private readonly List<string> explicitWaitIds = [];
    private readonly List<string> handoffTargets = [];
    public void BeginTurn()
    {
        Interlocked.Exchange(ref finishPending, 0);
        explicitWaitIds.Clear(); handoffTargets.Clear();
    }
    public bool ConsumeFinishAfterBatch() => Interlocked.Exchange(ref finishPending, 0) == 1;
    public async Task<bool> CompleteBatchAsync(JsonObject toolMessage, bool stopping)
    {
        var errors = toolMessage["parts"]!.AsArray().Any(part => part?["functionResponse"]?["response"]?["error"] is not null);
        var explicitStop = explicitWaitIds.Count > 0;
        if (errors || stopping)
            foreach (var id in explicitWaitIds) await hosted.Entry.SaveLane.ClearWaitAsync(id);
        explicitWaitIds.Clear();
        var finish = ConsumeFinishAfterBatch();
        var handoff = handoffTargets.Count > 0;
        if (!stopping && handoff && hosted.WaitSnapshot() is null) await sessions.StartHandoffWaitAsync(hosted, handoffTargets);
        handoffTargets.Clear();
        return finish || !stopping && (handoff || explicitStop && !errors);
    }

    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        hosted.SetToolActive(true);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = functionCall["name"]?.GetValue<string>();
            if (name == "wait")
            {
                try
                {
                    var args = functionCall["args"] as JsonObject ?? throw new InvalidDataException("wait arguments must be an object.");
                    var id = await sessions.DeclareWaitAsync(hosted, args);
                    if (id is not null) explicitWaitIds.Add(id);
                    return new JsonObject { ["output"] = "Waiting for new Session activity." };
                }
                catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException)
                {
                    if (error is CommittedWaitDeclarationException committed) explicitWaitIds.Add(committed.WaitId);
                    return UnsupportedTurnToolExecutor.ToolError("wait_error", error.Message);
                }
            }
            if (name == "exec") return await hosted.Executor.ExecuteAsync(hosted.Id, functionCall["args"] as JsonObject, cancellationToken);
            if (name == "read_exec") return await hosted.Executor.ReadAsync(hosted.Id, functionCall["args"] as JsonObject);
            if (name == "recall") return ArchiveRecallTool.Execute(sessions, hosted, functionCall["args"] as JsonObject);
            if (name is "create_agent" or "create_session" or "create_child_session" or "send_to_session" or "refresh_session_snapshot" or "skill" or "set_agent_inherit" or "session" or "get_session_messages" or "set_goal")
            {
                var (response, shouldFinish) = await sessions.ExecuteAgentToolAsync(hosted, name, functionCall["args"] as JsonObject);
                if (response.Remove("__waitTarget", out var target) && SessionWait.Text(target) is string id) handoffTargets.Add(id);
                if (shouldFinish) Interlocked.Exchange(ref finishPending, 1);
                return response;
            }
            return await inner.ExecuteAsync(functionCall, cancellationToken);
        }
        finally { hosted.SetToolActive(false); }
    }
}
