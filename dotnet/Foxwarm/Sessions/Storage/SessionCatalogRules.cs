using System.Globalization;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Row access the shared catalog rules run over. An implementation answers from the catalog's
/// current transaction, so a rule sees the rows its own mutation is about to change.
/// </summary>
internal interface ICatalogRowView
{
    JsonObject? Get(string id);

    JsonObject Resolve(string requested);

    JsonObject[] IdentityChildren(string id);

    /// <summary>
    /// Every row in Session ID byte order, each with its parent reference resolved the way
    /// <see cref="Resolve"/> does: the exact Session, else a unique alias owner, else null.
    /// </summary>
    IReadOnlyList<(JsonObject Row, string? Parent)> ResolvedRows();

    /// <summary>
    /// Rows other than <paramref name="exclude"/> whose trimmed parent reference is
    /// <paramref name="parent"/> (no reference when null), in Session ID byte order.
    /// </summary>
    IReadOnlyList<JsonObject> SiblingRows(string? parent, string exclude);
}

/// <summary>
/// The catalog's presentation, deletion-selection and identity rules, shared by every
/// <see cref="ISessionCatalogStore"/>. Each rule reads through an <see cref="ICatalogRowView"/>
/// and returns the rows to write; the store writes them in its own transaction.
/// </summary>
internal static class SessionCatalogRules
{
    // Whitespace the source trims from parent references, as one character set.
    internal const string Spaces =
        "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

    private static string? Text(JsonNode? node) => SessionCatalog.Text(node);

    private static bool Flag(JsonNode? node) => SessionCatalog.Flag(node);

    private static readonly Comparer<string> IdCollation = Comparer<string>.Create(
        (a, b) => SessionCatalog.SidebarCollation.Compare(a, b, CompareOptions.None)
    );

    internal static string? TreeParent(JsonObject row) =>
        Text(row["parentSessionId"]) is { } raw && SessionCatalog.Trim(raw).Length > 0
            ? SessionCatalog.Trim(raw)
            : null;

    internal static JsonObject RequiredMain(
        ICatalogRowView view,
        string requested,
        string label = "sessionId"
    )
    {
        var id = Text(view.Resolve(requested)["sessionId"]);
        return id is not null && view.Get(id) is { } row
            ? row
            : throw new SessionPresentationException(
                $"{label} session \"{requested}\" was not found.",
                label == "sessionId"
                    ? "SESSION_NOT_FOUND"
                    : label.ToUpperInvariant() + "_NOT_FOUND",
                404
            );
    }

    private static string? OptionalMain(ICatalogRowView view, JsonNode? value, string label)
    {
        if (value is null)
            return null;
        if (Text(value) is not { } text)
            throw new SessionPresentationException(
                $"{label} must be a string, null, or omitted.",
                "MOVE_SESSION_FAILED",
                500
            );
        text = SessionCatalog.Trim(text);
        return text.Length == 0 ? null : Text(RequiredMain(view, text, label)["id"]);
    }

    internal static void ValidateParent(ICatalogRowView view, string child, string? parent)
    {
        if (parent is null)
            return;
        if (parent == child)
            throw new SessionPresentationException(
                "A session cannot be assigned as a child of itself.",
                "SELF_PARENT_NOT_ALLOWED"
            );
        var seen = new HashSet<string>(StringComparer.Ordinal) { child };
        var cursor = parent;
        while (cursor is not null)
        {
            var canonical = Text(view.Resolve(cursor)["sessionId"]);
            if (canonical is null)
                break;
            if (!seen.Add(canonical))
                throw new SessionPresentationException(
                    $"Session \"{child}\" cannot be moved under descendant \"{parent}\" because that would create a parent cycle.",
                    "PARENT_CYCLE_NOT_ALLOWED"
                );
            cursor = TreeParent(view.Get(canonical)!);
        }
    }

    internal static (JsonObject Result, JsonObject[] Rows) SetLastChannel(
        ICatalogRowView view,
        string id,
        JsonObject channel
    )
    {
        var row = RequiredMain(view, id);
        var meta = row["meta"] as JsonObject ?? new JsonObject();
        meta["lastChannel"] = channel.DeepClone();
        row["meta"] = meta;
        return (new JsonObject { ["success"] = true }, new[] { row });
    }

