using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Terminal;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterTerminalRoutes(WebApplication app)
    {
        app.MapGet("/api/terminals", (HttpRequest request) => Results.Ok(new { terminals = terminals.List(), supported = TerminalRegistry.IsSupported, owner = "master" }));
        app.MapPost("/api/terminals", async (HttpRequest request) =>
        {
            if (!TerminalRegistry.IsSupported) return Results.Json(new { error = "Main terminal PTY is unavailable on this host." }, statusCode: 501);
            JsonObject body; try { body = await JsonNode.ParseAsync(request.Body, cancellationToken: request.HttpContext.RequestAborted) as JsonObject ?? throw new InvalidDataException("Terminal input must be an object."); }
            catch (Exception error) when (error is JsonException or InvalidDataException) { return Results.BadRequest(new { error = error.Message }); }
            try
            {
                var nodeId = body["nodeId"]?.GetValue<string>()?.Trim() ?? "master";
                if (!string.Equals(nodeId, "master", StringComparison.Ordinal)) return Results.Json(new { error = "Requested terminal node is unavailable on this Main host." }, statusCode: 501);
                var cwd = body["cwd"]?.GetValue<string>() ?? Environment.CurrentDirectory; var cols = body["cols"]?.GetValue<int>() ?? 120; var rows = body["rows"]?.GetValue<int>() ?? 30;
                var record = await terminals.CreateAsync(cwd, cols, rows, request.HttpContext.RequestAborted); return Results.Ok(new { terminal = record.Describe() });
            }
            catch (Exception error) when (error is IOException or InvalidOperationException or PlatformNotSupportedException or DirectoryNotFoundException or ArgumentOutOfRangeException)
            { return Results.Json(new { error = error.Message }, statusCode: 400); }
        });
        app.MapDelete("/api/terminals/{id}", async (string id) => { await terminals.CloseAsync(id, "client"); return Results.Ok(new { closed = true }); });
        app.MapGet("/api/terminals/stream", async (HttpContext context) =>
        {
            if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
            var id = context.Request.Query["terminalId"].FirstOrDefault(); if (string.IsNullOrWhiteSpace(id)) { context.Response.StatusCode = 400; return; }
            if (!terminals.TryGet(id, out var record) || record is null) { context.Response.StatusCode = 404; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync(new WebSocketAcceptContext { KeepAliveInterval = TimeSpan.FromSeconds(30), KeepAliveTimeout = TimeSpan.FromSeconds(60) });
            await using var client = await record.AttachAsync(socket, context.RequestAborted, context.Request.Query["control"] == "code");
        });
    }
}
