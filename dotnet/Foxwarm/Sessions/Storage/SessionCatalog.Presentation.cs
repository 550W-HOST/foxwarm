using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed class SessionPresentationException(string message, string code, int status = 400) : InvalidOperationException(message)
{
    internal string Code { get; } = code;
    internal int Status { get; } = status;
}
internal sealed record PresentationChange(JsonObject Result, string[] ChangedIds);
internal sealed class PresentationCommittedException(PresentationChange change, Exception inner)
    : InvalidOperationException("The presentation change committed, but its notification failed.", inner)
{
    internal PresentationChange Change { get; } = change;
}

internal sealed partial class SessionCatalog
{
    private static readonly CompareInfo SidebarCollation = CultureInfo.GetCultureInfo("en-US").CompareInfo;
    internal static int CompareSidebar(JsonObject left, JsonObject right)
    {
        var compared = Flag(left["archived"]).CompareTo(Flag(right["archived"])); if (compared != 0) return compared;
        var a = Number(left["sidebarOrder"]); var b = Number(right["sidebarOrder"]);
        if (a is not null && b is not null && a != b) return a.Value.CompareTo(b.Value);
        if (a is not null && b is null) return -1; if (a is null && b is not null) return 1;
        compared = (Number(right["meta"]?["lastMessageTime"]) ?? 0).CompareTo(Number(left["meta"]?["lastMessageTime"]) ?? 0);
        return compared != 0 ? compared : SidebarCollation.Compare(Text(left["id"])!, Text(right["id"])!, CompareOptions.None);
    }
    private static string? TreeParent(JsonObject row) => Text(row["parentSessionId"]) is { } raw && Trim(raw).Length > 0 ? Trim(raw) : null;
    private JsonObject RequiredMain(string requested, string label = "sessionId")
    {
        var id = Text(Resolve(requested)["sessionId"]);
        return id is not null && Get(id) is { } row ? row : throw new SessionPresentationException($"{label} session \"{requested}\" was not found.", label == "sessionId" ? "SESSION_NOT_FOUND" : label.ToUpperInvariant() + "_NOT_FOUND", 404);
    }
    private string? OptionalMain(JsonNode? value, string label)
    {
        if (value is null) return null;
        if (Text(value) is not { } text) throw new SessionPresentationException($"{label} must be a string, null, or omitted.", "MOVE_SESSION_FAILED", 500);
        text = Trim(text); return text.Length == 0 ? null : Text(RequiredMain(text, label)["id"]);
    }
    private void ValidateParent(string child, string? parent)
    {
        if (parent is null) return;
        if (parent == child) throw new SessionPresentationException("A session cannot be assigned as a child of itself.", "SELF_PARENT_NOT_ALLOWED");
        var seen = new HashSet<string>(StringComparer.Ordinal) { child }; var cursor = parent;
        while (cursor is not null)
        {
            var canonical = Text(Resolve(cursor)["sessionId"]); if (canonical is null) break;
            if (!seen.Add(canonical)) throw new SessionPresentationException($"Session \"{child}\" cannot be moved under descendant \"{parent}\" because that would create a parent cycle.", "PARENT_CYCLE_NOT_ALLOWED");
            cursor = TreeParent(Get(canonical)!);
        }
    }
    private PresentationChange CommitPresentation(Func<(JsonObject Result, JsonObject[] Rows)> prepare)
    {
        PresentationChange result;
        lock (gate)
        {
            EnsureInitialized(); Execute(db!, "BEGIN IMMEDIATE");
            try
            {
                var operation = prepare(); WriteRowsLocked(operation.Rows);
                Execute(db!, "COMMIT"); if (operation.Rows.Length > 0) revision++;
                result = new(operation.Result, operation.Rows.Select(row => Text(row["id"])!).ToArray());
            }
            catch { Execute(db!, "ROLLBACK"); throw; }
        }
        if (result.ChangedIds.Length > 0)
            try { Changed?.Invoke(); } catch (Exception error) { throw new PresentationCommittedException(result, error); }
        return result;
    }
    internal PresentationChange Archive(string requested, bool archived, bool descendants = false, bool singleCommand = false)
        => CommitPresentation(() =>
        {
            var root = RequiredMain(requested); var ids = new List<string> { Text(root["id"])! };
            var recursive = archived && descendants;
            if (recursive) ids.AddRange(DescendantsLocked(ids[0]).Descendants);
            var changed = new List<JsonObject>(); var matched = new List<string>();
            foreach (var id in ids)
            {
                var row = Get(id); if (row is null) continue; matched.Add(id);
                if (Flag(row["archived"]) == archived && !singleCommand) continue;
                row["archived"] = archived; changed.Add(row);
            }
            return (new JsonObject { ["success"] = true, ["archived"] = archived, ["includeDescendants"] = recursive,
                ["matchedCount"] = matched.Count, ["changedCount"] = changed.Count, ["matchedSessionIds"] = IdArray(matched), ["changedSessionIds"] = IdArray(changed.Select(row => Text(row["id"])!)) }, changed.ToArray());
        });
    internal PresentationChange Pin(string requested, bool pinned) => CommitPresentation(() =>
    {
        var row = RequiredMain(requested); if (pinned) row["pinned"] = true; else row.Remove("pinned");
        return (new JsonObject { ["success"] = true, ["sessionId"] = Text(row["id"]), ["pinned"] = pinned }, new[] { row });
    });
    internal PresentationChange SetParent(string requested, string? parent) => CommitPresentation(() =>
    {
        var row = RequiredMain(requested); var id = Text(row["id"])!;
        var target = parent is null ? null : Text(RequiredMain(parent, "parentSessionId")["id"]); ValidateParent(id, target);
        var previous = Text(row["parentSessionId"]); if (previous?.Length == 0) previous = null;
        var result = new JsonObject { ["childSessionId"] = id, ["parentSessionId"] = target, ["previousParentSessionId"] = previous };
        if (previous == target) return (result, Array.Empty<JsonObject>());
        if (target is null) row.Remove("parentSessionId"); else row["parentSessionId"] = target;
        return (result, new[] { row });
    });
    private static JsonArray IdArray(IEnumerable<string> ids) => new(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());
    private JsonObject[] SiblingsLocked(string? parent, string exclude)
    {
        const string spaces = "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
        var rows = Rows($"SELECT {Columns} FROM session_catalog WHERE NULLIF(trim(parent_reference,$p0),'') IS $p1 AND session_id<>$p2 ORDER BY session_id", spaces, parent, exclude);
        // List.Sort is not stable for collation-equal strings. Source Array.sort is stable.
        return rows.Select((row, index) => (row, index)).OrderBy(pair => pair.row, Comparer<JsonObject>.Create(CompareSidebar)).ThenBy(pair => pair.index).Select(pair => pair.row).ToArray();
    }
    private static void Rank(IEnumerable<JsonObject> rows, Dictionary<string, JsonObject> changes)
    { var index = 0; foreach (var row in rows) { row["sidebarOrder"] = ++index * 1000; changes[Text(row["id"])!] = row; } }
    internal PresentationChange Move(string requested, JsonObject body, bool promote = false) => CommitPresentation(() =>
    {
        var moving = RequiredMain(requested); var id = Text(moving["id"])!; var previous = promote ? Text(moving["parentSessionId"]) : TreeParent(moving);
        if (previous?.Length == 0) previous = null;
        var changes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        string? before = null, after = null, position = null, target; var updateOrder = true; bool? targetBusy = null;
        if (promote)
        {
            target = Text(body["targetParentId"]) is { } raw && Trim(raw).Length > 0 ? Text(RequiredMain(Trim(raw), "targetParentId")["id"]) : null;
            if (target is not null) targetBusy = Flag(Get(target)!["busy"]);
        }
        else
        {
            before = OptionalMain(body["beforeSessionId"], "beforeSessionId"); after = OptionalMain(body["afterSessionId"], "afterSessionId");
            if (before is not null && after is not null) throw new SessionPresentationException("Specify either beforeSessionId or afterSessionId, not both.", "MULTIPLE_MOVE_ANCHORS");
            updateOrder = !(body["updateOrder"] is JsonValue flag && flag.TryGetValue<bool>(out var enabled) && !enabled);
            if (body["position"] is not null && Text(body["position"]) != "")
            {
                position = Text(body["position"]);
                if (position is not ("first" or "last")) throw new SessionPresentationException("position must be either \"first\" or \"last\" when provided.", "INVALID_MOVE_POSITION");
            }
            if (position is not null && (before is not null || after is not null)) throw new SessionPresentationException("position cannot be combined with beforeSessionId or afterSessionId.", "POSITION_WITH_ANCHOR_NOT_ALLOWED");
            if (!updateOrder && (position is not null || before is not null || after is not null)) throw new SessionPresentationException("updateOrder=false can only be used for parent-only moves.", "ORDER_ANCHOR_WITH_UPDATE_ORDER_DISABLED");
            var anchor = before ?? after;
            if (anchor == id) throw new SessionPresentationException("A session cannot be reordered relative to itself.", "SELF_ANCHOR_NOT_ALLOWED");
            var anchorParent = anchor is null ? null : TreeParent(Get(anchor)!);
            target = body.ContainsKey("parentSessionId") ? OptionalMain(body["parentSessionId"], "parentSessionId") : anchor is null ? previous : anchorParent;
            if (anchor is not null && anchorParent != target) throw new SessionPresentationException("Move anchor is not in the requested target parent group.", "ANCHOR_PARENT_MISMATCH");
        }
        ValidateParent(id, target);
        if (promote || previous != target)
        {
            var writtenParent = target is null ? null : Text(Resolve(target)["sessionId"]);
            if (target is not null && writtenParent is null) throw new SessionPresentationException($"Session \"{target}\" not found.", "MOVE_SESSION_FAILED", 500);
            if (Text(moving["parentSessionId"]) != writtenParent)
            { if (writtenParent is null) moving.Remove("parentSessionId"); else moving["parentSessionId"] = writtenParent; changes[id] = moving; }
        }
        if (updateOrder)
        {
            if (previous != target) Rank(SiblingsLocked(previous, id), changes);
            var siblings = SiblingsLocked(target, id).ToList(); var insert = position == "last" ? siblings.Count : 0;
            if (before is not null || after is not null)
            {
                var anchor = before ?? after; var found = siblings.FindIndex(row => Text(row["id"]) == anchor);
                if (found < 0) throw new SessionPresentationException("Move anchor is not a sibling in the target group.", before is not null ? "BEFORE_ANCHOR_NOT_IN_TARGET_GROUP" : "AFTER_ANCHOR_NOT_IN_TARGET_GROUP");
                insert = found + (after is null ? 0 : 1);
            }
            if (promote && previous is not null) { var found = siblings.FindIndex(row => Text(row["id"]) == previous); insert = found >= 0 ? found + 1 : 0; }
            siblings.Insert(insert, moving); Rank(siblings, changes);
        }
        var response = new JsonObject { ["success"] = true, ["sessionId"] = id, ["parentSessionId"] = TreeParent(moving), ["previousParentSessionId"] = previous,
            ["beforeSessionId"] = before, ["afterSessionId"] = after, ["sidebarOrder"] = Number(moving["sidebarOrder"]) is { } order && order != 0 ? order : null };
        if (promote) { response.Remove("beforeSessionId"); response.Remove("afterSessionId"); response["operation"] = target is null ? "promote-to-root" : "move-up"; response["targetParentId"] = target; response["sessionBusy"] = Flag(moving["busy"]); if (targetBusy is not null) response["targetParentBusy"] = targetBusy; }
        return (response, changes.Values.ToArray());
    });
    private (string[] Descendants, string[] Direct, string[] PostOrder) DescendantsLocked(string root)
    {
        var rows = Rows($"SELECT {Columns} FROM session_catalog ORDER BY session_id"); var children = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            if (Text(row["parentSessionId"]) is not { Length: > 0 } reference) continue;
            var parent = Text(Resolve(reference)["sessionId"]); if (parent is null) continue;
            if (!children.TryGetValue(parent, out var group)) children[parent] = group = [];
            group.Add(Text(row["id"])!);
        }
        foreach (var group in children.Values) { var sorted = group.OrderBy(id => id, Comparer<string>.Create((a, b) => SidebarCollation.Compare(a, b, CompareOptions.None))).ToArray(); group.Clear(); group.AddRange(sorted); }
        var visited = new HashSet<string>(StringComparer.Ordinal); var visiting = new HashSet<string>(StringComparer.Ordinal);
        var descendants = new List<string>(); var post = new List<string>();
        void Visit(string id, bool include)
        {
            if (!visiting.Add(id)) throw new SessionPresentationException($"Session relation cycle detected while traversing descendants of \"{root}\".", "SESSION_RELATION_CYCLE", 409);
            if (visited.Contains(id)) { visiting.Remove(id); return; }
            if (include) descendants.Add(id);
            foreach (var child in children.GetValueOrDefault(id) ?? []) Visit(child, true);
            visiting.Remove(id); visited.Add(id); post.Add(id);
        }
        Visit(root, false); return (descendants.ToArray(), (children.GetValueOrDefault(root) ?? []).ToArray(), post.ToArray());
    }
}