    internal static (JsonObject Result, JsonObject[] Rows) Archive(
        ICatalogRowView view,
        string requested,
        bool archived,
        bool descendants,
        bool singleCommand
    )
    {
        var root = RequiredMain(view, requested);
        var ids = new List<string> { Text(root["id"])! };
        var recursive = archived && descendants;
        if (recursive)
            ids.AddRange(Descendants(view, ids[0]).Descendants);
        var changed = new List<JsonObject>();
        var matched = new List<string>();
        foreach (var id in ids)
        {
            var row = view.Get(id);
            if (row is null)
                continue;
            matched.Add(id);
            if (Flag(row["archived"]) == archived && !singleCommand)
                continue;
            row["archived"] = archived;
            changed.Add(row);
        }
        return (
            new JsonObject
            {
                ["success"] = true,
                ["archived"] = archived,
                ["includeDescendants"] = recursive,
                ["matchedCount"] = matched.Count,
                ["changedCount"] = changed.Count,
                ["matchedSessionIds"] = IdArray(matched),
                ["changedSessionIds"] = IdArray(changed.Select(row => Text(row["id"])!)),
            },
            changed.ToArray()
        );
    }

    internal static (JsonObject Result, JsonObject[] Rows) Pin(
        ICatalogRowView view,
        string requested,
        bool pinned
    )
    {
        var row = RequiredMain(view, requested);
        if (pinned)
            row["pinned"] = true;
        else
            row.Remove("pinned");
        return (
            new JsonObject
            {
                ["success"] = true,
                ["sessionId"] = Text(row["id"]),
                ["pinned"] = pinned,
            },
            new[] { row }
        );
    }

    internal static (JsonObject Result, JsonObject[] Rows) SetParent(
        ICatalogRowView view,
        string requested,
        string? parent
    )
    {
        var row = RequiredMain(view, requested);
        var id = Text(row["id"])!;
        var target = parent is null
            ? null
            : Text(RequiredMain(view, parent, "parentSessionId")["id"]);
        ValidateParent(view, id, target);
        var previous = Text(row["parentSessionId"]);
        if (previous?.Length == 0)
            previous = null;
        var result = new JsonObject
        {
            ["childSessionId"] = id,
            ["parentSessionId"] = target,
            ["previousParentSessionId"] = previous,
        };
        if (previous == target)
            return (result, Array.Empty<JsonObject>());
        if (target is null)
            row.Remove("parentSessionId");
        else
            row["parentSessionId"] = target;
        return (result, new[] { row });
    }

    private static JsonArray IdArray(IEnumerable<string> ids) =>
        new(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());

    private static JsonObject[] Siblings(ICatalogRowView view, string? parent, string exclude)
    {
        var rows = view.SiblingRows(parent, exclude);
        // List.Sort is not stable for collation-equal strings. Source Array.sort is stable.
        return rows.Select((row, index) => (row, index))
            .OrderBy(pair => pair.row, Comparer<JsonObject>.Create(SessionCatalog.CompareSidebar))
            .ThenBy(pair => pair.index)
            .Select(pair => pair.row)
            .ToArray();
    }

    private static void Rank(IEnumerable<JsonObject> rows, Dictionary<string, JsonObject> changes)
    {
        var index = 0;
        foreach (var row in rows)
        {
            row["sidebarOrder"] = ++index * 1000;
            changes[Text(row["id"])!] = row;
        }
    }

