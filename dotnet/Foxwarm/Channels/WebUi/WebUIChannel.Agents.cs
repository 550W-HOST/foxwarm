using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http.Features;
namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterAgentRoutes(WebApplication app)
    {
        app.MapGet("/api/agents", () => Results.Ok(new { agents = sessions.Agents().Select(id => new { id, inherit = (string?)null }) }));
        app.MapPost("/api/agents", async (HttpRequest request) =>
        {
            try
            {
                var body = await JsonNode.ParseAsync(request.Body) as JsonObject ?? throw new InvalidDataException("Agent creation needs an object.");
                if (body.Any(item => item.Key is not ("agentId" or "inheritAgent"))
                    || body["agentId"] is not JsonValue agent || !agent.TryGetValue<string>(out var name))
                    return Results.BadRequest(new { error = "agentId is required." });
                if (body["inheritAgent"] is not null) return Results.Json(new { error = "Agent inheritance has not been implemented." }, statusCode: 501);
                var created = await sessions.CreateAgentAsync(name.Trim());
                return Results.Json(new { success = true, agentId = created.AgentName, sessionId = created.MainSessionId }, statusCode: 201);
            }
            catch (CommittedSessionCreationException error)
            { return Results.Json(new { error = error.Message, sessionId = error.SessionId, agentCreated = true }, statusCode: 409); }
            catch (Exception error) when (error is InvalidDataException or IOException or JsonException or InvalidOperationException)
            { return Results.BadRequest(new { error = error.Message }); }
        });
        app.MapGet("/api/sessions", () => Results.Ok(new { sessions = runtime.ListSessions() }));
        app.MapPost("/api/sessions", async (HttpRequest request) =>
        {
            try
            {
                JsonObject? body = null;
                if (request.ContentLength is > 0) body = await JsonNode.ParseAsync(request.Body) as JsonObject
                    ?? throw new InvalidDataException("Session creation must be an object.");
                SessionOwner hosted;
                if (body is null || body.Count == 0) hosted = await sessions.CreateAsync();
                else
                {
                    if (body.Any(item => item.Key is not ("agentId" or "sessionId"))
                        || body.ContainsKey("agentId") && (body["agentId"] is not JsonValue agent || !agent.TryGetValue<string>(out _))
                        || body.ContainsKey("sessionId") && (body["sessionId"] is not JsonValue named || !named.TryGetValue<string>(out _)))
                        throw new InvalidDataException("Invalid Session creation fields.");
                    var agentName = body["agentId"]?.GetValue<string>()?.Trim() ?? "main";
                    var requested = body["sessionId"]?.GetValue<string>()?.Trim();
                    hosted = agentName == "main" && string.IsNullOrEmpty(requested) ? await sessions.CreateAsync()
                        : await sessions.CreateNamedAsync(agentName, string.IsNullOrEmpty(requested) ? $"s_{Guid.NewGuid():N}" : requested, null, null);
                }
                return Results.Ok(new { success = true, sessionId = hosted.Id });
            }
            catch (CommittedSessionCreationException error)
            {
                return Results.Json(new
                {
                    error = error.Message,
                    sessionId = error.SessionId,
                    committed = true,
                    initialDeliveryCommitted = error.InitialDeliveryCommitted
                }, statusCode: 409);
            }
            catch (Exception error) when (error is InvalidDataException or JsonException or InvalidOperationException)
            { return Results.BadRequest(new { error = error.Message }); }
            catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
        });
        app.MapPost("/api/sessions/{id}/children", async (string id, HttpRequest request) =>
        {
            var parent = FindRoute(request, id);
            if (parent is null) return Results.NotFound(new { error = "Parent Session not found" });
            if (!sessions.Accepting) return Results.StatusCode(503);
            try
            {
                var body = await JsonNode.ParseAsync(request.Body) as JsonObject ?? throw new InvalidDataException("Child creation must be an object.");
                if (body.Any(item => item.Key is not ("suffix" or "agentName" or "displayName" or "message" or "forceModel"))
                    || body["suffix"] is not JsonValue suffixValue || !suffixValue.TryGetValue<string>(out var suffix)
                    || new[] { "agentName", "displayName", "message" }.Any(key => body.ContainsKey(key)
                        && (body[key] is not JsonValue item || !item.TryGetValue<string>(out _)))
                    || body.ContainsKey("forceModel") && body["forceModel"] is not JsonObject)
                    throw new InvalidDataException("Invalid child creation fields.");
                var (child, delivered) = await sessions.CreateChildAsync(parent, suffix,
                    body["agentName"]?.GetValue<string>(), body["displayName"]?.GetValue<string>(),
                    body["message"]?.GetValue<string>(), body["forceModel"] as JsonObject);
                return Results.Ok(new { success = true, sessionId = child.Id, parentSessionId = parent.Id, delivered });
            }
            catch (CommittedSessionCreationException error)
            {
                return Results.Json(new
                {
                    error = error.Message,
                    sessionId = error.SessionId,
                    committed = true,
                    initialDeliveryCommitted = error.InitialDeliveryCommitted
                }, statusCode: 409);
            }
            catch (Exception error) when (error is InvalidDataException or JsonException or InvalidOperationException)
            { return Results.BadRequest(new { error = error.Message }); }
        });
        app.MapPost("/api/sessions/{id}/refresh-memory", async (string id, HttpRequest request) =>
        {
            var session = FindRoute(request, id);
            if (session is null) return Results.NotFound(new { error = "Session not found" });
            if (!sessions.Accepting) return Results.StatusCode(503);
            try
            {
                var model = await sessions.RefreshSnapshotAsync(session);
                return Results.Ok(new { success = true, sessionId = session.Id, concreteModelId = model });
            }
            catch (Exception error) { return Results.Problem(error.Message, statusCode: 500); }
        });
    }
}
