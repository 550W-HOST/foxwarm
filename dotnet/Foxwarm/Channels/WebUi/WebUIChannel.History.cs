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
        app.MapPost(
            "/api/sessions/{id}/fork",
            async (string id, HttpRequest request) =>
            {
                var parent = await FindRouteAsync(request, id);
                if (parent is null)
                    return Results.NotFound(new { error = "Session not found" });
                JsonObject? body;
                try
                {
                    body = await request.ReadFromJsonAsync<JsonObject>() ?? new JsonObject();
                }
                catch (System.Text.Json.JsonException)
                {
                    return Results.BadRequest(new { error = "Invalid fork request" });
                }
                if (
                    body.Any(pair => pair.Key != "suffix")
                    || body.ContainsKey("suffix") && body["suffix"] is not JsonValue
                )
                    return Results.BadRequest(new { error = "Invalid fork suffix" });
                try
                {
                    var child = await sessions.ForkAsync(parent, SessionWait.Text(body["suffix"]));
                    return Results.Ok(new { success = true, newSessionId = child.Id });
                }
                catch (CommittedSessionCreationException error)
                {
                    return Results.Json(
                        new
                        {
                            error = error.Message,
                            code = "partial_create",
                            sessionId = error.SessionId,
                        },
                        statusCode: 500
                    );
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapGet(
            "/api/sessions/{id}/state",
            async (string id, HttpRequest request) =>
                await FindRouteAsync(request, id) is { } hosted
                    ? Results.Ok(new { session = hosted.State() })
                    : Results.NotFound(new { error = "Session not found" })
        );
        app.MapGet(
            "/api/sessions/{id}/debug-file",
            async (string id, HttpRequest request) =>
            {
                var resolved = SessionCatalog.Text(runtime.Catalog.Resolve(id)["sessionId"]);
                if (resolved is null || runtime.Catalog.Get(resolved) is null)
                    return Results.NotFound(new { error = "Session not found" });
                var path = Path.Combine(sessions.DataRoot, "state", "sessions", resolved + ".json");
                if (!File.Exists(path))
                    return Results.NotFound(new { error = "Session file not found" });
                var payload =
                    JsonNode
                        .Parse(
                            await File.ReadAllTextAsync(path, request.HttpContext.RequestAborted)
                        )
                        ?.AsObject()
                    ?? throw new InvalidDataException("Session file JSON must be an object.");
                payload.Remove("contextFrontier");
                await sessions.Images.ExternalizeTreeAsync(
                    payload,
                    strict: false,
                    request.HttpContext.RequestAborted
                );
                return Results.Ok(new { resolvedPath = path, payload });
            }
        );
        app.MapGet(
            "/api/sessions/{id}/history",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                var query = request.Query;
                if (
                    query.Keys.Any(key =>
                        key is not ("tail" or "prefixLength" or "afterSeq" or "historyVersion")
                    )
                )
                    return Results.BadRequest(
                        new { error = "Invalid history query", code = "HISTORY_RANGE_INVALID" }
                    );
                if (
                    !ReadInt(query, "tail", out var tail)
                    || !ReadInt(query, "prefixLength", out var prefix)
                    || !ReadLong(query, "afterSeq", out var after)
                    || !ReadLong(query, "historyVersion", out var version)
                    || (tail.HasValue && tail.Value is < 1 or > 500)
                    || new[] { tail.HasValue, prefix.HasValue, after.HasValue }.Count(value =>
                        value
                    ) > 1
                    || (version.HasValue != (prefix.HasValue || after.HasValue))
                )
                    return Results.BadRequest(
                        new { error = "Invalid history query", code = "HISTORY_RANGE_INVALID" }
                    );
                var snapshot = hosted.Entry.Snapshot();
                if (
                    version.HasValue && version.Value != snapshot.HistoryVersion
                    || prefix.HasValue && prefix.Value > snapshot.History.Count
                )
                    return Results.Conflict(
                        new
                        {
                            error = "History changed while loading",
                            code = "SESSION_HISTORY_BOUNDARY_STALE",
                            retryable = true,
                            historyVersion = snapshot.HistoryVersion,
                        }
                    );
                var result = WebUiContract.History(
                    snapshot,
                    models,
                    hosted.ToolActive,
                    hosted.Compacting,
                    tail,
                    prefix,
                    after
                );
                result["session"]!["childPolicyChain"] = hosted
                    .BuildDto()["childPolicyChain"]
                    ?.DeepClone();
                return Results.Ok(result);
            }
        );
        app.MapGet(
            "/api/sessions/{id}/archive/messages/{seq}",
            async (string id, string seq, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (
                    !long.TryParse(
                        seq,
                        NumberStyles.None,
                        CultureInfo.InvariantCulture,
                        out var index
                    ) || index is <= 0 or > 9007199254740991L
                )
                    return Results.BadRequest(
                        new { error = "seq must be a positive safe integer." }
                    );
                var record = hosted
                    .Archive.ReadEffectiveMessagesRange(index, index)
                    .FirstOrDefault();
                if (record is not null)
                    await sessions.Images.ExternalizeMessageAsync(
                        record.Message,
                        strict: false,
                        request.HttpContext.RequestAborted
                    );
                return record is null
                    ? Results.NotFound(new { error = "Archived message not found" })
                    : Results.Ok(
                        new
                        {
                            seq = record.Seq,
                            message = record.Message,
                            messageJson = EcmaJson.Stringify(
                                Foxwarm.Images.ImageTransport.Project(record.Message)!
                            ),
                            sourceSessionId = record.SessionId,
                            inherited = record.SessionId != hosted.Id,
                        }
                    );
            }
        );
        app.MapGet(
            "/api/sessions/{id}/context-blocks/{blockId}/expand",
            async (string id, string blockId, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (
                    !long.TryParse(
                        blockId,
                        NumberStyles.None,
                        CultureInfo.InvariantCulture,
                        out var index
                    ) || index is <= 0 or > 9007199254740991L
                )
                    return Results.BadRequest(
                        new
                        {
                            error = "blockId must be a positive integer.",
                            code = "INVALID_CONTEXT_BLOCK_ID",
                        }
                    );
                var preview = 6000;
                if (
                    request.Query.TryGetValue("previewLength", out var rawPreview)
                    && (
                        !int.TryParse(
                            rawPreview,
                            NumberStyles.None,
                            CultureInfo.InvariantCulture,
                            out preview
                        ) || preview is < 1 or > 20000
                    )
                )
                    return Results.BadRequest(
                        new { error = "previewLength must be a positive integer at most 20000." }
                    );
                var result = ContextBlockExpansion.Render(
                    hosted.Archive,
                    hosted.Id,
                    index,
                    preview
                );
                if (result is not null)
                    await sessions.Images.ExternalizeTreeAsync(
                        result,
                        strict: false,
                        request.HttpContext.RequestAborted
                    );
                return result is null
                    ? Results.NotFound(
                        new
                        {
                            error = $"CTX-BLOCK B#{index} not found.",
                            code = "CTX_BLOCK_NOT_FOUND",
                        }
                    )
                    : Results.Ok(result);
            }
        );
        app.MapGet(
            "/api/history/window",
            async (HttpRequest request) =>
            {
                var sessionId = request.Query["sessionId"].ToString() ?? "";
                if (string.IsNullOrWhiteSpace(sessionId))
                    return Results.BadRequest(
                        new { error = "Choose a session.", code = "HISTORY_SEARCH_INVALID" }
                    );
                var target = request.Query["target"].ToString() ?? "";
                var before = ParseSafe(request.Query["beforeSeq"].ToString(), "beforeSeq");
                var after = ParseSafe(request.Query["afterSeq"].ToString(), "afterSeq");
                var targetEnd = ParseSafe(request.Query["targetEndSeq"].ToString(), "targetEndSeq");
                if (target.Length == 0 && before is null && after is null)
                    return Results.BadRequest(
                        new
                        {
                            error = "Choose a message reference or page direction.",
                            code = "HISTORY_SEARCH_INVALID",
                        }
                    );
                if (targetEnd is not null && (after is null || target.Length > 0))
                    return Results.BadRequest(
                        new
                        {
                            error = "targetEndSeq is only valid with afterSeq.",
                            code = "HISTORY_SEARCH_INVALID",
                        }
                    );
                if (
                    before is not null && after is not null
                    || target.Length > 0 && (before is not null || after is not null)
                )
                    return Results.BadRequest(
                        new
                        {
                            error = "Choose one paging direction.",
                            code = "HISTORY_SEARCH_INVALID",
                        }
                    );
                long? start = null;
                long? end = null;
                if (target.Length > 0)
                {
                    var match = System.Text.RegularExpressions.Regex.Match(
                        target,
                        "^msg#([1-9][0-9]*)(?:-([1-9][0-9]*))?$",
                        System.Text.RegularExpressions.RegexOptions.IgnoreCase
                    );
                    if (
                        !match.Success || !long.TryParse(match.Groups[1].Value, out var parsedStart)
                    )
                        return Results.BadRequest(
                            new
                            {
                                error = "Use msg#123 or msg#123-130.",
                                code = "HISTORY_SEARCH_INVALID",
                            }
                        );
                    start = parsedStart;
                    end =
                        match.Groups[2].Success
                        && long.TryParse(match.Groups[2].Value, out var parsedEnd)
                            ? parsedEnd
                            : start;
                    if (end < start)
                        return Results.BadRequest(
                            new
                            {
                                error = "Select an ascending message range.",
                                code = "HISTORY_SEARCH_INVALID",
                            }
                        );
                }
                var archive = sessions.ArchiveReader(sessionId);
                var all = archive.EffectiveMessageStats();
                if (runtime.Catalog.Get(sessionId) is null && all.Count == 0)
                    return Results.NotFound(
                        new { error = "Session not found", code = "SESSION_NOT_FOUND" }
                    );
                IReadOnlyList<ArchiveMessageRecord> records;
                if (start is long selectedStart)
                    records = archive.ReadEffectiveMessagesPage(selectedStart, end!.Value, 21);
                else if (before is long beforeValue)
                    records = archive.ReadEffectiveMessagesPage(
                        null,
                        beforeValue - 1,
                        21,
                        descending: true
                    );
                else if (after is long afterValue)
                    records = archive.ReadEffectiveMessagesPage(afterValue + 1, targetEnd, 21);
                else
                    records = archive.ReadEffectiveMessagesPage(null, null, 21);
                var pageHasMore = records.Count > 20;
                if (pageHasMore)
                    records = records.Take(20).ToArray();
                if (before is not null)
                    records = records.Reverse().ToArray();
                var first = records.FirstOrDefault()?.Seq;
                var last = records.LastOrDefault()?.Seq;
                var messages = new JsonArray();
                foreach (var record in records)
                {
                    var message = record.Message.DeepClone().AsObject();
                    var meta = message["__meta"] as JsonObject ?? new JsonObject();
                    meta["seq"] = record.Seq;
                    meta["timestamp"] = record.Timestamp;
                    meta["contextArchiveItem"] = new JsonObject
                    {
                        ["kind"] = "message",
                        ["seq"] = record.Seq,
                        ["sourceSessionId"] = record.SessionId,
                        ["inherited"] = record.SessionId != archive.CanonicalSessionId,
                    };
                    message["__meta"] = meta;
                    messages.Add(message);
                }
                await sessions.Images.ExternalizeTreeAsync(
                    messages,
                    strict: false,
                    request.HttpContext.RequestAborted
                );
                return Results.Ok(
                    new
                    {
                        sessionId,
                        messages,
                        firstSeq = first,
                        lastSeq = last,
                        hasEarlier = before is not null
                            ? pageHasMore
                            : first is long firstValue && all.First < firstValue,
                        hasLater = after is not null
                            ? pageHasMore
                            : last is long lastValue && all.Last > lastValue,
                        requestedRange = start is null
                            ? null
                            : new { startSeq = start, endSeq = end },
                        shownRange = first is null ? null : new { startSeq = first, endSeq = last },
                        hasMoreInTarget = start is not null && pageHasMore,
                    }
                );
            }
        );
    }

    private static long? ParseSafe(string value, string name)
    {
        if (string.IsNullOrEmpty(value))
            return null;
        if (
            !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            || number <= 0
            || number > 9007199254740991L
        )
            throw new InvalidDataException($"{name} must be a positive safe integer.");
        return number;
    }
}