    internal static (JsonObject Result, JsonObject[] Rows) Move(
        ICatalogRowView view,
        string requested,
        JsonObject body,
        bool promote
    )
    {
        var moving = RequiredMain(view, requested);
        var id = Text(moving["id"])!;
        var previous = promote ? Text(moving["parentSessionId"]) : TreeParent(moving);
        if (previous?.Length == 0)
            previous = null;
        var changes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        string? before = null,
            after = null,
            position = null,
            target;
        var updateOrder = true;
        bool? targetBusy = null;
        if (promote)
        {
            target =
                Text(body["targetParentId"]) is { } raw && SessionCatalog.Trim(raw).Length > 0
                    ? Text(RequiredMain(view, SessionCatalog.Trim(raw), "targetParentId")["id"])
                    : null;
            if (target is not null)
                targetBusy = Flag(view.Get(target)!["busy"]);
        }
        else
        {
            before = OptionalMain(view, body["beforeSessionId"], "beforeSessionId");
            after = OptionalMain(view, body["afterSessionId"], "afterSessionId");
            if (before is not null && after is not null)
                throw new SessionPresentationException(
                    "Specify either beforeSessionId or afterSessionId, not both.",
                    "MULTIPLE_MOVE_ANCHORS"
                );
            updateOrder = !(
                body["updateOrder"] is JsonValue flag
                && flag.TryGetValue<bool>(out var enabled)
                && !enabled
            );
            if (body["position"] is not null && Text(body["position"]) != "")
            {
                position = Text(body["position"]);
                if (position is not ("first" or "last"))
                    throw new SessionPresentationException(
                        "position must be either \"first\" or \"last\" when provided.",
                        "INVALID_MOVE_POSITION"
                    );
            }
            if (position is not null && (before is not null || after is not null))
                throw new SessionPresentationException(
                    "position cannot be combined with beforeSessionId or afterSessionId.",
                    "POSITION_WITH_ANCHOR_NOT_ALLOWED"
                );
            if (!updateOrder && (position is not null || before is not null || after is not null))
                throw new SessionPresentationException(
                    "updateOrder=false can only be used for parent-only moves.",
                    "ORDER_ANCHOR_WITH_UPDATE_ORDER_DISABLED"
                );
            var anchor = before ?? after;
            if (anchor == id)
                throw new SessionPresentationException(
                    "A session cannot be reordered relative to itself.",
                    "SELF_ANCHOR_NOT_ALLOWED"
                );
            var anchorParent = anchor is null ? null : TreeParent(view.Get(anchor)!);
            target =
                body.ContainsKey("parentSessionId")
                    ? OptionalMain(view, body["parentSessionId"], "parentSessionId")
                : anchor is null ? previous
                : anchorParent;
            if (anchor is not null && anchorParent != target)
                throw new SessionPresentationException(
                    "Move anchor is not in the requested target parent group.",
                    "ANCHOR_PARENT_MISMATCH"
                );
        }
        ValidateParent(view, id, target);
        if (promote || previous != target)
        {
            var writtenParent = target is null ? null : Text(view.Resolve(target)["sessionId"]);
            if (target is not null && writtenParent is null)
                throw new SessionPresentationException(
                    $"Session \"{target}\" not found.",
                    "MOVE_SESSION_FAILED",
                    500
                );
            if (Text(moving["parentSessionId"]) != writtenParent)
            {
                if (writtenParent is null)
                    moving.Remove("parentSessionId");
                else
                    moving["parentSessionId"] = writtenParent;
                changes[id] = moving;
            }
        }
        if (updateOrder)
        {
            if (previous != target)
                Rank(Siblings(view, previous, id), changes);
            var siblings = Siblings(view, target, id).ToList();
            var insert = position == "last" ? siblings.Count : 0;
            if (before is not null || after is not null)
            {
                var anchor = before ?? after;
                var found = siblings.FindIndex(row => Text(row["id"]) == anchor);
                if (found < 0)
                    throw new SessionPresentationException(
                        "Move anchor is not a sibling in the target group.",
                        before is not null
                            ? "BEFORE_ANCHOR_NOT_IN_TARGET_GROUP"
                            : "AFTER_ANCHOR_NOT_IN_TARGET_GROUP"
                    );
                insert = found + (after is null ? 0 : 1);
            }
            if (promote && previous is not null)
            {
                var found = siblings.FindIndex(row => Text(row["id"]) == previous);
                insert = found >= 0 ? found + 1 : 0;
            }
            siblings.Insert(insert, moving);
            Rank(siblings, changes);
        }
        var response = new JsonObject
        {
            ["success"] = true,
            ["sessionId"] = id,
            ["parentSessionId"] = TreeParent(moving),
            ["previousParentSessionId"] = previous,
            ["beforeSessionId"] = before,
            ["afterSessionId"] = after,
            ["sidebarOrder"] =
                SessionCatalog.Number(moving["sidebarOrder"]) is { } order && order != 0
                    ? order
                    : null,
        };
        if (promote)
        {
            response.Remove("beforeSessionId");
            response.Remove("afterSessionId");
            response["operation"] = target is null ? "promote-to-root" : "move-up";
            response["targetParentId"] = target;
            response["sessionBusy"] = Flag(moving["busy"]);
            if (targetBusy is not null)
                response["targetParentBusy"] = targetBusy;
        }
        return (response, changes.Values.ToArray());
    }

