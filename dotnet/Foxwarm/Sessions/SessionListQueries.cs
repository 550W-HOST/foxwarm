using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class SessionListQueryException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>Source-mapped webuiSessionListQueries: keyset/epoch queries over Main-local metadata, not active history.</summary>
internal sealed class SessionListQueries
{
    private readonly SessionRuntime runtime;
    private readonly Dictionary<string, SessionMetadata> rows;
    public string Revision { get; }
    public SessionListQueries(SessionRuntime runtime)
    {
        this.runtime = runtime;
        rows = runtime.ListMetadata().ToDictionary(row => row.Id, StringComparer.Ordinal);
        var signature = string.Join('\n', rows.Values.OrderBy(row => row.Id, StringComparer.Ordinal)
            .Select(row => $"{row.Id}\0{row.ParentSessionId}\0{row.Agent}\0{row.LastMessageTime}\0{row.Archived}\0{row.Pinned}\0{row.SidebarOrder}\0{row.DisplayName}"));
        Revision = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature)))[..24];
    }
    public static string Mode(string? value) => value is null or "default" ? "default"
        : value is "time" or "flat-time" ? value
        : throw new SessionListQueryException("SESSION_LIST_MODE_INVALID", "mode must be default, time, or flat-time.");
    public static int Limit(string? value, int fallback, int max)
    {
        if (value is null) return fallback;
        if (!System.Text.RegularExpressions.Regex.IsMatch(value, "^[1-9][0-9]*$")
            || !int.TryParse(value, out var number) || number > max)
            throw new SessionListQueryException("SESSION_LIST_LIMIT_INVALID", $"limit must be between 1 and {max}.");
        return number;
    }
    public static void Keys(IEnumerable<string> actual, params string[] allowed)
    {
        if (actual.Any(key => !allowed.Contains(key, StringComparer.Ordinal)))
            throw new SessionListQueryException("SESSION_LIST_DTO_INVALID", "Request has an invalid shape.");
    }
    public static string[] Ids(JsonNode? value, int max = 100)
    {
        if (value is not JsonArray array || array.Count > max
            || array.Any(node => node is not JsonValue scalar || !scalar.TryGetValue<string>(out var id) || id.Length is < 1 or > 512))
            throw new SessionListQueryException("SESSION_LIST_IDS_INVALID", $"ids must contain at most {max} bounded Session IDs.");
        return array.Select(node => node!.GetValue<string>()).ToArray();
    }
    public JsonObject? Projection(string id)
    {
        if (!rows.TryGetValue(id, out var meta) || runtime.Owner(id) is not { } owner) return null;
        var result = owner.BuildDto(meta);
        result["childTotal"] = rows.Values.Count(row => row.ParentSessionId == id && !row.Pinned);
        return result;
    }
    private JsonArray Project(IEnumerable<SessionMetadata> selected) => new(selected.Select(row => (JsonNode?)Projection(row.Id)).ToArray());
    private static JsonArray Key(SessionMetadata row, string mode, bool child = false)
    {
        var key = new JsonArray();
        if (!child) key.Add(row.Pinned ? 0 : 1);
        key.Add(row.Archived ? 1 : 0);
        if (mode == "default") { key.Add(row.SidebarOrder is null ? 1 : 0); key.Add(row.SidebarOrder ?? 0); }
        key.Add(-row.LastMessageTime); key.Add(row.Id);
        return key;
    }
    private static int Compare(JsonArray left, JsonArray right)
    {
        for (var index = 0; index < left.Count; index++)
        {
            int result;
            if (index == left.Count - 1)
                result = Encoding.UTF8.GetBytes(left[index]!.GetValue<string>()).AsSpan()
                    .SequenceCompareTo(Encoding.UTF8.GetBytes(right[index]!.GetValue<string>()));
            else result = double.Parse(left[index]!.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture).CompareTo(double.Parse(right[index]!.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture));
            if (result != 0) return result;
        }
        return 0;
    }
    private static string Encode(JsonObject value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value.ToJsonString()))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static JsonObject? Decode(string? raw, string mode, string scope, bool child)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        try
        {
            if (raw.Length > 4096) throw new FormatException();
            var text = raw.Replace('-', '+').Replace('_', '/'); text = text.PadRight((text.Length + 3) / 4 * 4, '=');
            var node = JsonNode.Parse(Convert.FromBase64String(text)) as JsonObject;
            var length = mode == "default" ? child ? 5 : 6 : child ? 3 : 4;
            if (node?["v"]?.GetValue<int>() != 1 || node["kind"]?.GetValue<string>() != "page"
                || node["mode"]?.GetValue<string>() != mode || node["scope"]?.GetValue<string>() != scope
                || node["revision"] is not JsonValue revision || !revision.TryGetValue<string>(out var identity) || identity.Length > 200
                || node["key"] is not JsonArray key || key.Count != length
                || key.Take(length - 1).Any(item => item is not JsonValue part || !part.TryGetValue<double>(out var number) || !double.IsFinite(number))
                || key.Last() is not JsonValue id || !id.TryGetValue<string>(out var lastId) || lastId.Length > 512)
                throw new FormatException();
            return node;
        }
        catch (Exception error) when (error is FormatException or System.Text.Json.JsonException or InvalidOperationException)
        { throw new SessionListQueryException("SESSION_LIST_CURSOR_INVALID", "Cursor does not match this mode and scope."); }
    }
    private string Cursor(SessionMetadata last, string mode, string scope, bool child) => Encode(new JsonObject
    {
        ["v"] = 1,
        ["kind"] = "page",
        ["mode"] = mode,
        ["scope"] = scope,
        ["revision"] = Revision,
        ["key"] = Key(last, mode, child)
    });
    public JsonObject Page(string mode, int limit, string? cursor = null, bool roots = true, string? agent = null)
    {
        var scope = agent is not null ? $"agent:{agent}:{(roots ? "roots" : "all")}" : roots && mode != "flat-time" ? "roots" : "flat";
        var decoded = Decode(cursor, mode, scope, false);
        var reset = decoded is not null && decoded["revision"]!.GetValue<string>() != Revision;
        var after = reset ? null : decoded?["key"] as JsonArray;
        var ordered = rows.Values.Where(row => (agent is null || row.Agent == agent)
                && (!roots || mode == "flat-time" || (agent is null ? row.Pinned || row.ParentSessionId is null
                    : row.ParentSessionId is null || !rows.TryGetValue(row.ParentSessionId, out var parent) || parent.Agent != agent)))
            .Where(row => after is null || Compare(Key(row, mode), after) > 0)
            .OrderBy(row => Key(row, mode), Comparer<JsonArray>.Create(Compare)).Take(limit + 1).ToArray();
        var selected = ordered.Take(limit).ToArray();
        return new JsonObject
        {
            ["version"] = 1,
            ["revision"] = Revision,
            ["mode"] = mode,
            ["scope"] = scope,
            ["sessions"] = Project(selected),
            ["reset"] = reset,
            ["nextCursor"] = ordered.Length > limit && selected.Length > 0 ? Cursor(selected[^1], mode, scope, false) : null
        };
    }
    public JsonObject ChildPage(string parent, string mode, int limit, string? cursor = null, string? agent = null, bool ignoreCursor = false)
    {
        var scope = $"children:{parent}:agent:{agent ?? "*"}";
        var decoded = Decode(cursor, mode, scope, true);
        var reset = decoded is not null && decoded["revision"]!.GetValue<string>() != Revision;
        var after = ignoreCursor || reset ? null : decoded?["key"] as JsonArray;
        var all = rows.Values.Where(row => row.ParentSessionId == parent && (agent is null ? !row.Pinned : row.Agent == agent)).ToArray();
        var ordered = all.Where(row => after is null || Compare(Key(row, mode, true), after) > 0)
            .OrderBy(row => Key(row, mode, true), Comparer<JsonArray>.Create(Compare)).Take(limit + 1).ToArray();
        var selected = ordered.Take(limit).ToArray();
        return new JsonObject
        {
            ["parentSessionId"] = parent,
            ["sessions"] = Project(selected),
            ["total"] = all.Length,
            ["nextCursor"] = ordered.Length > limit && selected.Length > 0 ? Cursor(selected[^1], mode, scope, true) : null,
            ["reset"] = reset
        };
    }
    public JsonArray Path(string id)
    {
        var path = new List<string>(); var visited = new HashSet<string>(StringComparer.Ordinal);
        while (rows.TryGetValue(id, out var row) && visited.Add(id))
        {
            path.Insert(0, id);
            if (row.ParentSessionId is not { } parent) break;
            id = parent;
        }
        return new JsonArray(path.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
    }
    public JsonObject Exact(string[] ids, bool includePaths)
    {
        var results = new JsonArray(); var paths = new JsonObject();
        foreach (var id in ids)
        {
            var found = rows.ContainsKey(id);
            results.Add(new JsonObject
            {
                ["requestedId"] = id,
                ["resolution"] = found ? new JsonObject { ["kind"] = "exact", ["sessionId"] = id } : new JsonObject { ["kind"] = "missing" },
                ["session"] = Projection(id)
            });
            if (found && includePaths) paths[id] = Path(id);
        }
        var result = new JsonObject { ["version"] = 1, ["revision"] = Revision, ["results"] = results };
        if (includePaths) result["paths"] = paths;
        return result;
    }
    public SessionMetadata[] DescendantRows(string id)
    {
        var found = new List<SessionMetadata>(); var pending = new Queue<string>(); var visited = new HashSet<string>(StringComparer.Ordinal) { id };
        pending.Enqueue(id);
        while (pending.TryDequeue(out var parent)) foreach (var child in rows.Values.Where(row => row.ParentSessionId == parent))
            if (visited.Add(child.Id)) { found.Add(child); pending.Enqueue(child.Id); }
        return found.ToArray();
    }
    public JsonObject Search(string query, int limit)
    {
        var term = query.ToLowerInvariant();
        var matches = rows.Values.Where(row => Projection(row.Id) is { } dto && new[] {
                "displayName", "id", "agent", "currentNode", "cwd", "model", "modelKey", "defaultModelKey", "childModelDefault", "effectiveChildModelKey" }
            .Any(field => dto[field] is JsonValue value && value.TryGetValue<string>(out var text)
                && !string.IsNullOrWhiteSpace(text) && text.ToLowerInvariant().Contains(term, StringComparison.Ordinal))).ToArray();
        return new JsonObject
        {
            ["version"] = 1,
            ["query"] = query,
            ["sessions"] = Project(matches.Take(limit)),
            ["hasMore"] = matches.Length > limit,
            ["candidateCount"] = rows.Count
        };
    }
    public JsonObject Summary(IEnumerable<SessionMetadata> values)
    {
        var entries = values.ToArray();
        return new JsonObject
        {
            ["total"] = entries.Length,
            ["busy"] = entries.Count(row => row.Busy),
            ["queued"] = entries.Count(row => row.QueueLength > 0),
            ["cachedTokens"] = entries.Sum(row => row.CachedTokens),
            ["inputTokens"] = entries.Sum(row => row.InputTokens),
            ["outputTokens"] = entries.Sum(row => row.OutputTokens)
        };
    }
    public JsonObject GlobalSummary()
    {
        var summary = Summary(rows.Values);
        summary["managed"] = 0; // Managed states are rejected when loading this host's supported authorities.
        return summary;
    }
    public JsonArray AgentCounts() => new(rows.Values.GroupBy(row => row.Agent).OrderBy(group => group.Key, StringComparer.Ordinal)
        .Select(group => (JsonNode?)new JsonObject { ["agent"] = group.Key, ["count"] = group.Count() }).ToArray());
}
