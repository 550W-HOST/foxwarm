using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterRelationRoutes(WebApplication app)
    {
        foreach (var action in new[] { "archive", "pin", "move", "promote" })
        {
            app.MapPost("/api/sessions/{id}/" + action, async (string id, HttpRequest request) =>
            {
                var canonical = CatalogRoute(request); if (canonical is null) return Results.NotFound(new { error = "Session not found" });
                if (!sessions.Accepting) return Results.StatusCode(503);
                try
                {
                    var body = await JsonNode.ParseAsync(request.Body) as JsonObject ?? new JsonObject();
                    PresentationChange change;
                    if (action == "pin")
                    {
                        if (body["pinned"] is not JsonValue value || !value.TryGetValue<bool>(out var pinned)) return Results.BadRequest(new { error = "pinned must be a boolean" });
                        change = runtime.ChangePresentation(catalog => catalog.Pin(canonical, pinned));
                    }
                    else if (action == "archive")
                    {
                        var archived = !(body["archived"] is JsonValue flag && flag.TryGetValue<bool>(out var value) && !value);
                        var descendants = body["includeDescendants"] is JsonValue option && option.TryGetValue<bool>(out var include) && include;
                        change = runtime.ChangePresentation(catalog => catalog.Archive(canonical, archived, descendants));
                    }
                    else change = runtime.ChangePresentation(catalog => catalog.Move(canonical, body, action == "promote"));
                    return Results.Ok(change.Result);
                }
                catch (SessionPresentationException error) { return Results.Json(new { error = error.Message, code = error.Code, sessionId = canonical }, statusCode: error.Status); }
                catch (PresentationCommittedException error) { return Results.Json(new { error = error.Message, committed = true, result = error.Change.Result }, statusCode: 500); }
                catch (Microsoft.Data.Sqlite.SqliteException error) { return Results.Json(new { error = error.Message, code = action == "archive" ? "ARCHIVE_SESSION_FAILED" : action == "move" ? "MOVE_SESSION_FAILED" : action == "promote" ? "PROMOTE_FAILED" : "PIN_SESSION_FAILED" }, statusCode: 500); }
                catch (System.Text.Json.JsonException error) { return Results.BadRequest(new { error = error.Message }); }
            });
        }
    }
}
