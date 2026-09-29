using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Models;
namespace Foxwarm.Tools;

internal sealed class SessionToolExecutor(ITurnToolExecutor inner, SessionOwner hosted, SessionManager sessions)
    : ITurnToolExecutor, ITurnToolControl
{
    private int finishPending;
    public void BeginTurn() => Interlocked.Exchange(ref finishPending, 0);
    public bool ConsumeFinishAfterBatch() => Interlocked.Exchange(ref finishPending, 0) == 1;

    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        hosted.SetToolActive(true);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = functionCall["name"]?.GetValue<string>();
            if (name == "exec")
                return await hosted.Executor.ExecuteAsync(hosted.Id, functionCall["args"] as JsonObject, cancellationToken);
            if (name == "read_exec")
                return await hosted.Executor.ReadAsync(hosted.Id, functionCall["args"] as JsonObject);
            if (name == "recall")
                return ArchiveRecallTool.Execute(hosted.Archive, functionCall["args"] as JsonObject);
            if (name is "create_agent" or "create_session" or "create_child_session" or "send_to_session" or "refresh_session_snapshot")
            {
                var (response, shouldFinish) = await sessions.ExecuteAgentToolAsync(hosted, name, functionCall["args"] as JsonObject);
                if (shouldFinish) Interlocked.Exchange(ref finishPending, 1);
                return response;
            }
            return await inner.ExecuteAsync(functionCall, cancellationToken);
        }
        finally { hosted.SetToolActive(false); }
    }
}