    internal static (string[] Descendants, string[] Direct, string[] PostOrder) Descendants(
        ICatalogRowView view,
        string root
    )
    {
        var children = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var (row, parent) in view.ResolvedRows())
        {
            if (parent is null)
                continue;
            if (!children.TryGetValue(parent, out var group))
                children[parent] = group = [];
            group.Add(Text(row["id"])!);
        }
        foreach (var group in children.Values)
        {
            var sorted = group.OrderBy(id => id, IdCollation).ToArray();
            group.Clear();
            group.AddRange(sorted);
        }
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var descendants = new List<string>();
        var post = new List<string>();
        void Visit(string id, bool include)
        {
            if (!visiting.Add(id))
                throw new SessionPresentationException(
                    $"Session relation cycle detected while traversing descendants of \"{root}\".",
                    "SESSION_RELATION_CYCLE",
                    409
                );
            if (visited.Contains(id))
            {
                visiting.Remove(id);
                return;
            }
            if (include)
                descendants.Add(id);
            foreach (var child in children.GetValueOrDefault(id) ?? [])
                Visit(child, true);
            visiting.Remove(id);
            visited.Add(id);
            post.Add(id);
        }
        Visit(root, false);
        return (
            descendants.ToArray(),
            (children.GetValueOrDefault(root) ?? []).ToArray(),
            post.ToArray()
        );
    }

    internal static DeleteSelection SelectDeletion(
        ICatalogRowView view,
        string requested,
        bool recursive
    )
    {
        var root = Text(RequiredMain(view, requested)["id"])!;
        if (recursive)
        {
            var tree = Descendants(view, root);
            return new(root, [root, .. tree.Descendants], tree.Direct, tree.PostOrder);
        }
        var direct = view.ResolvedRows()
            .Where(pair => pair.Parent == root)
            .Select(pair => Text(pair.Row["id"])!)
            .OrderBy(id => id, IdCollation)
            .ToArray();
        return new(root, [root], direct, [root]);
    }

    /// <summary>
    /// The rows an identity move writes: the lifetime under its new ID, Agent and aliases,
    /// and the children whose parent reference named the old ID. <c>Direct</c> lists those
    /// children by their written IDs.
    /// </summary>
    internal sealed record IdentityRewrite(
        bool HasSource,
        JsonObject[] Rows,
        string[] Direct
    );

    internal static IdentityRewrite RewriteIdentity(
        ICatalogRowView view,
        string from,
        string to,
        string agent,
        string[] aliases,
        bool requireSource
    )
    {
        var source = view.Get(from);
        var existing = view.Get(to);
        if (source is not null && existing is not null)
            throw new InvalidDataException(
                "Identity recovery has conflicting exact Main lifetimes."
            );
        if (source is null && (requireSource || existing is null))
            throw new InvalidDataException("Identity move lacks its exact Main lifetime.");
        var row = source ?? existing!;
        row["id"] = to;
        row["agent"] = agent;
        row["aliases"] = new JsonArray(
            aliases.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
        );
        var direct = view.IdentityChildren(from);
        var children = direct.Where(child => Text(child["id"]) != from).ToArray();
        if (Text(row["parentSessionId"]) == from)
            row["parentSessionId"] = to;
        foreach (var child in children)
            child["parentSessionId"] = to;
        return new(
            source is not null,
            [SessionCatalog.Project(row), .. children.Select(SessionCatalog.Project)],
            direct.Select(child => Text(child["id"]) == from ? to : Text(child["id"])!).ToArray()
        );
    }
}
