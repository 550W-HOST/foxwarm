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
                    ? Results.Ok(new { session = hosted.BuildDto() })
                    : Results.NotFound(new { error = "Session not found" })
        );
        app.MapGet(
            "/api/sessions/{id}/debug-file",
            async (string id, HttpRequest request) =>
            {
                var resolved = CatalogRoute(request);
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
                WebUiMessageTransport.ProjectMessages(payload["history"]);
                foreach (var item in (payload["queue"] as JsonArray ?? []).OfType<JsonObject>())
                {
                    if (item["message"] is JsonObject message)
                        WebUiMessageTransport.ProjectMessage(message);
                    WebUiMessageTransport.ProjectParts(item["parts"]);
                }
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
                    after,
                    hosted.ExecutionNode(snapshot.AuthorityEnvelope),
                    hosted.RuntimeSnapshot()
                );
                result["session"]!["childPolicyChain"] = hosted
                    .BuildDto()["childPolicyChain"]
                    ?.DeepClone();
                if (WebUiAccess.Request(request) is { } scoped)
                {
                    scoped.Require(hosted.Id);
                    result["persistentMemorySnapshot"] = null;
                    result["session"] = scoped.Session(result["session"]!.AsObject());
                    WebUiSessionImages.Project(result, hosted.Id, archive: false);
                }
                return Results.Ok(result);
            }
        );
        app.MapGet(
            "/api/sessions/{id}/history/continuous",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new { error = "Session not found" });
                if (
                    !TryReadHistoryQuery(
                        request,
                        ["beforeSeq", "afterSeq"],
                        out var query,
                        out var error
                    )
                    || !TryParseSafe(
                        query.GetValueOrDefault("beforeSeq"),
                        "beforeSeq",
                        out var before,
                        out error
                    )
                    || !TryParseSafe(
                        query.GetValueOrDefault("afterSeq"),
                        "afterSeq",
                        out var after,
                        out error
                    )
                )
                    return Results.BadRequest(new { error });
                if (before is not null && after is not null)
                    return Results.BadRequest(new { error = "Choose one paging direction." });
                var canonicalId = hosted.Id;
                var latest = hosted.Entry.Snapshot().NextMessageSeq - 1;
                var page = WebUiContinuousHistory.Read(hosted.Archive, before, after, latest);
                WebUiMessageTransport.ProjectMessages(page["messages"]);
                await sessions.Images.ExternalizeTreeAsync(
                    page,
                    strict: false,
                    request.HttpContext.RequestAborted
                );
                if (CatalogRoute(request) != canonicalId)
                    return Results.Json(
                        new { error = "Session binding changed." },
                        statusCode: 403
                    );
                if (WebUiAccess.Request(request) is { } scoped)
                {
                    scoped.Require(canonicalId);
                    WebUiSessionImages.Project(page, canonicalId, archive: true);
                }
                return Results.Ok(page);
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
                var projectedMessage = record is null ? null : WebUiMessageTransport.Message(record.Message);
                return record is null
                    ? Results.NotFound(new { error = "Archived message not found" })
                    : Results.Ok(
                        new
                        {
                            seq = record.Seq,
                            message = projectedMessage,
                            messageJson = EcmaJson.Stringify(
                                Foxwarm.Images.ImageTransport.Project(projectedMessage)!
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
                {
                    WebUiMessageTransport.ProjectMessages(result["messages"]);
                    foreach (var item in (result["items"] as JsonArray ?? []).OfType<JsonObject>())
                        if (item["message"] is JsonObject message)
                            WebUiMessageTransport.ProjectMessage(message);
                    await sessions.Images.ExternalizeTreeAsync(
                        result,
                        strict: false,
                        request.HttpContext.RequestAborted
                    );
                }
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
            "/api/history/search",
            async (HttpRequest request) =>
            {
                if (
                    !TryReadHistoryQuery(
                        request,
                        new[] { "query", "limit", "agentName", "sessionId" },
                        out var query,
                        out var queryError
                    )
                )
                    return Results.BadRequest(
                        new { error = queryError, code = "HISTORY_SEARCH_INVALID" }
                    );
                var search = query.GetValueOrDefault("query", "");
                if (search.Length == 0 || search.Length > 2000)
                    return Results.BadRequest(
                        new
                        {
                            error = "Enter a search query (up to 2,000 characters).",
                            code = "HISTORY_SEARCH_INVALID",
                        }
                    );
                if (
                    !TryParseSafe(
                        query.GetValueOrDefault("limit"),
                        "limit",
                        out var limit,
                        out queryError
                    )
                    || limit is long limitValue && (limitValue < 1 || limitValue > 20)
                )
                    return Results.BadRequest(
                        new
                        {
                            error = queryError ?? "limit must be between 1 and 20.",
                            code = "HISTORY_SEARCH_INVALID",
                        }
                    );
                var agentName = query.GetValueOrDefault("agentName", "");
                var sessionId = query.GetValueOrDefault("sessionId", "");
                if (agentName.Length > 200 || sessionId.Length > 300)
                    return Results.BadRequest(
                        new
                        {
                            error = "Agent or session name is too long.",
                            code = "HISTORY_SEARCH_INVALID",
                        }
                    );
                if (sessionId.Length > 0)
                {
                    var archive = sessions.ArchiveReader(sessionId);
                    var session = runtime.Catalog.Get(sessionId);
                    if (session is null && !archive.HasReadOnlyIdentity())
                        return Results.NotFound(
                            new { error = "Session not found", code = "SESSION_NOT_FOUND" }
                        );
                    if (session is not null && agentName.Length > 0)
                    {
                        var sessionAgent = SessionCatalog.Text(session["agent"]) ?? "main";
                        if (!string.Equals(sessionAgent, agentName, StringComparison.Ordinal))
                            return Results.BadRequest(
                                new
                                {
                                    error = "The selected session is not in that agent.",
                                    code = "HISTORY_SEARCH_INVALID",
                                }
                            );
                    }
                    else if (session is null && agentName.Length > 0)
                        return Results.BadRequest(
                            new
                            {
                                error = "Search this archived session without an additional agent filter.",
                                code = "HISTORY_SEARCH_INVALID",
                            }
                        );
                }
                try
                {
                    var result = await sessions.SearchVectorHistoryAsync(
                        search,
                        (int)(limit ?? 5),
                        agentName,
                        sessionId
                    );
                    foreach (var source in (result["results"] as JsonArray ?? []).OfType<JsonObject>())
                        WebUiMessageTransport.ProjectMessages(source["messages"]);
                    return Results.Ok(result);
                }
                catch (Foxwarm.Vector.VectorUnavailableException error)
                {
                    return Results.Json(
                        new { error = error.Message, code = error.Code },
                        statusCode: error.Code is "VECTOR_DISABLED" or "VECTOR_UNAVAILABLE"
                            ? 503
                            : 500
                    );
                }
                catch (Exception error)
                {
                    return Results.Json(
                        new { error = error.Message, code = "HISTORY_SEARCH_FAILED" },
                        statusCode: 500
                    );
                }
            }
        );
        app.MapGet(
            "/api/history/window",
            async (HttpRequest request) =>
            {
                if (
                    !TryReadHistoryQuery(
                        request,
                        new[] { "sessionId", "target", "beforeSeq", "afterSeq", "targetEndSeq" },
                        out var query,
                        out var queryError
                    )
                )
                    return Results.BadRequest(
                        new { error = queryError, code = "HISTORY_SEARCH_INVALID" }
                    );
                var sessionId = query.GetValueOrDefault("sessionId", "");
                if (string.IsNullOrWhiteSpace(sessionId))
                    return Results.BadRequest(
                        new { error = "Choose a session.", code = "HISTORY_SEARCH_INVALID" }
                    );
                if (sessionId.Length > 300)
                    return Results.BadRequest(
                        new { error = "Choose a session.", code = "HISTORY_SEARCH_INVALID" }
                    );
                var target = query.GetValueOrDefault("target", "");
                if (
                    !TryParseSafe(
                        query.GetValueOrDefault("beforeSeq"),
                        "beforeSeq",
                        out var before,
                        out queryError
                    )
                    || !TryParseSafe(
                        query.GetValueOrDefault("afterSeq"),
                        "afterSeq",
                        out var after,
                        out queryError
                    )
                    || !TryParseSafe(
                        query.GetValueOrDefault("targetEndSeq"),
                        "targetEndSeq",
                        out var targetEnd,
                        out queryError
                    )
                )
                    return Results.BadRequest(
                        new { error = queryError, code = "HISTORY_SEARCH_INVALID" }
                    );
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
                        !match.Success
                        || !TryParseSafe(
                            match.Groups[1].Value,
                            "start message",
                            out var parsedStart,
                            out queryError
                        )
                    )
                        return Results.BadRequest(
                            new
                            {
                                error = queryError ?? "Use msg#123 or msg#123-130.",
                                code = "HISTORY_SEARCH_INVALID",
                            }
                        );
                    start = parsedStart;
                    long? parsedEnd = null;
                    if (
                        match.Groups[2].Success
                        && !TryParseSafe(
                            match.Groups[2].Value,
                            "end message",
                            out parsedEnd,
                            out queryError
                        )
                    )
                        return Results.BadRequest(
                            new { error = queryError, code = "HISTORY_SEARCH_INVALID" }
                        );
                    end = match.Groups[2].Success ? parsedEnd : start;
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
                if (runtime.Catalog.Get(sessionId) is null && !archive.HasReadOnlyIdentity())
                    return Results.NotFound(
                        new { error = "Session not found", code = "SESSION_NOT_FOUND" }
                    );
                var all = archive.EffectiveMessageStats();
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
                    WebUiMessageTransport.ProjectMessage(message);
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
                        hasEarlier = first is long firstValue
                            && all.First is long archiveFirst
                            && archiveFirst < firstValue,
                        hasLater = last is long lastValue
                            && all.Last is long archiveLast
                            && archiveLast > lastValue,
                        requestedRange = start is null
                            ? null
                            : new { startSeq = start, endSeq = end },
                        shownRange = first is null ? null : new { startSeq = first, endSeq = last },
                        hasMoreInTarget = (start is not null || targetEnd is not null)
                            && pageHasMore,
                    }
                );
            }
        );
    }

    private static bool TryReadHistoryQuery(
        HttpRequest request,
        IEnumerable<string> allowedValues,
        out Dictionary<string, string> values,
        out string? error
    )
    {
        var allowed = allowedValues.ToHashSet(StringComparer.Ordinal);
        values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in request.Query)
        {
            if (!allowed.Contains(pair.Key) || pair.Value.Count != 1)
            {
                error = $"Invalid history search parameter: {pair.Key}.";
                return false;
            }
            values[pair.Key] = pair.Value[0]!.Trim();
        }
        error = null;
        return true;
    }

    private static bool TryParseSafe(
        string? value,
        string name,
        out long? number,
        out string? error
    )
    {
        number = null;
        if (value is null)
        {
            error = null;
            return true;
        }
        if (
            !System.Text.RegularExpressions.Regex.IsMatch(
                value,
                "^[1-9][0-9]*$",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant
            )
            || !long.TryParse(
                value,
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var parsed
            )
            || parsed > 9007199254740991L
        )
        {
            error = $"{name} must be a positive integer.";
            return false;
        }
        number = parsed;
        error = null;
        return true;
    }
}
