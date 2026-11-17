using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

// A Session's running background commands and stopping one, with Session Stop's authority.
internal sealed partial class WebUIChannel
{
    private void RegisterSessionExecRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/sessions/{id}/execs",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return Results.Ok(
                    new JsonObject
                    {
                        ["execs"] = new JsonArray(
                            sessions
                                .RunningExecs(hosted)
                                .Select(exec => (JsonNode)SessionManager.ExecRow(exec, now))
                                .ToArray()
                        ),
                    }
                );
            }
        );
        app.MapPost(
            "/api/sessions/{id}/execs/{execId}/stop",
            async (string id, string execId, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                var (result, _, _) = await sessions.StopExecAsync(
                    hosted,
                    execId,
                    request.HttpContext.RequestAborted
                );
                return result == SessionManager.ExecStopResult.NotOwned
                    ? Results.NotFound(new JsonObject { ["error"] = "Command not found" })
                    : Results.Ok(
                        new JsonObject
                        {
                            ["outcome"] = result switch
                            {
                                SessionManager.ExecStopResult.Stopped => "stopped",
                                SessionManager.ExecStopResult.Killed => "killed",
                                SessionManager.ExecStopResult.Ended => "ended",
                                SessionManager.ExecStopResult.Finished => "finished",
                                SessionManager.ExecStopResult.AlreadyRequested =>
                                    "already-requested",
                                SessionManager.ExecStopResult.Unsupported => "unsupported",
                                SessionManager.ExecStopResult.Unavailable => "unavailable",
                                _ => "unknown",
                            },
                        }
                    );
            }
        );
    }
}
