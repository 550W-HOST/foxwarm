using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Terminal;
using Foxwarm.Code;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterTerminalRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/terminals",
            async (HttpRequest request) =>
                Results.Ok(
                    new
                    {
                        terminals = await terminalRouter.ListAsync(request.HttpContext.RequestAborted),
                        supported = terminalRouter.Supported,
                        owner = "master",
                    }
                )
        );
        app.MapPost(
            "/api/terminals",
            async (HttpRequest request) =>
            {
                JsonObject body;
                try
                {
                    body =
                        await JsonNode.ParseAsync(
                            request.Body,
                            cancellationToken: request.HttpContext.RequestAborted
                        ) as JsonObject
                        ?? throw new InvalidDataException("Terminal input must be an object.");
                }
                catch (Exception error) when (error is JsonException or InvalidDataException)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
                try
                {
                    var nodeId = body["nodeId"]?.GetValue<string>()?.Trim() ?? "master";
                    var cwd = body["cwd"]?.GetValue<string>() ?? Environment.CurrentDirectory;
                    var cols = body["cols"]?.GetValue<int>() ?? 100;
                    var rows = body["rows"]?.GetValue<int>() ?? 30;
                    var record = await terminalRouter.CreateAsync(
                        nodeId, cwd,
                        cols,
                        rows,
                        request.HttpContext.RequestAborted
                    );
                    return Results.Ok(
                        new
                        {
                            success = true,
                            terminal = record,
                            streamPath = $"/api/terminals/stream?terminalId={Uri.EscapeDataString(record["id"]!.GetValue<string>())}",
                        }
                    );
                }
                catch (CodeServiceException error)
                {
                    return Results.Json(new { error = error.Message, code = error.Code }, statusCode: error.Status);
                }
                catch (Exception error)
                    when (error
                            is IOException
                                or InvalidOperationException
                                or PlatformNotSupportedException
                                or DirectoryNotFoundException
                                or ArgumentOutOfRangeException
                    )
                {
                    return Results.Json(new { error = error.Message }, statusCode: 400);
                }
            }
        );
        app.MapGet("/api/terminals/{id}", async (string id, HttpContext context) =>
        {
            try
            {
                var record = await terminalRouter.GetAsync(id, context.RequestAborted);
                return record is null ? Results.NotFound(new { error = "Terminal not found." }) : Results.Ok(new { terminal = record });
            }
            catch (CodeServiceException error) { return Results.Json(new { error = error.Message, code = error.Code }, statusCode: error.Status); }
        });
        app.MapDelete("/api/terminals/{id}", async (string id, HttpContext context) =>
        {
            try
            {
                await terminalRouter.CloseAsync(id, "client", context.RequestAborted);
                return Results.Ok(new { success = true, closed = true });
            }
            catch (CodeServiceException error) { return Results.Json(new { error = error.Message, code = error.Code }, statusCode: error.Status); }
        });
        app.MapGet(
            "/api/terminals/stream",
            async (HttpContext context) =>
            {
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    context.Response.StatusCode = 400;
                    return;
                }
                var id = context.Request.Query["terminalId"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(id))
                {
                    context.Response.StatusCode = 400;
                    return;
                }
                try
                {
                    if (await terminalRouter.GetAsync(id, context.RequestAborted) is null)
                    {
                        context.Response.StatusCode = 404;
                        await context.Response.WriteAsJsonAsync(new { error = "Terminal not found." });
                        return;
                    }
                }
                catch (CodeServiceException error)
                {
                    context.Response.StatusCode = error.Status;
                    await context.Response.WriteAsJsonAsync(new { error = error.Message, code = error.Code });
                    return;
                }
                using var socket = await context.WebSockets.AcceptWebSocketAsync(
                    new WebSocketAcceptContext
                    {
                        KeepAliveInterval = TimeSpan.FromSeconds(30),
                        KeepAliveTimeout = TimeSpan.FromSeconds(60),
                    }
                );
                try
                {
                    await terminalRouter.AttachAsync(
                        id, socket,
                        context.RequestAborted,
                        context.Request.Query["control"] == "code"
                    );
                }
                catch (CodeServiceException error)
                {
                    if (socket.State == WebSocketState.Open)
                    {
                        await socket.SendAsync(System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = "error", message = error.Message })), WebSocketMessageType.Text, true, CancellationToken.None);
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Terminal unavailable", CancellationToken.None);
                    }
                }
            }
        );
    }
}
