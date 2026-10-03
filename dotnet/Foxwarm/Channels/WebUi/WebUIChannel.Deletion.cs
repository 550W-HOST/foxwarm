using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterDeleteRoute(WebApplication app)
    {
        app.MapDelete("/api/sessions/{id}", async (string id, HttpRequest request) =>
        {
            if (!sessions.Accepting) return Results.StatusCode(503);
            try
            {
                JsonObject? input = null;
                if (request.ContentLength is > 0 || request.Headers.ContainsKey("Transfer-Encoding"))
                {
                    try { input = await JsonNode.ParseAsync(request.Body) as JsonObject; }
                    catch (JsonException error) { return Results.BadRequest(new { error = error.Message }); }
                    if (input is null) return Results.BadRequest(new { error = "Deletion request must be an object." });
                }
                var recursive = SessionCatalog.Flag(input?["includeDescendants"]);
                var identity = RouteIdentity(request, sessionOnly: true);
                if (identity is null) return Results.BadRequest(new { error = "Invalid Session path" });
                var result = await runtime.DeleteAsync(identity, recursive);
                if (SessionCatalog.Text(result["status"]) == "not-found") return Results.NotFound(new { error = "Session not found" });
                if (SessionCatalog.Text(result["status"]) == "busy")
                { result["error"] = result["message"]?.DeepClone(); result["code"] = "SESSION_DELETE_BUSY"; return Results.Json(result, statusCode: 409); }
                return Results.Ok(result);
            }
            catch (SessionDeletionException error)
            {
                var payload = (JsonObject)error.Details.DeepClone(); payload["error"] = error.Message; payload["code"] = error.Code;
                return Results.Json(payload, statusCode: error.Status);
            }
            catch (SessionPresentationException error) { return Results.Json(new { error = error.Message, code = error.Code }, statusCode: error.Status); }
            catch (Exception error) { return Results.Json(new { error = error.Message, code = "DELETE_SESSION_FAILED" }, statusCode: 500); }
        });
    }
}
