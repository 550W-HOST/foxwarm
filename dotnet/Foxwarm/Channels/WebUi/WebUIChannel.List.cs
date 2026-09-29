using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterListRoutes(WebApplication app)
    {
        app.MapGet("/api/session-list/sidebar", (HttpRequest request) => ListResult(() =>
        {
            var query = request.Query;
            SessionListQueries.Keys(query.Keys, "mode", "limit", "childLimit", "cursor", "focusSessionId");
            var mode = SessionListQueries.Mode(Query(query, "mode"));
            var limit = SessionListQueries.Limit(Query(query, "limit"), 50, 100);
            var childLimit = SessionListQueries.Limit(Query(query, "childLimit"), 5, 20);
            var focusIds = query["focusSessionId"].ToArray();
            if (focusIds.Length > 8 || focusIds.Any(id => id is null || id.Length is < 1 or > 512))
                throw new SessionListQueryException("SESSION_LIST_FOCUS_INVALID", "focusSessionId accepts at most 8 bounded values.");
            var view = new SessionListQueries(runtime);
            var result = view.Page(mode, limit, Query(query, "cursor"));
            var children = new JsonArray();
            if (mode != "flat-time") foreach (var row in (result["sessions"] as JsonArray)!.OfType<JsonObject>())
            {
                var group = view.ChildPage(row["id"]!.GetValue<string>(), mode, childLimit);
                group.Remove("nextCursor"); group.Remove("reset"); children.Add(group);
            }
            var focus = view.Exact(focusIds.Cast<string>().Distinct(StringComparer.Ordinal).ToArray(), true);
            var forced = new JsonObject(); var context = new HashSet<string>(StringComparer.Ordinal);
            foreach (var path in (focus["paths"] as JsonObject)!.Select(pair => (JsonArray)pair.Value!))
                for (var index = 0; index < path.Count; index++)
                {
                    var id = path[index]!.GetValue<string>(); context.Add(id);
                    if (index + 1 >= path.Count) continue;
                    if (forced[id] is not JsonArray links) forced[id] = links = new JsonArray();
                    var next = path[index + 1]!.GetValue<string>();
                    if (!links.Any(item => item!.GetValue<string>() == next)) links.Add(next);
                }
            result["children"] = children;
            result["focus"] = focus["results"]!.DeepClone();
            result["presentationPaths"] = focus["paths"]!.DeepClone();
            result["pathContext"] = view.Exact(context.ToArray(), false)["results"]!.DeepClone();
            result["forcedChildren"] = forced;
            return result;
        }));
        app.MapPost("/api/session-list/by-id", async (HttpRequest request) => await ListBody(request, body =>
        {
            SessionListQueries.Keys(body.Select(pair => pair.Key), "ids", "includePaths");
            if (body.ContainsKey("includePaths") && (body["includePaths"] is not JsonValue flag || !flag.TryGetValue<bool>(out _)))
                throw new SessionListQueryException("SESSION_LIST_DTO_INVALID", "includePaths must be boolean.");
            return new SessionListQueries(runtime).Exact(SessionListQueries.Ids(body["ids"]), body["includePaths"]?.GetValue<bool>() == true);
        }));
        app.MapPost("/api/session-list/children", async (HttpRequest request) => await ListBody(request, body =>
        {
            SessionListQueries.Keys(body.Select(pair => pair.Key), "mode", "limit", "parents", "agent");
            var mode = SessionListQueries.Mode(body["mode"]?.GetValue<string>());
            var limit = BodyLimit(body, "limit", 20, 20);
            var agent = body["agent"]?.GetValue<string>();
            if (body["parents"] is not JsonArray parents || parents.Count > 20)
                throw new SessionListQueryException("SESSION_LIST_CHILDREN_INVALID", "parents accepts at most 20 requests.");
            var seen = new HashSet<string>(StringComparer.Ordinal); var requests = new List<(string Id, string? Cursor)>();
            foreach (var node in parents)
            {
                if (node is not JsonObject parent) throw new SessionListQueryException("SESSION_LIST_CHILDREN_INVALID", "Invalid child request.");
                SessionListQueries.Keys(parent.Select(pair => pair.Key), "parentSessionId", "cursor");
                var id = parent["parentSessionId"]?.GetValue<string>();
                if (id is null || id.Length is < 1 or > 512 || !seen.Add(id))
                    throw new SessionListQueryException("SESSION_LIST_CHILDREN_INVALID", "Child parent IDs must be unique bounded strings.");
                requests.Add((id, parent["cursor"]?.GetValue<string>()));
            }
            var view = new SessionListQueries(runtime);
            var pages = requests.Select(item => view.ChildPage(item.Id, mode, limit, item.Cursor, agent)).ToArray();
            var reset = pages.Any(page => page["reset"]!.GetValue<bool>());
            if (reset) pages = requests.Select(item => view.ChildPage(item.Id, mode, limit, item.Cursor, agent, true)).ToArray();
            foreach (var page in pages) page.Remove("reset");
            return new JsonObject
            {
                ["version"] = 1,
                ["revision"] = view.Revision,
                ["reset"] = reset,
                ["children"] = new JsonArray(pages.Select(page => (JsonNode?)page).ToArray())
            };
        }));
        app.MapPost("/api/session-list/descendant-activity", async (HttpRequest request) => await ListBody(request, body =>
        {
            SessionListQueries.Keys(body.Select(pair => pair.Key), "ids");
            var ids = SessionListQueries.Ids(body["ids"]); var view = new SessionListQueries(runtime);
            return new JsonObject
            {
                ["version"] = 1,
                ["revision"] = view.Revision,
                ["results"] = new JsonArray(ids.Select(id => (JsonNode?)new JsonObject
                {
                    ["sessionId"] = id,
                    ["busy"] = view.DescendantRows(id).Count(row => row.Busy)
                }).ToArray())
            };
        }));
        app.MapGet("/api/session-list/search", (HttpRequest request) => ListResult(() =>
        {
            SessionListQueries.Keys(request.Query.Keys, "q", "limit");
            var query = (Query(request.Query, "q") ?? "").Trim();
            if (query.Length is < 1 or > 256) throw new SessionListQueryException("SESSION_LIST_QUERY_INVALID", "q must contain 1 to 256 characters.");
            return new SessionListQueries(runtime).Search(query, SessionListQueries.Limit(Query(request.Query, "limit"), 50, 100));
        }));
        app.MapGet("/api/session-list/architecture", (HttpRequest request) => ListResult(() =>
        {
            SessionListQueries.Keys(request.Query.Keys, "agent", "limit", "childLimit", "cursor");
            var view = new SessionListQueries(runtime); var agent = Query(request.Query, "agent");
            var roots = view.Page("time", SessionListQueries.Limit(Query(request.Query, "limit"), 50, 100), Query(request.Query, "cursor"), true, agent);
            var children = (roots["sessions"] as JsonArray)!.OfType<JsonObject>().Select(row =>
                view.ChildPage(row["id"]!.GetValue<string>(), "time", SessionListQueries.Limit(Query(request.Query, "childLimit"), 10, 20), agent: agent)).ToArray();
            foreach (var child in children) child.Remove("reset");
            return new JsonObject
            {
                ["version"] = 1,
                ["revision"] = view.Revision,
                ["summary"] = view.GlobalSummary(),
                ["agentCounts"] = view.AgentCounts(),
                ["agent"] = agent,
                ["roots"] = roots,
                ["children"] = new JsonArray(children.Select(group => (JsonNode?)group).ToArray())
            };
        }));
        app.MapGet("/api/session-list/descendants/{id}", (string id, HttpRequest request) => ListResult(() =>
        {
            SessionListQueries.Keys(request.Query.Keys, "limit");
            var raw = request.HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpRequestFeature>()?.RawTarget?.Split('?', 2)[0].Split('/').Last();
            var canonical = Uri.UnescapeDataString(raw ?? id);
            if (runtime.Owner(canonical) is null) throw new SessionListQueryException("SESSION_NOT_FOUND", "Session not found.");
            var view = new SessionListQueries(runtime); var descendants = view.DescendantRows(canonical);
            var result = view.Summary(descendants); result["version"] = 1; result["sessionId"] = canonical; result["previewOnly"] = true;
            result["sessions"] = new JsonArray(descendants.Take(SessionListQueries.Limit(Query(request.Query, "limit"), 20, 100))
                .Select(row => (JsonNode?)view.Projection(row.Id)).ToArray());
            return result;
        }));
    }
    private static string? Query(IQueryCollection query, string name)
    {
        if (!query.TryGetValue(name, out var values)) return null;
        if (values.Count != 1) throw new SessionListQueryException("SESSION_LIST_QUERY_INVALID", "Expected one query string.");
        return values[0];
    }
    private static int BodyLimit(JsonObject body, string name, int fallback, int max) => !body.ContainsKey(name) ? fallback
        : body[name] is JsonValue value && value.TryGetValue<int>(out var number) && number > 0 && number <= max ? number
        : throw new SessionListQueryException("SESSION_LIST_LIMIT_INVALID", "Invalid limit.");
    private static IResult ListResult(Func<JsonObject> build)
    {
        try { return Results.Ok(build()); }
        catch (SessionListQueryException error) { return Results.Json(new { error = error.Message, code = error.Code }, statusCode: error.Code == "SESSION_NOT_FOUND" ? 404 : 400); }
        catch (Exception error) when (error is System.Text.Json.JsonException or InvalidOperationException or FormatException)
        { return Results.BadRequest(new { error = "Invalid Session list request", code = "SESSION_LIST_DTO_INVALID" }); }
    }
    private static async Task<IResult> ListBody(HttpRequest request, Func<JsonObject, JsonObject> build)
    {
        try
        {
            var body = await JsonNode.ParseAsync(request.Body) as JsonObject;
            return body is null ? Results.BadRequest(new { error = "Request must be an object", code = "SESSION_LIST_DTO_INVALID" }) : ListResult(() => build(body));
        }
        catch (System.Text.Json.JsonException) { return Results.BadRequest(new { error = "Invalid JSON", code = "SESSION_LIST_DTO_INVALID" }); }
    }
}
