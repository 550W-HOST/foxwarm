using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class SessionListQueryException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

// Fixed source list queries over the Main-owned catalog and incremental local projections.
internal sealed partial class SessionListQueries
{
    private readonly SessionRuntime runtime;
    private SessionCatalog Catalog => runtime.Catalog;
    public string Revision => runtime.PresentationRevision;

    public SessionListQueries(SessionRuntime runtime) => this.runtime = runtime;

    public static string Mode(string? value) =>
        value is null or "default" ? "default"
        : value is "time" or "flat-time" ? value
        : throw new SessionListQueryException(
            "SESSION_LIST_MODE_INVALID",
            "mode must be default, time, or flat-time."
        );

    public static int Limit(string? value, int fallback, int max)
    {
        if (value is null)
            return fallback;
        if (
            !System.Text.RegularExpressions.Regex.IsMatch(value, "^[1-9][0-9]*$")
            || !int.TryParse(value, out var number)
            || number > max
        )
            throw new SessionListQueryException(
                "SESSION_LIST_LIMIT_INVALID",
                $"limit must be between 1 and {max}."
            );
        return number;
    }

    public static void Keys(IEnumerable<string> actual, params string[] allowed)
    {
        if (actual.Any(key => !allowed.Contains(key, StringComparer.Ordinal)))
            throw new SessionListQueryException(
                "SESSION_LIST_DTO_INVALID",
                "Request has an invalid shape."
            );
    }

    public static string[] Ids(JsonNode? value, int max = 100)
    {
        if (
            value is not JsonArray array
            || array.Count > max
            || array.Any(node =>
                node is not JsonValue scalar
                || !scalar.TryGetValue<string>(out var id)
                || id.Length is < 1 or > 512
            )
        )
            throw new SessionListQueryException(
                "SESSION_LIST_IDS_INVALID",
                $"ids must contain at most {max} bounded Session IDs."
            );
        return array.Select(node => node!.GetValue<string>()).ToArray();
    }

    public JsonObject? Projection(string id) => runtime.Projection(id);

    internal JsonArray ProjectionRows(string[] ids) => Array(runtime.Projections(ids));

    private static JsonArray Array(IEnumerable<JsonObject> rows) =>
        new(rows.Select(row => (JsonNode?)row).ToArray());

    private static string Id(JsonObject row) => SessionCatalog.Text(row["id"])!;

    private static JsonArray Key(JsonObject row, string mode, bool child = false)
    {
        var key = new JsonArray();
        if (!child)
            key.Add(SessionCatalog.Flag(row["pinned"]) ? 0 : 1);
        key.Add(SessionCatalog.Flag(row["archived"]) ? 1 : 0);
        if (mode == "default")
        {
            key.Add(SessionCatalog.Number(row["sidebarOrder"]) is null ? 1 : 0);
            key.Add(SessionCatalog.Number(row["sidebarOrder"]) ?? 0);
        }
        key.Add(-(SessionCatalog.Number(row["lastMessageTime"]) ?? 0));
        key.Add(Id(row));
        return key;
    }

    private bool InScope(JsonObject row, string mode, bool roots, string? agent, JsonObject? scope)
    {
        if (agent is not null && SessionCatalog.Text(row["agent"]) != agent)
            return false;
        if (!roots || mode == "flat-time")
            return true;
        return agent is null
            ? SessionCatalog.Flag(row["pinned"]) || row["parentSessionId"] is null
            : row["parentSessionId"] is null || SessionCatalog.Text(scope?["parentAgent"]) != agent;
    }

