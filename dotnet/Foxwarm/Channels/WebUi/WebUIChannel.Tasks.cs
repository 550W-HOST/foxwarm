using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterTaskRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/tasks",
            (HttpRequest request) =>
            {
                try
                {
                    var args = new JsonObject { ["action"] = "list" };
                    if (request.Query.TryGetValue("status", out var status))
                        args["status"] = status.ToString();
                    var limit = 50;
                    if (
                        request.Query.TryGetValue("limit", out var rawLimit)
                        && !int.TryParse(rawLimit.ToString(), out limit)
                    )
                        throw new TaskError(
                            "TASK_INVALID_ARGS",
                            "limit must be an integer from 1 to 50."
                        );
                    return Results.Ok(
                        sessions
                            .Tasks.ExecuteForWebUiAsync(args, null, limit)
                            .GetAwaiter()
                            .GetResult()
                    );
                }
                catch (TaskError error)
                {
                    return Results.Json(
                        new { code = error.Code, error = error.Message },
                        statusCode: error.StatusCode
                    );
                }
                catch (Exception)
                {
                    return Results.Json(
                        new { code = "TASK_READ_FAILED", error = "Tasks could not be loaded." },
                        statusCode: 500
                    );
                }
            }
        );
        app.MapGet(
            "/api/tasks/{id}",
            (string id) =>
            {
                try
                {
                    var result = sessions
                        .Tasks.ExecuteForWebUiAsync(
                            new JsonObject { ["action"] = "get", ["taskId"] = id },
                            null
                        )
                        .GetAwaiter()
                        .GetResult();
                    return Results.Ok(result);
                }
                catch (TaskError error)
                {
                    return Results.Json(
                        new { code = error.Code, error = error.Message },
                        statusCode: error.StatusCode
                    );
                }
                catch (Exception)
                {
                    return Results.Json(
                        new { code = "TASK_READ_FAILED", error = "Tasks could not be loaded." },
                        statusCode: 500
                    );
                }
            }
        );
        MapTaskWrite(app, "/api/tasks", "create", false, 201);
        MapTaskWrite(app, "/api/tasks/{id}/claim", "claim", true, 200);
        MapTaskWrite(app, "/api/tasks/{id}/assign", "assign", true, 200);
        MapTaskWrite(app, "/api/tasks/{id}", "update", true, 200, "PATCH");
        MapTaskWrite(app, "/api/tasks/{id}/complete", "complete", true, 200);
        MapTaskWrite(app, "/api/tasks/{id}/cancel", "cancel", true, 200);
    }

    private void MapTaskWrite(
        WebApplication app,
        string route,
        string action,
        bool hasId,
        int success,
        string method = "POST"
    )
    {
        RequestDelegate handler = async context =>
        {
            try
            {
                var body =
                    await JsonNode.ParseAsync(context.Request.Body) as JsonObject
                    ?? throw new TaskError(
                        "TASK_INVALID_ARGS",
                        "Task operations require a JSON object body."
                    );
                var target = body["sessionId"]?.GetValue<string>();
                if (target is not null && (target.Length == 0 || target.Length > 256))
                    throw new TaskError(
                        "TASK_INVALID_ARGS",
                        "sessionId must identify an existing Session."
                    );
                body.Remove("sessionId");
                if (body.ContainsKey("action") || body.ContainsKey("taskId"))
                    throw new TaskError(
                        "TASK_INVALID_ARGS",
                        "The route selects the task and action."
                    );
                body["action"] = action;
                if (hasId)
                    body["taskId"] = context.Request.RouteValues["id"]?.ToString();
                var result = await sessions.Tasks.ExecuteForWebUiAsync(body, target);
                context.Response.StatusCode = success;
                await Results.Json(result).ExecuteAsync(context);
            }
            catch (TaskError error)
            {
                await Results
                    .Json(
                        new { code = error.Code, error = error.Message },
                        statusCode: error.StatusCode
                    )
                    .ExecuteAsync(context);
            }
            catch (JsonException error)
            {
                await Results
                    .Json(
                        new { code = "TASK_INVALID_ARGS", error = error.Message },
                        statusCode: 400
                    )
                    .ExecuteAsync(context);
            }
            catch (Exception error)
            {
                await Results
                    .Json(
                        new { code = "TASK_WRITE_FAILED", error = error.Message },
                        statusCode: 500
                    )
                    .ExecuteAsync(context);
            }
        };
        if (method == "PATCH")
            app.MapMethods(route, ["PATCH"], handler);
        else
            app.MapPost(route, handler);
    }
}
