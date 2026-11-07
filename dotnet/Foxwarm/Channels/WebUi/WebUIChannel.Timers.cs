using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;
using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

/// <summary>
/// Administrator System › Timers routes. Every change runs the owner's ordinary timer
/// operation (update_timer/delete_timer), so validation and authority match the tools.
/// Scoped browser identities are not on the browser route allowlist and cannot reach them.
/// </summary>
internal sealed partial class WebUIChannel
{
    private sealed class TimerRouteError(int status, string code, string message)
        : Exception(message)
    {
        internal int Status { get; } = status;
        internal string Code { get; } = code;
    }

    private static IResult TimerError(int status, string code, string message) =>
        Results.Json(new JsonObject { ["code"] = code, ["error"] = message }, statusCode: status);

    private static IResult TimerFailure(Exception error) =>
        error switch
        {
            TimerRouteError route => TimerError(route.Status, route.Code, route.Message),
            JsonException => TimerError(
                400,
                "TIMER_INVALID_ARGS",
                "Timer changes require a JSON object body."
            ),
            TimerStoreUnavailableException => TimerError(
                503,
                "TIMER_STORE_UNAVAILABLE",
                error.Message
            ),
            ToolAuthorizationDeniedException => TimerError(403, "TIMER_DENIED", error.Message),
            InvalidDataException or ArgumentException => TimerError(
                error.Message.Contains("not found", StringComparison.OrdinalIgnoreCase) ? 404 : 400,
                "TIMER_INVALID_ARGS",
                error.Message
            ),
            _ => TimerError(500, "TIMER_FAILED", "Timer operation could not be completed."),
        };

    private static string RequiredOwner(JsonNode? value) =>
        value is JsonValue scalar
        && scalar.TryGetValue<string>(out var owner)
        && !string.IsNullOrWhiteSpace(owner)
        && owner.Length <= 256
            ? owner
            : throw new TimerRouteError(
                400,
                "TIMER_INVALID_ARGS",
                "sessionId must name the timer's owner Session."
            );

    private static async Task<JsonObject> TimerBody(HttpContext context)
    {
        if (context.Request.Query.Count > 0)
            throw new TimerRouteError(
                400,
                "TIMER_INVALID_ARGS",
                "Timer changes do not accept query parameters."
            );
        return await JsonNode.ParseAsync(context.Request.Body) as JsonObject
            ?? throw new TimerRouteError(
                400,
                "TIMER_INVALID_ARGS",
                "Timer changes require a JSON object body."
            );
    }

    private static IResult TimerResult(JsonObject result, string property)
    {
        if (result["error"] is not null)
            return Results.Json(
                new JsonObject
                {
                    ["code"] = "TIMER_PARTIAL",
                    ["error"] =
                        SessionWait.Text(result["error"]?["message"]) ?? "Timer change failed.",
                    ["timerCommitted"] = SessionCatalog.Flag(result["timerCommitted"]),
                },
                statusCode: 500
            );
        return Results.Json(new JsonObject { [property] = result[property]?.DeepClone() });
    }

    private void RegisterTimerRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/timers",
            (HttpRequest request) =>
            {
                try
                {
                    string? owner = null;
                    foreach (var key in request.Query.Keys)
                        if (key != "sessionId")
                            throw new TimerRouteError(
                                400,
                                "TIMER_INVALID_ARGS",
                                "Invalid timer query."
                            );
                    if (request.Query.TryGetValue("sessionId", out var requested))
                        owner = RequiredOwner(JsonValue.Create(requested.ToString()));
                    var timers = sessions.Timers.ListAll(candidate =>
                        owner is null || candidate == owner
                    );
                    return Results.Json(
                        new JsonObject
                        {
                            ["timers"] = timers,
                            ["recentRunLimit"] = MainTimers.RecentRunLimit,
                        }
                    );
                }
                catch (Exception error)
                {
                    return TimerFailure(error);
                }
            }
        );

        app.MapMethods(
            "/api/timers/{id}",
            ["PATCH"],
            async (HttpContext context, string id) =>
            {
                try
                {
                    var body = await TimerBody(context);
                    var owner = RequiredOwner(body["sessionId"]);
                    body.Remove("sessionId");
                    if (body.ContainsKey("timerId"))
                        throw new TimerRouteError(
                            400,
                            "TIMER_INVALID_ARGS",
                            "The route selects the timer."
                        );
                    body["timerId"] = id;
                    var result = await sessions.ExecuteTimerForOwnerAsync(
                        owner,
                        "update_timer",
                        body
                    );
                    if (result["error"] is null)
                        result["timer"] = sessions.Timers.Detail(
                            SessionWait.Text(result["timer"]?["id"]) ?? id,
                            owner
                        );
                    return TimerResult(result, "timer");
                }
                catch (Exception error)
                {
                    return TimerFailure(error);
                }
            }
        );

        app.MapDelete(
            "/api/timers/{id}",
            async (HttpContext context, string id) =>
            {
                try
                {
                    var body = await TimerBody(context);
                    var owner = RequiredOwner(body["sessionId"]);
                    if (body.Count != 1)
                        throw new TimerRouteError(
                            400,
                            "TIMER_INVALID_ARGS",
                            "Timer deletion accepts only sessionId."
                        );
                    var result = await sessions.ExecuteTimerForOwnerAsync(
                        owner,
                        "delete_timer",
                        new JsonObject { ["timerId"] = id }
                    );
                    if (result["error"] is null && !SessionCatalog.Flag(result["deleted"]))
                        throw new TimerRouteError(404, "TIMER_NOT_FOUND", "Timer not found.");
                    return TimerResult(result, "deleted");
                }
                catch (Exception error)
                {
                    return TimerFailure(error);
                }
            }
        );

        app.MapGet(
            "/api/timers/{id}/runs/{runId}",
            async (HttpContext context, string id, string runId) =>
            {
                try
                {
                    foreach (var key in context.Request.Query.Keys)
                        if (key != "sessionId")
                            throw new TimerRouteError(
                                400,
                                "TIMER_INVALID_ARGS",
                                "Invalid timer query."
                            );
                    var owner = RequiredOwner(
                        JsonValue.Create(context.Request.Query["sessionId"].ToString())
                    );
                    var run = await sessions.ReadTimerRunAsync(
                        id,
                        owner,
                        runId,
                        context.RequestAborted
                    );
                    return Results.Json(new JsonObject { ["run"] = run });
                }
                catch (Exception error)
                {
                    return TimerFailure(error);
                }
            }
        );
    }
}
