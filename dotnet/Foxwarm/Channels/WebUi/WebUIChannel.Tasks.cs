using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private static IResult TaskErrorResult(TaskError error) =>
        Results.Json(
            new { code = error.Code, error = error.Message },
            statusCode: error.StatusCode
        );

    private void RegisterTaskRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/tasks",
            (HttpRequest request) =>
            {
                try
                {
                    foreach (var key in request.Query.Keys)
                        if (key is not ("status" or "limit"))
                            throw new TaskError("TASK_INVALID_ARGS", "Invalid task query.");
                    var args = new JsonObject { ["action"] = "list" };
                    if (request.Query.TryGetValue("status", out var status))
                        args["status"] = status.ToString();
                    int? limit = null;
                    if (request.Query.TryGetValue("limit", out var rawLimit))
                    {
                        var raw = rawLimit.ToString();
                        if (!System.Text.RegularExpressions.Regex.IsMatch(raw, "^[1-9]\\d*$"))
                            throw new TaskError("TASK_INVALID_ARGS", "Invalid task query.");
                        limit = int.TryParse(raw, out var parsed) ? parsed : 51;
                    }
                    return Results.Ok(
                        sessions
                            .Tasks.ExecuteForWebUiAsync(args, null, limit)
                            .GetAwaiter()
                            .GetResult()
                    );
                }
                catch (TaskError error)
                {
                    return TaskErrorResult(error);
                }
                catch
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
            (HttpRequest request, string id) =>
            {
                try
                {
                    if (request.Query.Count > 0)
                        throw new TaskError(
                            "TASK_INVALID_ARGS",
                            "Task details do not accept query parameters."
                        );
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
                    return TaskErrorResult(error);
                }
                catch
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
                if (context.Request.Query.Count > 0)
                    throw new TaskError(
                        "TASK_INVALID_ARGS",
                        "Task operations do not accept query parameters."
                    );
                var body =
                    await JsonNode.ParseAsync(context.Request.Body) as JsonObject
                    ?? throw new TaskError(
                        "TASK_INVALID_ARGS",
                        "Task operations require a JSON object body."
                    );
                string? target = null;
                if (body.ContainsKey("sessionId"))
                {
                    if (
                        body["sessionId"] is not JsonValue value
                        || !value.TryGetValue<string>(out target)
                        || string.IsNullOrWhiteSpace(target)
                        || target.Length > 256
                    )
                        throw new TaskError(
                            "TASK_INVALID_ARGS",
                            "sessionId must identify an existing Session."
                        );
                    body.Remove("sessionId");
                }
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
                await TaskErrorResult(error).ExecuteAsync(context);
            }
            catch (JsonException)
            {
                await TaskErrorResult(
                        new TaskError(
                            "TASK_INVALID_ARGS",
                            "Task operations require a JSON object body."
                        )
                    )
                    .ExecuteAsync(context);
            }
            catch
            {
                await Results
                    .Json(
                        new { code = "TASK_READ_FAILED", error = "Tasks could not be loaded." },
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
