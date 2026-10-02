using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http.Features;
namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel(SessionManager sessions, SessionRuntime runtime, MessageRouter router)
{
    private readonly WebUiRealtime realtime = new(runtime);
    public void Register(WebApplication app)
    {
        var models = sessions.Models;
        app.Use(async (context, next) =>
        {
            try { await next(); }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
            catch (Exception error) when (!context.Response.HasStarted && error is IOException or InvalidDataException or InvalidOperationException or NotSupportedException)
            { await Results.Problem(error.Message, statusCode: 500).ExecuteAsync(context); }
        });
        app.MapGet("/health", () => Results.Ok(new { status = "ready" }));
        app.MapGet("/api/models", (HttpRequest request) => Results.Ok(WebUiContract.Models(models, request.Query["current"])));
        RegisterSetupRoutes(app);
        app.MapPost("/api/sessions/{id}/model", async (string id, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            if (!sessions.Accepting) return Results.StatusCode(503);
            try
            {
                var body = await JsonNode.ParseAsync(request.Body) as JsonObject
                    ?? throw new InvalidDataException("Model settings must be an object.");
                return Results.Ok(await runtime.UpdateSettingsAsync(hosted.Id, body));
            }
            catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException)
            { return Results.BadRequest(new { error = error.Message }); }
        });
        app.MapPost("/api/sessions/{id}/child-model", async (string id, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            if (!sessions.Accepting) return Results.StatusCode(503);
            try
            {
                var body = await JsonNode.ParseAsync(request.Body) as JsonObject ?? throw new InvalidDataException("Child settings must be an object.");
                return Results.Ok(await hosted.UpdateSettingsAsync(body, child: true));
            }
            catch (Exception error) when (error is JsonException or InvalidDataException or InvalidOperationException)
            { return Results.BadRequest(new { error = error.Message }); }
        });
        app.MapGet("/api/commands", () => Results.Ok(new
        {
            commands = new[]
            {
                new { name = "stop", description = "Stop current run, or use `/stop compact` to cancel compaction only", usage = "/stop [compact]", requiresSession = true },
                new { name = "continue", description = "Continue an interrupted turn without adding a new message", usage = "/continue", requiresSession = true },
                new { name = "fork", description = "Fork current session", usage = "/fork [suffix] [message]", requiresSession = true },
                new { name = "session", description = "Clear the current session history", usage = "/session clear", requiresSession = true },
                new { name = "compact", description = "Compact history.", usage = "/compact", requiresSession = true }
            }
        }));
        app.MapGet("/api/asr/status", () => Results.Ok(new { configured = false, available = false }));
        RegisterAgentRoutes(app);
        RegisterListRoutes(app);
        RegisterPresentationRoutes(app);
        RegisterHistoryRoutes(app);
        app.MapPost("/api/sessions/{id}/message", async (string id, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            if (!sessions.Accepting) return Results.StatusCode(503);
            JsonObject? input;
            try { input = await JsonNode.ParseAsync(request.Body) as JsonObject; }
            catch (JsonException) { return Results.BadRequest(new { error = "Invalid JSON" }); }
            string? text = null;
            if (input?["text"] is JsonValue scalar && scalar.TryGetValue<string>(out var plain)
                && input is not null && input.All(pair => pair.Key is "text" or "clientMessageId")) text = plain;
            else if (input is not null && input["parts"] is JsonArray { Count: 1 } parts && parts[0] is JsonObject part
                && part.Count == 1 && part["text"] is JsonValue content && content.TryGetValue<string>(out var fromChat)
                && input["uploadedFiles"] is JsonArray { Count: 0 }
                && input.All(pair => pair.Key is "parts" or "uploadedFiles" or "clientMessageId")) text = fromChat;
            if (input is null || string.IsNullOrWhiteSpace(text))
                return Results.BadRequest(new { error = "This experimental endpoint accepts text-only messages, without attachments." });
            var clientId = input["clientMessageId"] is JsonValue idValue && idValue.TryGetValue<string>(out var idText)
                && idText.Length is > 0 and <= 160 ? idText : null;
            if (input.ContainsKey("clientMessageId") && clientId is null)
                return Results.BadRequest(new { error = "Invalid clientMessageId" });
            try
            {
                var result = await router.HandleMessageAsync(new ChannelContext(hosted.Id, "webui"), new ChannelMessage(text, clientId));
                return Results.Json(result.Value, statusCode: result.Status);
            }
            catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
        });
        app.MapGet("/api/webui/stream", async (HttpContext context) =>
        {
            if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, app.Lifetime.ApplicationStopping);
            await realtime.RunAsync(socket, lifetime.Token);
        });
        app.MapPost("/api/sessions/{id}/stop", async (string id, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            if (hosted.Compactor.Standalone) return Results.Ok(new { stoppedCurrent = false, abortedInFlight = false });
            if (!hosted.Metadata().Busy) return Results.Ok(new { stoppedCurrent = false, abortedInFlight = false });
            try
            {
                var result = await runtime.StopAsync(hosted.Id);
                return Results.Ok(new { stoppedCurrent = result.StoppedCurrent, abortedInFlight = result.AbortedInFlight });
            }
            catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
        });
        app.MapGet("/api/sessions/{id}/stream", async (string id, HttpContext context) =>
        {
            var hosted = await FindRouteAsync(context.Request, id);
            if (hosted is null) { context.Response.StatusCode = 404; return; }
            context.Response.Headers.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            var (subscriptionId, reader) = hosted.Subscribe();
            try
            {
                await SendSse(context, new JsonObject { ["type"] = "connected" });
                await SendSse(context, JsonSerializer.SerializeToNode(new { type = "session-state", session = hosted.State() })!.AsObject());
                await foreach (var item in reader.ReadAllAsync(context.RequestAborted)) await SendSse(context, WebUiContract.CliEvent(item, runtime));
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
            catch (IOException) when (context.RequestAborted.IsCancellationRequested) { }
            finally { hosted.Unsubscribe(subscriptionId); }
        });
        app.MapPost("/admin/shutdown", (IHostApplicationLifetime lifetime) =>
        {
            sessions.BeginShutdown();
            lifetime.StopApplication();
            return Results.Accepted();
        });

    }
    private static string? RouteIdentity(HttpRequest request)
    {
        var parts = request.HttpContext.Features.Get<IHttpRequestFeature>()?.RawTarget?.Split('?', 2)[0].Split('/');
        if (parts is null || parts.Length < 5 || parts[1] != "api" || parts[2] != "sessions" || parts[3].Length == 0) return null;
        try { return Uri.UnescapeDataString(parts[3]); } catch (UriFormatException) { return null; }
    }
    private async Task<SessionOwner?> FindRouteAsync(HttpRequest request, string routeId)
        => RouteIdentity(request) is { } id ? await runtime.GetOwnerAsync(id, request.HttpContext.RequestAborted) : null;
    private string? CatalogRoute(HttpRequest request)
        => RouteIdentity(request) is { } id ? SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"]) : null;
    private static async Task SendSse(HttpContext context, JsonObject payload)
    {
        await context.Response.WriteAsync("data: " + payload.ToJsonString() + "\n\n", context.RequestAborted);
        await context.Response.Body.FlushAsync(context.RequestAborted);
    }
    static bool ReadInt(IQueryCollection query, string name, out int? value)
    {
        value = null;
        if (!query.TryGetValue(name, out var text)) return true;
        if (!int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return false;
        value = parsed;
        return true;
    }

    static bool ReadLong(IQueryCollection query, string name, out long? value)
    {
        value = null;
        if (!query.TryGetValue(name, out var text)) return true;
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)) return false;
        value = parsed;
        return true;
    }

}