    internal static int CompareIds(string left, string right) =>
        Encoding.UTF8.GetBytes(left).AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(right));

    private static int Compare(JsonArray left, JsonArray right)
    {
        for (var index = 0; index < left.Count; index++)
        {
            int result;
            if (index == left.Count - 1)
                result = Encoding
                    .UTF8.GetBytes(left[index]!.GetValue<string>())
                    .AsSpan()
                    .SequenceCompareTo(Encoding.UTF8.GetBytes(right[index]!.GetValue<string>()));
            else
                result = double.Parse(
                        left[index]!.ToJsonString(),
                        System.Globalization.CultureInfo.InvariantCulture
                    )
                    .CompareTo(
                        double.Parse(
                            right[index]!.ToJsonString(),
                            System.Globalization.CultureInfo.InvariantCulture
                        )
                    );
            if (result != 0)
                return result;
        }
        return 0;
    }

    private static string Encode(JsonObject value) =>
        Convert
            .ToBase64String(Encoding.UTF8.GetBytes(value.ToJsonString()))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private static JsonObject? Decode(string? raw, string mode, string scope, bool child)
    {
        if (string.IsNullOrEmpty(raw))
            return null;
        try
        {
            if (raw.Length > 4096)
                throw new FormatException();
            var text = raw.Replace('-', '+').Replace('_', '/');
            text = text.PadRight((text.Length + 3) / 4 * 4, '=');
            var node = JsonNode.Parse(Convert.FromBase64String(text)) as JsonObject;
            var length =
                mode == "default"
                    ? child
                        ? 5
                        : 6
                    : child
                        ? 3
                        : 4;
            if (
                node?["v"]?.GetValue<int>() != 1
                || node["kind"]?.GetValue<string>() != "page"
                || node["mode"]?.GetValue<string>() != mode
                || node["scope"]?.GetValue<string>() != scope
                || node["revision"] is not JsonValue revision
                || !revision.TryGetValue<string>(out var identity)
                || identity.Length > 200
                || node["key"] is not JsonArray key
                || key.Count != length
                || key.Take(length - 1)
                    .Any(item =>
                        item is not JsonValue part
                        || !part.TryGetValue<double>(out var number)
                        || !double.IsFinite(number)
                    )
                || key.Last() is not JsonValue id
                || !id.TryGetValue<string>(out var lastId)
                || lastId.Length > 512
            )
                throw new FormatException();
            return node;
        }
        catch (Exception error)
            when (error
                    is FormatException
                        or System.Text.Json.JsonException
                        or InvalidOperationException
            )
        {
            throw new SessionListQueryException(
                "SESSION_LIST_CURSOR_INVALID",
                "Cursor does not match this mode and scope."
            );
        }
    }

    private string Cursor(JsonObject last, string mode, string scope, bool child) =>
        Encode(
            new JsonObject
            {
                ["v"] = 1,
                ["kind"] = "page",
                ["mode"] = mode,
                ["scope"] = scope,
                ["revision"] = Revision,
                ["key"] = Key(last, mode, child),
            }
        );

    public JsonObject Page(
        string mode,
        int limit,
        string? cursor = null,
        bool roots = true,
        string? agent = null
    )
    {
        var scope =
            agent is not null ? $"agent:{agent}:{(roots ? "roots" : "all")}"
            : roots && mode != "flat-time" ? "roots"
            : "flat";
        var decoded = Decode(cursor, mode, scope, false);
        (CatalogPage Page, JsonObject[] Candidates) Read(JsonArray? after)
        {
            var page = Catalog.Page(mode, limit, after, roots, agent);
            var candidates = runtime.Projections(page.Rows.Select(Id).ToArray(), true);
            var scopes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            foreach (var chunk in candidates.Select(Id).Chunk(200))
            foreach (var pair in Catalog.Scopes(chunk))
                scopes[pair.Key] = pair.Value;
            var ordered = candidates
                .Where(row => InScope(row, mode, roots, agent, scopes.GetValueOrDefault(Id(row))))
                .Where(row => after is null || Compare(Key(row, mode), after) > 0)
                .OrderBy(row => Key(row, mode), Comparer<JsonArray>.Create(Compare))
                .ToArray();
            return (page, ordered);
        }
        var result = Read(decoded?["key"] as JsonArray);
        var reset = decoded is not null && SessionCatalog.Text(decoded["revision"]) != Revision;
        if (reset)
            result = Read(null);
        var selected = result.Candidates.Take(limit).ToArray();
        return new JsonObject
        {
            ["version"] = 1,
            ["revision"] = Revision,
            ["mode"] = mode,
            ["scope"] = scope,
            ["sessions"] = Array(selected),
            ["reset"] = reset,
            ["nextCursor"] =
                (result.Page.HasMore || result.Candidates.Length > limit) && selected.Length > 0
                    ? Cursor(selected[^1], mode, scope, false)
                    : null,
        };
    }

    public JsonObject[] ChildPages(
        (string Id, string? Cursor)[] requests,
        string mode,
        int limit,
        string? agent = null,
        bool previews = false
    )
    {
        requests = requests
            .GroupBy(request => request.Id, StringComparer.Ordinal)
            .Select(group => group.Last())
            .ToArray();
        string Scope(string parent) => $"children:{parent}:agent:{agent ?? "*"}";
        var decoded = requests
            .Select(request => Decode(request.Cursor, mode, Scope(request.Id), true))
            .ToArray();
        var reset = decoded.Any(cursor =>
            cursor is not null && SessionCatalog.Text(cursor["revision"]) != Revision
        );
        var baseRows = Catalog.Children(
            requests
                .Select(
                    (request, index) =>
                        (request.Id, reset ? null : decoded[index]?["key"] as JsonArray)
                )
                .ToArray(),
            mode,
            limit,
            agent
        );
        var candidates = runtime.Projections(
            baseRows
                .SelectMany(group => group.Rows.Select(Id))
                .Distinct(StringComparer.Ordinal)
                .ToArray(),
            true
        );
        return baseRows
            .Select(
                (group, index) =>
                {
                    var after = reset ? null : decoded[index]?["key"] as JsonArray;
                    var all = candidates
                        .Where(row =>
                            SessionCatalog.Text(row["parentSessionId"]) == group.Parent
                            && (
                                agent is null
                                    ? !SessionCatalog.Flag(row["pinned"])
                                    : SessionCatalog.Text(row["agent"]) == agent
                            )
                        )
                        .Where(row => after is null || Compare(Key(row, mode, true), after) > 0)
                        .OrderBy(row => Key(row, mode, true), Comparer<JsonArray>.Create(Compare))
                        .ToArray();
                    var selected = all.Take(limit).ToArray();
                    var total = previews ? Math.Max(group.Total, selected.Length) : group.Total;
                    return new JsonObject
                    {
                        ["parentSessionId"] = group.Parent,
                        ["sessions"] = Array(selected),
                        ["total"] = total,
                        ["reset"] = reset,
                        ["nextCursor"] =
                            (
                                previews
                                    ? total > selected.Length
                                    : group.HasMore || all.Length > limit
                            )
                            && selected.Length > 0
                                ? Cursor(selected[^1], mode, Scope(group.Parent), true)
                                : null,
                    };
                }
            )
            .ToArray();
    }

    public JsonArray Path(string id) =>
        new(
            Catalog
                .Paths([id])
                .GetValueOrDefault(id, [])
                .Select(value => (JsonNode?)JsonValue.Create(value))
                .ToArray()
        );

    public JsonObject Exact(string[] ids, bool includePaths)
    {
        var resolved = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in ids.Distinct(StringComparer.Ordinal).Chunk(200))
        foreach (var pair in Catalog.ResolveMany(chunk))
            resolved[pair.Key] = pair.Value;
        var canonical = resolved
            .Values.Select(row => SessionCatalog.Text(row["sessionId"]))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var projected = runtime.Projections(canonical).ToDictionary(Id, StringComparer.Ordinal);
        var paths = new Dictionary<string, string[]>(StringComparer.Ordinal);
        if (includePaths)
            foreach (var chunk in canonical.Chunk(100))
            foreach (var pair in Catalog.Paths(chunk))
                paths[pair.Key] = pair.Value;
        var results = new JsonArray();
        var pathJson = new JsonObject();
        foreach (var requested in ids)
        {
            var resolution = resolved[requested];
            var id = SessionCatalog.Text(resolution["sessionId"]);
            results.Add(
                new JsonObject
                {
                    ["requestedId"] = requested,
                    ["resolution"] = resolution.DeepClone(),
                    ["session"] = id is not null
                        ? projected.GetValueOrDefault(id)?.DeepClone()
                        : null,
                }
            );
            if (includePaths && id is not null)
                pathJson[requested] = new JsonArray(
                    paths
                        .GetValueOrDefault(id, [])
                        .Select(value => (JsonNode?)JsonValue.Create(value))
                        .ToArray()
                );
        }
        var result = new JsonObject
        {
            ["version"] = 1,
            ["revision"] = Revision,
            ["results"] = results,
        };
        if (includePaths)
            result["paths"] = pathJson;
        return result;
    }
}
