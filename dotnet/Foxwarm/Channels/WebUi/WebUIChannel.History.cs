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
    private void RegisterHistoryRoutes(WebApplication app)
    {
        var models = sessions.Models;
        app.MapPost("/api/sessions/{id}/fork", async (string id, HttpRequest request) =>
        {
            var parent = await FindRouteAsync(request, id);
            if (parent is null) return Results.NotFound(new { error = "Session not found" });
            JsonObject? body;
            try { body = await request.ReadFromJsonAsync<JsonObject>() ?? new JsonObject(); }
            catch (System.Text.Json.JsonException) { return Results.BadRequest(new { error = "Invalid fork request" }); }
            if (body.Any(pair => pair.Key != "suffix") || body.ContainsKey("suffix") && body["suffix"] is not JsonValue)
                return Results.BadRequest(new { error = "Invalid fork suffix" });
            try { var child = await sessions.ForkAsync(parent, SessionWait.Text(body["suffix"])); return Results.Ok(new { success = true, newSessionId = child.Id }); }
            catch (CommittedSessionCreationException error) { return Results.Json(new { error = error.Message, code = "partial_create", sessionId = error.SessionId }, statusCode: 500); }
            catch (InvalidDataException error) { return Results.BadRequest(new { error = error.Message }); }
        });
        app.MapGet("/api/sessions/{id}/state", async (string id, HttpRequest request) =>
            await FindRouteAsync(request, id) is { } hosted ? Results.Ok(new { session = hosted.State() }) : Results.NotFound(new { error = "Session not found" }));
        app.MapGet("/api/sessions/{id}/history", async (string id, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            var query = request.Query;
            if (query.Keys.Any(key => key is not ("tail" or "prefixLength" or "afterSeq" or "historyVersion")))
                return Results.BadRequest(new { error = "Invalid history query", code = "HISTORY_RANGE_INVALID" });
            if (!ReadInt(query, "tail", out var tail) || !ReadInt(query, "prefixLength", out var prefix)
                || !ReadLong(query, "afterSeq", out var after) || !ReadLong(query, "historyVersion", out var version)
                || (tail.HasValue && tail.Value is < 1 or > 500)
                || new[] { tail.HasValue, prefix.HasValue, after.HasValue }.Count(value => value) > 1
                || (version.HasValue != (prefix.HasValue || after.HasValue)))
                return Results.BadRequest(new { error = "Invalid history query", code = "HISTORY_RANGE_INVALID" });
            var snapshot = hosted.Entry.Snapshot();
            if (version.HasValue && version.Value != snapshot.HistoryVersion
                || prefix.HasValue && prefix.Value > snapshot.History.Count)
                return Results.Conflict(new
                {
                    error = "History changed while loading",
                    code = "SESSION_HISTORY_BOUNDARY_STALE",
                    retryable = true,
                    historyVersion = snapshot.HistoryVersion
                });
            var result = WebUiContract.History(snapshot, models, hosted.ToolActive, hosted.Compacting, tail, prefix, after);
            result["session"]!["childPolicyChain"] = hosted.BuildDto()["childPolicyChain"]?.DeepClone();
            return Results.Ok(result);
        });
        app.MapGet("/api/sessions/{id}/archive/messages/{seq}", async (string id, string seq, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            if (!long.TryParse(seq, NumberStyles.None, CultureInfo.InvariantCulture, out var index)
                || index is <= 0 or > 9007199254740991L)
                return Results.BadRequest(new { error = "seq must be a positive safe integer." });
            var record = hosted.Archive.ReadEffectiveMessagesRange(index, index).FirstOrDefault();
            return record is null ? Results.NotFound(new { error = "Archived message not found" })
                : Results.Ok(new { seq = record.Seq, message = record.Message, messageJson = record.MessageJson, sourceSessionId = record.SessionId, inherited = record.SessionId != hosted.Id });
        });
        app.MapGet("/api/sessions/{id}/context-blocks/{blockId}/expand", async (string id, string blockId, HttpRequest request) =>
        {
            var hosted = await FindRouteAsync(request, id);
            if (hosted is null) return Results.NotFound(new { error = "Session not found" });
            if (!long.TryParse(blockId, NumberStyles.None, CultureInfo.InvariantCulture, out var index)
                || index is <= 0 or > 9007199254740991L)
                return Results.BadRequest(new { error = "blockId must be a positive integer.", code = "INVALID_CONTEXT_BLOCK_ID" });
            var preview = 6000;
            if (request.Query.TryGetValue("previewLength", out var rawPreview)
                && (!int.TryParse(rawPreview, NumberStyles.None, CultureInfo.InvariantCulture, out preview)
                    || preview is < 1 or > 20000))
                return Results.BadRequest(new { error = "previewLength must be a positive integer at most 20000." });
            var result = ContextBlockExpansion.Render(hosted.Archive, hosted.Id, index, preview);
            return result is null ? Results.NotFound(new { error = $"CTX-BLOCK B#{index} not found.", code = "CTX_BLOCK_NOT_FOUND" })
                : Results.Ok(result);
        });
    }
}
