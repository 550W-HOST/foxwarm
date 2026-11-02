using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterListRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/session-list/sidebar",
            (HttpRequest request) =>
                ListResult(() =>
                {
                    var query = request.Query;
                    SessionListQueries.Keys(
                        query.Keys,
                        "mode",
                        "limit",
                        "childLimit",
                        "cursor",
                        "focusSessionId",
                        "group"
                    );
                    var mode = SessionListQueries.Mode(Query(query, "mode"));
                    var grouping = SessionListQueries.Grouping(Query(query, "group"));
                    var limit = SessionListQueries.Limit(Query(query, "limit"), 50, 100);
                    var childLimit = SessionListQueries.Limit(Query(query, "childLimit"), 5, 20);
                    var focusIds = query["focusSessionId"].ToArray();
                    if (
                        focusIds.Length > 8
                        || focusIds.Any(id => id is null || id.Length is < 1 or > 512)
                    )
                        throw new SessionListQueryException(
                            "SESSION_LIST_FOCUS_INVALID",
                            "focusSessionId accepts at most 8 bounded values."
                        );
                    var view = new SessionListQueries(runtime);
                    // A grouped Sidebar pages the pinned section here and each group separately.
                    var result = view.Page(
                        mode,
                        limit,
                        Query(query, "cursor"),
                        pinnedOnly: grouping is not null
                    );
                    var rootIds = (result["sessions"] as JsonArray)!
                        .OfType<JsonObject>()
                        .Select(row => row["id"]!.GetValue<string>())
                        .ToArray();
                    var groups =
                        mode == "flat-time"
                            ? []
                            : view.ChildPages(
                                rootIds.Select(id => (id, (string?)null)).ToArray(),
                                mode,
                                childLimit,
                                previews: true
                            );
                    foreach (var group in groups)
                    {
                        group.Remove("nextCursor");
                        group.Remove("reset");
                    }
                    var children = new JsonArray(
                        groups.Select(group => (JsonNode?)group).ToArray()
                    );
                    var focus = view.Exact(
                        focusIds.Cast<string>().Distinct(StringComparer.Ordinal).ToArray(),
                        true
                    );
                    var forced = new JsonObject();
                    var context = new HashSet<string>(StringComparer.Ordinal);
                    foreach (
                        var path in (focus["paths"] as JsonObject)!.Select(pair =>
                            (JsonArray)pair.Value!
                        )
                    )
                        for (var index = 0; index < path.Count; index++)
                        {
                            var id = path[index]!.GetValue<string>();
                            context.Add(id);
                            if (index + 1 >= path.Count)
                                continue;
                            if (forced[id] is not JsonArray links)
                                forced[id] = links = new JsonArray();
                            var next = path[index + 1]!.GetValue<string>();
                            if (!links.Any(item => item!.GetValue<string>() == next))
                                links.Add(next);
                        }
                    result["children"] = children;
                    result["focus"] = focus["results"]!.DeepClone();
                    result["presentationPaths"] = focus["paths"]!.DeepClone();
                    result["pathContext"] = view.Exact(context.ToArray(), false)[
                        "results"
                    ]!.DeepClone();
                    result["forcedChildren"] = forced;
                    if (grouping is not null)
                    {
                        result["groups"] = view.Groups(grouping, mode, GroupNodes());
                        // Tree paths are shown under their first row; Flat shows every row by itself.
                        result["presentationGroups"] = view.PresentationGroups(
                            mode == "flat-time"
                                ? context
                                : (focus["paths"] as JsonObject)!
                                    .Select(pair => (pair.Value as JsonArray)?.FirstOrDefault())
                                    .Select(first => first?.GetValue<string>())
                                    .OfType<string>(),
                            grouping,
                            mode
                        );
                    }
                    return result;
                })
        );
        app.MapPost(
            "/api/session-list/by-id",
            async (HttpRequest request) =>
                await ListBody(
                    request,
                    body =>
                    {
                        SessionListQueries.Keys(
                            body.Select(pair => pair.Key),
                            "ids",
                            "includePaths",
                            "group",
                            "mode"
                        );
                        if (
                            body.ContainsKey("includePaths")
                            && (
                                body["includePaths"] is not JsonValue flag
                                || !flag.TryGetValue<bool>(out _)
                            )
                        )
                            throw new SessionListQueryException(
                                "SESSION_LIST_DTO_INVALID",
                                "includePaths must be boolean."
                            );
                        var grouping = SessionListQueries.Grouping(BodyText(body, "group"));
                        var mode = SessionListQueries.Mode(BodyText(body, "mode"));
                        var view = new SessionListQueries(runtime);
                        var result = view.Exact(
                            SessionListQueries.Ids(body["ids"]),
                            body["includePaths"]?.GetValue<bool>() == true
                        );
                        // Grouped Sidebars place exact rows outside a loaded page by these keys.
                        if (grouping is not null)
                            result["presentationGroups"] = view.PresentationGroups(
                                (result["results"] as JsonArray)!
                                    .Select(item =>
                                        SessionCatalog.Text(item?["resolution"]?["sessionId"])
                                    )
                                    .OfType<string>(),
                                grouping,
                                mode
                            );
                        return result;
                    }
                )
        );
        app.MapPost(
            "/api/session-list/children",
            async (HttpRequest request) =>
                await ListBody(
                    request,
                    body =>
                    {
                        SessionListQueries.Keys(
                            body.Select(pair => pair.Key),
                            "mode",
                            "limit",
                            "parents",
                            "agent"
                        );
                        var mode =
                            !body.ContainsKey("mode") ? "default"
                            : body["mode"] is JsonValue modeValue
                            && modeValue.TryGetValue<string>(out var modeText)
                                ? SessionListQueries.Mode(modeText)
                            : throw new SessionListQueryException(
                                "SESSION_LIST_MODE_INVALID",
                                "mode must be default, time, or flat-time."
                            );
                        var limit = BodyLimit(body, "limit", 10, 20);
                        var agent =
                            !body.ContainsKey("agent") ? null
                            : body["agent"] is JsonValue agentValue
                            && agentValue.TryGetValue<string>(out var agentText)
                            && agentText.Length is > 0 and <= 128
                                ? agentText
                            : throw new SessionListQueryException(
                                "SESSION_LIST_AGENT_INVALID",
                                "agent is invalid."
                            );
                        if (agent is not null && mode != "time")
                            throw new SessionListQueryException(
                                "SESSION_LIST_MODE_INVALID",
                                "Agent-scoped children require time mode."
                            );
                        if (body["parents"] is not JsonArray parents || parents.Count > 20)
                            throw new SessionListQueryException(
                                "SESSION_LIST_CHILDREN_INVALID",
                                "parents accepts at most 20 requests."
                            );
                        var seen = new HashSet<string>(StringComparer.Ordinal);
                        var requests = new List<(string Id, string? Cursor)>();
                        foreach (var node in parents)
                        {
                            if (node is not JsonObject parent)
                                throw new SessionListQueryException(
                                    "SESSION_LIST_CHILDREN_INVALID",
                                    "Invalid child request."
                                );
                            SessionListQueries.Keys(
                                parent.Select(pair => pair.Key),
                                "parentSessionId",
                                "cursor"
                            );
                            var id = SessionCatalog.Text(parent["parentSessionId"]);
                            if (id is null || id.Length is < 1 or > 512 || !seen.Add(id))
                                throw new SessionListQueryException(
                                    "SESSION_LIST_CHILDREN_INVALID",
                                    "Child parent IDs must be unique bounded strings."
                                );
                            if (
                                parent.ContainsKey("cursor")
                                && SessionCatalog.Text(parent["cursor"]) is null
                            )
                                throw new SessionListQueryException(
                                    "SESSION_LIST_CHILDREN_INVALID",
                                    "Child cursor must be a string."
                                );
                            requests.Add((id, SessionCatalog.Text(parent["cursor"])));
                        }
                        var view = new SessionListQueries(runtime);
                        var pages = view.ChildPages(requests.ToArray(), mode, limit, agent);
                        var reset = pages.Any(page => page["reset"]!.GetValue<bool>());
                        foreach (var page in pages)
                            page.Remove("reset");
                        return new JsonObject
                        {
                            ["version"] = 1,
                            ["revision"] = view.Revision,
                            ["reset"] = reset,
                            ["children"] = new JsonArray(
                                pages.Select(page => (JsonNode?)page).ToArray()
                            ),
                        };
                    }
                )
        );
        app.MapPost(
            "/api/session-list/group-pages",
            async (HttpRequest request) =>
                await ListBody(
                    request,
                    body =>
                    {
                        SessionListQueries.Keys(
                            body.Select(pair => pair.Key),
                            "group",
                            "mode",
                            "limit",
                            "childLimit",
                            "groups"
                        );
                        var grouping =
                            SessionListQueries.Grouping(BodyText(body, "group"))
                            ?? throw new SessionListQueryException(
                                "SESSION_LIST_GROUP_INVALID",
                                "group must be agent or node."
                            );
                        var mode = SessionListQueries.Mode(BodyText(body, "mode"));
                        var limit = BodyLimit(body, "limit", 10, 100);
                        var childLimit = BodyLimit(body, "childLimit", 5, 20);
                        if (body["groups"] is not JsonArray groups || groups.Count > 20)
                            throw new SessionListQueryException(
                                "SESSION_LIST_GROUPS_INVALID",
                                "groups accepts at most 20 requests."
                            );
                        var seen = new HashSet<string>(StringComparer.Ordinal);
                        var requests = new List<(string Key, string? Cursor)>();
                        foreach (var node in groups)
                        {
                            if (node is not JsonObject group)
                                throw new SessionListQueryException(
                                    "SESSION_LIST_GROUPS_INVALID",
                                    "Invalid group request."
                                );
                            SessionListQueries.Keys(
                                group.Select(pair => pair.Key),
                                "key",
                                "cursor"
                            );
                            var key = SessionCatalog.Text(group["key"]);
                            if (key is null || key.Length is < 1 or > 512 || !seen.Add(key))
                                throw new SessionListQueryException(
                                    "SESSION_LIST_GROUPS_INVALID",
                                    "Group keys must be unique bounded strings."
                                );
                            if (
                                group.ContainsKey("cursor")
                                && SessionCatalog.Text(group["cursor"]) is null
                            )
                                throw new SessionListQueryException(
                                    "SESSION_LIST_GROUPS_INVALID",
                                    "Group cursor must be a string."
                                );
                            requests.Add((key, SessionCatalog.Text(group["cursor"])));
                        }
                        var view = new SessionListQueries(runtime);
                        var result = view.GroupPages(requests.ToArray(), grouping, mode, limit);
                        // Tree-mode members carry the same child previews as Sidebar roots.
                        var previews =
                            mode == "flat-time"
                                ? []
                                : view.ChildPages(
                                    result["groups"]!
                                        .AsArray()
                                        .SelectMany(group => group!["sessions"]!.AsArray())
                                        .Select(row =>
                                            (row!["id"]!.GetValue<string>(), (string?)null)
                                        )
                                        .ToArray(),
                                    mode,
                                    childLimit,
                                    previews: true
                                );
                        foreach (var preview in previews)
                        {
                            preview.Remove("nextCursor");
                            preview.Remove("reset");
                        }
                        result["children"] = new JsonArray(
                            previews.Select(preview => (JsonNode?)preview).ToArray()
                        );
                        return result;
                    }
                )
        );
        app.MapPost(
            "/api/session-list/descendant-activity",
            async (HttpRequest request) =>
                await ListBody(
                    request,
                    body =>
                    {
                        SessionListQueries.Keys(body.Select(pair => pair.Key), "ids");
                        var ids = SessionListQueries.Ids(body["ids"]);
                        var view = new SessionListQueries(runtime);
                        var counts = view.DescendantActivity(ids);
                        return new JsonObject
                        {
                            ["version"] = 1,
                            ["revision"] = view.Revision,
                            ["results"] = new JsonArray(
                                ids.Select(id =>
                                        (JsonNode?)
                                            new JsonObject
                                            {
                                                ["sessionId"] = id,
                                                ["busy"] = counts.GetValueOrDefault(id),
                                            }
                                    )
                                    .ToArray()
                            ),
                        };
                    }
                )
        );
        app.MapGet(
            "/api/session-list/search",
            (HttpRequest request) =>
                ListResult(() =>
                {
                    SessionListQueries.Keys(request.Query.Keys, "q", "limit");
                    var query = SessionCatalog.Trim(Query(request.Query, "q") ?? "");
                    if (query.Length is < 1 or > 256)
                        throw new SessionListQueryException(
                            "SESSION_LIST_SEARCH_INVALID",
                            "q must contain 1 to 256 characters."
                        );
                    return new SessionListQueries(runtime).Search(
                        query,
                        SessionListQueries.Limit(Query(request.Query, "limit"), 50, 100)
                    );
                })
        );
        app.MapGet(
            "/api/session-list/architecture",
            (HttpRequest request) =>
                ListResult(() =>
                {
                    SessionListQueries.Keys(
                        request.Query.Keys,
                        "agent",
                        "limit",
                        "childLimit",
                        "cursor"
                    );
                    var view = new SessionListQueries(runtime);
                    var agent = Query(request.Query, "agent");
                    var roots = view.Page(
                        "time",
                        SessionListQueries.Limit(Query(request.Query, "limit"), 50, 100),
                        Query(request.Query, "cursor"),
                        true,
                        agent
                    );
                    var rootIds = (roots["sessions"] as JsonArray)!
                        .OfType<JsonObject>()
                        .Select(row => row["id"]!.GetValue<string>())
                        .ToArray();
                    var children = view.ChildPages(
                        rootIds.Select(id => (id, (string?)null)).ToArray(),
                        "time",
                        SessionListQueries.Limit(Query(request.Query, "childLimit"), 10, 20),
                        agent,
                        previews: true
                    );
                    foreach (var child in children)
                        child.Remove("reset");
                    return new JsonObject
                    {
                        ["version"] = 1,
                        ["revision"] = view.Revision,
                        ["summary"] = view.GlobalSummary(),
                        ["agentCounts"] = view.AgentCounts(),
                        ["agent"] = agent,
                        ["roots"] = roots,
                        ["children"] = new JsonArray(
                            children.Select(group => (JsonNode?)group).ToArray()
                        ),
                    };
                })
        );
        app.MapGet(
            "/api/session-list/descendants/{id}",
            (string id, HttpRequest request) =>
                ListResult(() =>
                {
                    SessionListQueries.Keys(request.Query.Keys, "limit");
                    var raw = request
                        .HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpRequestFeature>()
                        ?.RawTarget?.Split('?', 2)[0]
                        .Split('/')
                        .Last();
                    var canonical = Uri.UnescapeDataString(raw ?? id);
                    return new SessionListQueries(runtime).Descendants(
                        canonical,
                        SessionListQueries.Limit(Query(request.Query, "limit"), 20, 100)
                    );
                })
        );
    }

    private static string? Query(IQueryCollection query, string name)
    {
        if (!query.TryGetValue(name, out var values))
            return null;
        if (values.Count != 1)
            throw new SessionListQueryException(
                "SESSION_LIST_QUERY_INVALID",
                "Expected one query string."
            );
        return values[0];
    }

    // An absent value is null; a present value must be a string.
    private static string? BodyText(JsonObject body, string name) =>
        !body.ContainsKey(name) ? null
        : body[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text
        : throw new SessionListQueryException(
            "SESSION_LIST_DTO_INVALID",
            $"{name} must be a string."
        );

    // Node names and online state for Sidebar Node groups.
    private Dictionary<string, SessionGroupNode> GroupNodes()
    {
        var nodes = new Dictionary<string, SessionGroupNode>(StringComparer.Ordinal);
        foreach (var node in sessions.NodeSummaries().OfType<JsonObject>())
            if (SessionCatalog.Text(node["id"]) is { } id)
                nodes[id] = new(
                    SessionCatalog.Text(node["displayName"]) is { Length: > 0 } name ? name : id,
                    SessionCatalog.Flag(node["online"])
                );
        return nodes;
    }

    private static int BodyLimit(JsonObject body, string name, int fallback, int max) =>
        !body.ContainsKey(name) ? fallback
        : SessionCatalog.Number(body[name]) is { } number
        && Math.Truncate(number) == number
        && number > 0
        && number <= max
            ? (int)number
        : throw new SessionListQueryException("SESSION_LIST_LIMIT_INVALID", "Invalid limit.");

    private static IResult ListResult(Func<JsonObject> build)
    {
        try
        {
            return Results.Ok(build());
        }
        catch (SessionListQueryException error)
        {
            return Results.Json(
                new { error = error.Message, code = error.Code },
                statusCode: error.Code == "SESSION_NOT_FOUND" ? 404 : 400
            );
        }
        catch (Exception error)
            when (error
                    is System.Text.Json.JsonException
                        or InvalidOperationException
                        or FormatException
                && error is not WebUiAccessException
            )
        {
            return Results.BadRequest(
                new { error = "Invalid Session list request", code = "SESSION_LIST_DTO_INVALID" }
            );
        }
    }

    private static async Task<IResult> ListBody(
        HttpRequest request,
        Func<JsonObject, JsonObject> build
    )
    {
        try
        {
            var body = await JsonNode.ParseAsync(request.Body) as JsonObject;
            return body is null
                ? Results.BadRequest(
                    new { error = "Request must be an object", code = "SESSION_LIST_DTO_INVALID" }
                )
                : ListResult(() => build(body));
        }
        catch (System.Text.Json.JsonException)
        {
            return Results.BadRequest(
                new { error = "Invalid JSON", code = "SESSION_LIST_DTO_INVALID" }
            );
        }
    }
}
