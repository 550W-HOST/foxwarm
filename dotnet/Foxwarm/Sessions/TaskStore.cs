using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed class TaskError(string code, string message, int statusCode = 400)
    : InvalidOperationException(message)
{
    internal string Code { get; } = code;
    internal int StatusCode { get; } = statusCode;
}

internal sealed record TaskAssignmentPlan(
    long Revision,
    string? NewOwner,
    string? PreviousOwner,
    string SourceKind = "session"
);

internal sealed record TaskStoreResult(
    JsonObject Payload,
    TaskAssignmentPlan? Assignment = null,
    bool Completed = false,
    string? CommentOwner = null
);

internal sealed class TaskStore : IDisposable
{
    private const int ListLimit = 50;
    private const int ChildLimit = 20;
    private const int NoteLimit = 10;
    private readonly ITaskRowStore rows;
    private readonly Func<string, string?> resolveAlias;
    private readonly Func<string, IReadOnlyList<string>> aliases;
    // A holder can be doing synchronous row I/O. Async callers wait without occupying a worker.
    private readonly Foxwarm.Storage.StoreGate gate = new();

    internal TaskStore(
        string root,
        Func<string, string?> resolveAlias,
        Func<string, IReadOnlyList<string>> aliases
    )
        : this(new SqliteTaskRowStore(root), resolveAlias, aliases) { }

    internal TaskStore(
        ITaskRowStore rows,
        Func<string, string?> resolveAlias,
        Func<string, IReadOnlyList<string>> aliases
    )
    {
        this.rows = rows;
        this.resolveAlias = resolveAlias;
        this.aliases = aliases;
    }

    internal TaskStoreResult Execute(
        JsonObject args,
        string? actor,
        int? httpLimit = null,
        long? anchorSeq = null,
        string actorKind = "session",
        IReadOnlyList<string>? scopeSessionIds = null
    )
    {
        var (access, body) = Prepare(args, actor, httpLimit, anchorSeq, actorKind, scopeSessionIds);
        using (gate.Enter())
            return rows.Run(access, body);
    }

    /// <summary><see cref="Execute"/> for async paths: waits without a thread.</summary>
    internal Task<TaskStoreResult> ExecuteAsync(
        JsonObject args,
        string? actor,
        int? httpLimit = null,
        long? anchorSeq = null,
        string actorKind = "session",
        IReadOnlyList<string>? scopeSessionIds = null
    )
    {
        var (access, body) = Prepare(args, actor, httpLimit, anchorSeq, actorKind, scopeSessionIds);
        return Gated(access == TaskRowAccess.Write, body);
    }

    private (TaskRowAccess Access, Func<ITaskRows, TaskStoreResult> Body) Prepare(
        JsonObject args,
        string? actor,
        int? httpLimit,
        long? anchorSeq,
        string actorKind,
        IReadOnlyList<string>? scopeSessionIds
    )
    {
        if (actorKind == "user")
            ValidateUser(args);
        else
            Validate(args, httpLimit);
        var action = Text(args["action"]);
        if (actorKind != "user" && action is not ("list" or "get") && string.IsNullOrEmpty(actor))
            throw new TaskError("TASK_INVALID_ARGS", "task requires a current Session.");
        return (
            action is "list" or "get" ? TaskRowAccess.Read : TaskRowAccess.Write,
            db => ExecuteTransaction(db, args, actor, httpLimit ?? ListLimit, anchorSeq, actorKind, scopeSessionIds)
        );
    }

    // The async paths' entry: the gate, then the rows' resources, waited for without a thread.
    private Task<T> Gated<T>(bool write, Func<ITaskRows, T> body) =>
        gate.HoldAsync(() => rows.RunTransactionAsync(write, db => gate.InBody(() => body(db))));

    internal TaskStoreResult ExecuteAsUser(JsonObject args, int? httpLimit = null) =>
        Execute(args, null, httpLimit, null, "user");

    internal Task<TaskStoreResult> ExecuteAsUserAsync(JsonObject args, int? httpLimit = null) =>
        ExecuteAsync(args, null, httpLimit, null, "user");

    internal string? OwnerSessionId(string taskId)
    {
        using (gate.Enter())
        {
            var row = rows.Run(TaskRowAccess.Direct, db => db.Read(taskId));
            return row is null ? null : Canonical(Text(row["ownerSessionId"]));
        }
    }

    internal string? CreatorSessionId(string taskId)
    {
        using (gate.Enter())
        {
            var row = rows.Run(TaskRowAccess.Direct, db => db.Read(taskId));
            return row is null ? null : Canonical(Text(row["createdBySessionId"]));
        }
    }

    internal Task<string?> DefaultActorAsync(JsonObject args) =>
        Text(args["taskId"]) is { } id
            ? ReadTaskAsync(id, row => row is null ? null : Canonical(Text(row["ownerSessionId"]) ?? Text(row["createdBySessionId"])))
            : Task.FromResult<string?>(null);

    internal void MigrateLegacyGoal(string sessionId, string goal, long anchorSeq)
    {
        using (gate.Enter())
            rows.Run(
                TaskRowAccess.Write,
                db =>
                {
                    var existing = db.FindLegacyGoal(References(sessionId));
                    if (existing is null)
                    {
                        var now = Now();
                        db.Insert(
                            "id",
                            NewTaskId(),
                            "title",
                            SessionGoal.Trim(goal).Split('\n')[0][
                                ..Math.Min(200, SessionGoal.Trim(goal).Split('\n')[0].Length)
                            ],
                            "description",
                            goal,
                            "status",
                            "active",
                            "createdBySessionId",
                            Canonical(sessionId),
                            "ownerSessionId",
                            Canonical(sessionId),
                            "createdAt",
                            now,
                            "updatedAt",
                            now,
                            "legacyGoalSessionId",
                            sessionId,
                            "reminderLastSeq",
                            anchorSeq
                        );
                    }
                    else if (db.Read(existing) is { } existingRow)
                    {
                        var creator = Canonical(Text(existingRow["createdBySessionId"]));
                        var owner = Canonical(Text(existingRow["ownerSessionId"]));
                        var attached = Canonical(Text(existingRow["attachedSessionId"]));
                        var previousOwner = Canonical(Text(existingRow["previousOwnerSessionId"]));
                        db.Update(
                            existing,
                            "createdBySessionId",
                            creator,
                            "ownerSessionId",
                            owner,
                            "attachedSessionId",
                            attached,
                            "previousOwnerSessionId",
                            previousOwner,
                            "legacyGoalSessionId",
                            Canonical(Text(existingRow["legacyGoalSessionId"]))
                        );
                    }
                    return 0;
                }
            );
    }

    internal string? ReadStoredDescription(string taskId)
    {
        using (gate.Enter())
            return Text(rows.Run(TaskRowAccess.Direct, db => db.Read(taskId))?["description"]);
    }

    internal Task<string?> ReadStoredDescriptionAsync(string taskId) =>
        ReadTaskAsync(taskId, row => Text(row?["description"]));

    private Task<T> ReadTaskAsync<T>(string taskId, Func<JsonObject?, T> project) =>
        gate.HoldAsync(() => rows.ReadTaskAsync(taskId, project));

    internal void AttachChild(string taskId, string childSessionId)
    {
        using (gate.Enter())
            rows.Run(TaskRowAccess.Write, db => AttachChild(db, taskId, childSessionId));
    }

    internal Task AttachChildAsync(string taskId, string childSessionId) =>
        Gated(write: true, db => AttachChild(db, taskId, childSessionId));

    private int AttachChild(ITaskRows db, string taskId, string childSessionId)
    {
        var task =
            db.Read(taskId)
            ?? throw new TaskError("TASK_NOT_FOUND", $"Task {taskId} not found.", 404);
        var status = Text(task["status"]);
        if (status is "completed" or "cancelled")
            throw new TaskError("TASK_TERMINAL", $"Task {taskId} is terminal.", 409);
        var owner = Canonical(Text(task["ownerSessionId"]));
        if (owner != Canonical(childSessionId))
            throw new TaskError(
                "TASK_OWNED",
                $"Task {taskId} is not owned by child Session {Canonical(childSessionId)}.",
                409
            );
        var now = Now();
        db.Update(
            taskId,
            "createdBySessionId",
            Canonical(Text(task["createdBySessionId"])),
            "attachedSessionId",
            Canonical(childSessionId),
            "previousOwnerSessionId",
            Canonical(Text(task["previousOwnerSessionId"])),
            "updatedAt",
            now
        );
        db.AddNote(
            taskId,
            childSessionId,
            "session",
            $"Attached new Session {Canonical(childSessionId)}.",
            now
        );
        return 0;
    }

    internal JsonObject TaskContext(string sessionId, IReadOnlyList<long> sequences, bool consume)
    {
        using (gate.Enter())
            return rows.Run(
                TaskRowAccess.Write,
                db =>
                {
                var references = References(sessionId);
                var result = new List<JsonObject>();
                var active = db.ActiveTasks();
                var latest = sequences.Count == 0 ? 0 : sequences.Max();
                foreach (var row in active)
                {
                    var creator = Canonical(Text(row["createdBySessionId"]));
                    var owner = Canonical(Text(row["ownerSessionId"]));
                    if (
                        creator is null
                        || owner is null
                        || !references.Contains(creator)
                        || !references.Contains(owner)
                    )
                        continue;
                    var attached = Canonical(Text(row["attachedSessionId"]));
                    var previousOwner = Canonical(Text(row["previousOwnerSessionId"]));
                    if (
                        creator != Text(row["createdBySessionId"])
                        || owner != Text(row["ownerSessionId"])
                        || attached != Text(row["attachedSessionId"])
                        || previousOwner != Text(row["previousOwnerSessionId"])
                    )
                        db.Update(
                            Text(row["id"])!,
                            "createdBySessionId",
                            creator,
                            "ownerSessionId",
                            owner,
                            "attachedSessionId",
                            attached,
                            "previousOwnerSessionId",
                            previousOwner
                        );
                    long lastSeq = 0;
                    var hasLast =
                        row["reminderLastSeq"] is JsonValue lastValue
                        && lastValue.TryGetValue<long>(out lastSeq);
                    var last = hasLast ? lastSeq : 0;
                    var count = Int(row["reminderMessageCount"]);
                    count = hasLast ? Math.Min(30, count + sequences.Count(seq => seq > last)) : 0;
                    var due = count >= 30;
                    var id = Text(row["id"])!;
                    if (consume && due)
                    {
                        result.Add(
                            new JsonObject
                            {
                                ["id"] = id,
                                ["title"] = Text(row["title"]),
                                ["status"] = Text(row["status"]),
                            }
                        );
                        count = 0;
                    }
                    db.Update(
                        id,
                        "reminderLastSeq",
                        Math.Max(latest, last),
                        "reminderMessageCount",
                        count
                    );
                }
                var tasks = new JsonArray(result.Take(50).Select(item => (JsonNode)item).ToArray());
                return new JsonObject
                {
                    ["tasks"] = tasks,
                    ["omitted"] = Math.Max(0, result.Count - tasks.Count),
                };
                }
            );
    }

    internal void MarkNotification(
        string taskId,
        string field,
        string status,
        long? revision = null
    )
    {
        using (gate.Enter())
            rows.Run(
                TaskRowAccess.Write,
                db =>
                {
                    db.SettlePendingNotification(taskId, field, status, revision);
                    return 0;
                }
            );
    }

    internal Task MarkNotificationAsync(string taskId, string field, string status, long? revision = null) =>
        Gated(write: true, db =>
        {
            db.SettlePendingNotification(taskId, field, status, revision);
            return 0;
        });

    private TaskStoreResult ExecuteTransaction(
        ITaskRows db,
        JsonObject args,
        string? actor,
        int limit,
        long? anchorSeq,
        string actorKind,
        IReadOnlyList<string>? scopeSessionIds
    )
    {
        var action = Text(args["action"])!;
        if (action == "list")
        {
            var scoped =
                Text(args["scope"]) is string scope && scope != "all"
                    ? (
                        scopeSessionIds
                        ?? (
                            scope is "current-session" or "owned" && actor is not null
                                ? new[] { actor }
                                : Array.Empty<string>()
                        )
                    )
                        .SelectMany(References)
                        .Distinct(StringComparer.Ordinal)
                        .ToArray()
                    : null;
            var filter = new TaskListFilter(
                Text(args["status"]),
                scoped,
                Text(args["scope"]) == "owned"
            );
            var rows = db.List(filter, Math.Min(ListLimit, Math.Max(1, limit)));
            rows = rows.Select(CanonicalReferences).ToList();
            var total = db.Count(filter);
            return new(
                TaskJson(
                    new JsonObject
                    {
                        ["tasks"] = new JsonArray(rows.ToArray()),
                        ["total"] = total,
                        ["omitted"] = total - rows.Count,
                    }
                )
            );
        }
        var taskId = Text(args["taskId"]);
        if (action == "create")
        {
            var parent = Text(args["parentTaskId"]);
            if (parent is not null && db.Read(parent) is null)
                throw new TaskError("TASK_NOT_FOUND", $"Task {parent} not found.", 404);
            var id = NewTaskId();
            var requestedOwner =
                args.ContainsKey("ownerSessionId") && args["ownerSessionId"] is null
                    ? null
                    : Canonical(Text(args["ownerSessionId"]));
            var notifyNew =
                requestedOwner is not null && args["notifySession"]?.GetValue<bool>() == true;
            var now = Now();
            db.Insert(
                "id",
                id,
                "title",
                Text(args["title"])!,
                "description",
                Text(args["description"]),
                "status",
                requestedOwner is null ? "open" : "active",
                "parentTaskId",
                parent,
                "createdByKind",
                actorKind,
                "createdBySessionId",
                actorKind == "session" ? Canonical(actor!) : null,
                "ownerSessionId",
                requestedOwner,
                "createdAt",
                now,
                "updatedAt",
                now,
                "assignmentRevision",
                requestedOwner is null ? 0 : 1,
                "assignmentNotificationStatus",
                notifyNew ? "pending" : null,
                "reminderLastSeq",
                actorKind == "session" && requestedOwner == Canonical(actor!) ? anchorSeq : null,
                "ownerAssignedAt",
                requestedOwner is null ? null : now
            );
            return new(
                TaskJson(new JsonObject { ["task"] = Public(db, id) }),
                notifyNew ? new TaskAssignmentPlan(1, requestedOwner, null, actorKind) : null
            );
        }
        if (taskId is null)
            throw new TaskError("TASK_INVALID_ARGS", $"task {action} requires a non-empty taskId.");
        var task =
            db.Read(taskId)
            ?? throw new TaskError("TASK_NOT_FOUND", $"Task {taskId} not found.", 404);
        if (action == "get")
            return new(TaskJson(Details(db, task["id"]!.GetValue<string>())));
        if (action == "comment")
        {
            var note = Text(args["note"]);
            if (note is null)
                throw new TaskError("TASK_INVALID_ARGS", "comment requires a non-empty note.");
            db.AddNote(taskId, actorKind == "session" ? actor : null, actorKind, note, Now());
            db.Update(taskId, "updatedAt", Now());
            return new(
                TaskJson(new JsonObject { ["task"] = Public(db, taskId) }),
                CommentOwner: args["notifySession"]?.GetValue<bool>() == true
                    ? Canonical(Text(task["ownerSessionId"]))
                    : null
            );
        }
        var state =
            $"status={Text(task["status"])}, owner={Text(task["ownerSessionId"]) ?? "unclaimed"}";
        if (Text(task["status"]) is "completed" or "cancelled")
            throw new TaskError(
                "TASK_TERMINAL",
                $"Task {taskId} is terminal ({state}); {action} is not allowed.",
                409
            );
        actor =
            actorKind == "session"
                ? Canonical(
                    actor
                        ?? throw new TaskError(
                            "TASK_INVALID_ARGS",
                            "task requires a current Session."
                        )
                )
                : null;
        var owner = Canonical(Text(task["ownerSessionId"]));
        var creator = Canonical(Text(task["createdBySessionId"])!);
        db.Update(
            taskId,
            "createdBySessionId",
            creator,
            "ownerSessionId",
            owner,
            "attachedSessionId",
            Canonical(Text(task["attachedSessionId"])),
            "previousOwnerSessionId",
            Canonical(Text(task["previousOwnerSessionId"]))
        );
        TaskAssignmentPlan? plan = null;
        var completed = false;
        string? commentOwner = null;
        var now2 = Now();
        if (action == "claim")
        {
            if (owner is not null && owner != actor)
                throw new TaskError(
                    "TASK_OWNED",
                    $"Task {taskId} is already claimed by another Session ({state}).",
                    409
                );
            if (owner is null)
                db.Update(
                    taskId,
                    "ownerSessionId",
                    actor,
                    "ownerAssignedAt",
                    now2,
                    "status",
                    "active",
                    "updatedAt",
                    now2,
                    "reminderLastSeq",
                    anchorSeq,
                    "reminderMessageCount",
                    0
                );
        }
        else
        {
            var sharedUpdate = action == "update" && !args.ContainsKey("status");
            var permitted =
                actorKind == "user"
                || sharedUpdate
                || (
                    action is "assign" or "cancel"
                        ? actor == creator || actor == owner
                        : actor == (owner ?? creator)
                );
            if (!permitted)
                throw new TaskError(
                    "TASK_FORBIDDEN",
                    $"Session {actor} cannot {action} task {taskId} ({state}).",
                    403
                );
            switch (action)
            {
                case "assign":
                    var requestedRaw = Text(args["ownerSessionId"]);
                    var requested =
                        args.ContainsKey("ownerSessionId") && args["ownerSessionId"] is null
                            ? null
                            : Canonical(requestedRaw!);
                    var changed = owner != requested;
                    var revision = Long(task["assignmentRevision"]) + (changed ? 1 : 0);
                    var previous = changed ? owner : Text(task["previousOwnerSessionId"]);
                    var previousStatus = changed
                        ? null
                        : Text(task["previousOwnerNotificationStatus"]);
                    var newStatus = changed ? null : Text(task["assignmentNotificationStatus"]);
                    var notifyNew =
                        args["notifySession"]?.GetValue<bool>() == true
                        && requested is not null
                        && (newStatus is null or "failed");
                    var notifyPrevious =
                        args["notifySession"]?.GetValue<bool>() == true
                        && previous is not null
                        && previous != requested
                        && (changed || previousStatus == "failed");
                    db.Update(
                        taskId,
                        "ownerSessionId",
                        requested,
                        "status",
                        requested is null ? "open" : "active",
                        "updatedAt",
                        now2,
                        "assignmentRevision",
                        revision,
                        "previousOwnerSessionId",
                        previous,
                        "assignmentNotificationStatus",
                        notifyNew ? "pending" : newStatus,
                        "previousOwnerNotificationStatus",
                        notifyPrevious ? "pending" : previousStatus,
                        "reminderLastSeq",
                        changed
                            ? requested == actor
                                ? anchorSeq
                                : null
                            : NullableLong(task["reminderLastSeq"]),
                        "reminderMessageCount",
                        changed ? 0 : Int(task["reminderMessageCount"])
                    );
                    if (changed)
                        db.Update(taskId, "ownerAssignedAt", requested is null ? null : now2);
                    if (changed)
                        db.AddNote(
                            taskId,
                            actor!,
                            actorKind,
                            $"Owner changed from {owner ?? "unclaimed"} to {requested ?? "unclaimed"}.",
                            now2
                        );
                    plan = new(
                        revision,
                        notifyNew ? requested : null,
                        notifyPrevious ? previous : null,
                        actorKind
                    );
                    break;
                case "update":
                    db.Update(
                        taskId,
                        "title",
                        Text(args["title"]) ?? Text(task["title"]),
                        "description",
                        Text(args["description"]) ?? Text(task["description"]),
                        "status",
                        Text(args["status"]) ?? Text(task["status"]),
                        "updatedAt",
                        now2
                    );
                    if (args["note"] is not null)
                        db.AddNote(taskId, actor!, actorKind, Text(args["note"])!, now2);
                    if (
                        args["note"] is not null
                        && args["notifySession"]?.GetValue<bool>() == true
                        && owner is not null
                        && owner != actor
                    )
                        commentOwner = owner;
                    if (Text(args["status"]) == "active" && Text(task["status"]) != "active")
                        db.Update(taskId, "reminderLastSeq", anchorSeq, "reminderMessageCount", 0);
                    break;
                case "complete":
                    db.Update(
                        taskId,
                        "status",
                        "completed",
                        "result",
                        Text(args["result"]),
                        "completedAt",
                        now2,
                        "updatedAt",
                        now2,
                        "completionNotificationStatus",
                        "pending"
                    );
                    completed = true;
                    break;
                case "cancel":
                    db.Update(
                        taskId,
                        "status",
                        "cancelled",
                        "cancelledAt",
                        now2,
                        "updatedAt",
                        now2
                    );
                    if (args["reason"] is not null)
                        db.AddNote(taskId, actor!, actorKind, Text(args["reason"])!, now2);
                    break;
            }
        }
        var payload = new JsonObject { ["task"] = Public(db, taskId) };
        return new(TaskJson(payload), plan, completed, commentOwner);
    }

    private JsonObject Details(ITaskRows db, string id)
    {
        var task = Public(db, id);
        var children = db.Children(id, ChildLimit);
        var childCount = db.ChildCount(id);
        var notes = db.LatestNotes(id, NoteLimit);
        notes.Reverse();
        notes = notes.Select(CanonicalNoteReferences).ToList();
        children = children.Select(CanonicalReferences).ToList();
        var noteCount = db.NoteCount(id);
        return new JsonObject
        {
            ["task"] = task,
            ["children"] = new JsonArray(children.ToArray()),
            ["childrenOmitted"] = childCount - children.Count,
            ["notes"] = new JsonArray(notes.ToArray()),
            ["notesOmitted"] = noteCount - notes.Count,
        };
    }

    private JsonObject Public(ITaskRows db, string id)
    {
        var row =
            db.Read(id) ?? throw new TaskError("TASK_NOT_FOUND", $"Task {id} not found.", 404);
        foreach (
            var key in new[]
            {
                "legacyGoalSessionId",
                "reminderLastSeq",
                "reminderMessageCount",
                "assignmentRevision",
                "ownerAssignedAt",
            }
        )
            row.Remove(key);
        if (Text(row["description"]) is { Length: > 20000 } description)
            row["description"] = description[..19999] + "…";
        if (Text(row["result"]) is { Length: > 20000 } result)
            row["result"] = result[..19999] + "…";
        return CanonicalReferences(row);
    }

    /// <summary>When the current owner was assigned (epoch ms); null for tasks owned before the column existed.</summary>
    internal long? OwnerAssignedAt(string taskId)
    {
        using (gate.Enter())
        {
            return rows.Run(TaskRowAccess.Direct, db => db.Read(taskId)) is { } row
                && row["ownerAssignedAt"] is JsonValue value
                ? Long(value)
                : null;
        }
    }

    internal Task<long?> OwnerAssignedAtAsync(string taskId) =>
        ReadTaskAsync<long?>(taskId, row => row?["ownerAssignedAt"] is JsonValue value ? Long(value) : null);

    // Bounded title/status lookup for display surfaces that already reference these Tasks.
    internal JsonObject Summaries(IReadOnlyList<string> ids)
    {
        var result = new JsonObject();
        if (!rows.Exists)
            return result;
        using (gate.Enter())
            rows.Run(
                TaskRowAccess.Direct,
                db =>
                {
                    foreach (var id in ids.Take(100))
                        if (db.Read(id) is { } row)
                            result[id] = new JsonObject
                            {
                                ["title"] = Text(row["title"]),
                                ["status"] = Text(row["status"]),
                            };
                    return 0;
                }
            );
        return result;
    }

    // Status only, for surfaces that must not expose Task content. Unknown IDs are absent.
    internal IReadOnlyDictionary<string, string> Statuses(IReadOnlyList<string> ids)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (ids.Count == 0 || !rows.Exists)
            return result;
        using (gate.Enter())
            rows.Run(
                TaskRowAccess.Direct,
                db =>
                {
                    foreach (var id in ids)
                        if (db.Read(id) is { } row && Text(row["status"]) is { Length: > 0 } status)
                            result[id] = status;
                    return 0;
                }
            );
        return result;
    }

    private JsonObject CanonicalReferences(JsonObject row)
    {
        foreach (
            var key in new[]
            {
                "createdBySessionId",
                "ownerSessionId",
                "attachedSessionId",
                "previousOwnerSessionId",
            }
        )
            if (Text(row[key]) is { } value)
                row[key] = Canonical(value);
        return row;
    }

    private JsonObject CanonicalNoteReferences(JsonObject row)
    {
        if (Text(row["authorKind"]) != "user" && Text(row["sessionId"]) is { } session)
            row["sessionId"] = Canonical(session);
        return row;
    }

    private static JsonObject TaskJson(JsonObject value) => value;

    private string? Canonical(string? id) => id is null ? null : resolveAlias(id) ?? id;

    private IReadOnlyList<string> References(string id) =>
        new[] { Canonical(id) ?? id }
            .Concat(aliases(Canonical(id) ?? id))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string NewTaskId() =>
        "task_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();

    private static string? Text(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;

    private static int Int(JsonNode? node)
    {
        if (node is not JsonValue value)
            return 0;
        if (value.TryGetValue<int>(out var integer))
            return integer;
        if (value.TryGetValue<long>(out var longValue))
            return checked((int)longValue);
        return value.TryGetValue<double>(out var doubleValue) ? checked((int)doubleValue) : 0;
    }

    private static long Long(JsonNode? node)
    {
        if (node is not JsonValue value)
            return 0;
        if (value.TryGetValue<long>(out var longValue))
            return longValue;
        if (value.TryGetValue<int>(out var integer))
            return integer;
        return value.TryGetValue<double>(out var doubleValue) ? checked((long)doubleValue) : 0;
    }

    private static long? NullableLong(JsonNode? node) => node is null ? null : Long(node);

    public void Dispose()
    {
        using (gate.Enter())
            rows.Dispose();
    }

    internal static void Validate(JsonObject args, int? httpLimit)
    {
        var action = Text(args["action"]);
        if (
            action
            is not (
                "create"
                or "list"
                or "get"
                or "claim"
                or "assign"
                or "update"
                or "complete"
                or "cancel"
            )
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "task action must be one of: create, list, get, claim, assign, update, complete, cancel."
            );
        foreach (var key in args.Select(x => x.Key))
            if (key != "action" && !Allowed(action!, key))
                throw new TaskError(
                    "TASK_INVALID_ARGS",
                    $"{key} is not allowed for task {action}."
                );
        if (
            args.ContainsKey("scope")
            && Text(args["scope"]) is not ("current-session" or "owned" or "current-agent" or "all")
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "scope must be current-session, owned, current-agent, or all."
            );
        Limit(args, "title", 200);
        Limit(args, "description", 20000);
        Limit(args, "result", 20000);
        Limit(args, "reason", 1000);
        Limit(args, "note", 2000);
        Limit(args, "taskId", 128);
        Limit(args, "parentTaskId", 128);
        if (args.ContainsKey("status"))
        {
            var allowedStatuses =
                action == "update"
                    ? new[] { "open", "active" }
                    : new[] { "open", "active", "completed", "cancelled" };
            if (!allowedStatuses.Contains(Text(args["status"]), StringComparer.Ordinal))
                throw new TaskError(
                    "TASK_INVALID_ARGS",
                    $"status for task {action} must be one of: {string.Join(", ", allowedStatuses)}."
                );
        }
        if (
            args.ContainsKey("parentTaskId")
            && string.IsNullOrWhiteSpace(Text(args["parentTaskId"]))
        )
            throw new TaskError("TASK_INVALID_ARGS", "parentTaskId must be non-empty.");
        if (args.ContainsKey("note") && string.IsNullOrWhiteSpace(Text(args["note"])))
            throw new TaskError("TASK_INVALID_ARGS", "note must be non-empty.");
        if (
            (action == "create" || args.ContainsKey("title"))
            && string.IsNullOrWhiteSpace(Text(args["title"]))
        )
            throw new TaskError("TASK_INVALID_ARGS", $"task {action} requires a non-empty title.");
        if (
            action is not "create" and not "list"
            && string.IsNullOrWhiteSpace(Text(args["taskId"]))
        )
            throw new TaskError("TASK_INVALID_ARGS", $"task {action} requires a non-empty taskId.");
        if (action == "assign" && !args.ContainsKey("ownerSessionId"))
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "task assign requires ownerSessionId, which may be null to release ownership."
            );
        if (
            args.ContainsKey("ownerSessionId")
            && args["ownerSessionId"] is not null
            && (
                string.IsNullOrWhiteSpace(Text(args["ownerSessionId"]))
                || Text(args["ownerSessionId"])!.Length > 256
            )
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "task assign requires an existing ownerSessionId or null."
            );
        if (
            args.ContainsKey("notifySession")
            && (args["notifySession"] is not JsonValue notify || !notify.TryGetValue<bool>(out _))
        )
            throw new TaskError("TASK_INVALID_ARGS", "notifySession must be a boolean.");
        if (
            action == "update"
            && !args.ContainsKey("title")
            && !args.ContainsKey("description")
            && !args.ContainsKey("note")
            && !args.ContainsKey("status")
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "task update requires title, description, note, or status."
            );
        if (httpLimit is not null && (httpLimit < 1 || httpLimit > 50))
            throw new TaskError("TASK_INVALID_ARGS", "limit must be an integer from 1 to 50.");
    }

    private static bool Allowed(string action, string key) =>
        action switch
        {
            "create" => key
                is "title"
                    or "description"
                    or "parentTaskId"
                    or "ownerSessionId"
                    or "notifySession",
            "list" => key is "status" or "scope",
            "get" or "claim" => key is "taskId",
            "assign" => key is "taskId" or "ownerSessionId" or "notifySession",
            "update" => key
                is "taskId"
                    or "title"
                    or "description"
                    or "note"
                    or "status"
                    or "notifySession",
            "complete" => key is "taskId" or "result",
            "cancel" => key is "taskId" or "reason",
            _ => false,
        };

    private static void ValidateUser(JsonObject args)
    {
        var action = Text(args["action"]);
        if (action is not ("create" or "assign" or "comment"))
            throw new TaskError("TASK_INVALID_ARGS", "Invalid user task operation.");
        foreach (var key in args.Select(item => item.Key))
        {
            if (
                action == "create"
                    ? key
                        is not (
                            "action"
                            or "title"
                            or "description"
                            or "parentTaskId"
                            or "ownerSessionId"
                            or "notifySession"
                        )
                : action == "assign"
                    ? key is not ("action" or "taskId" or "ownerSessionId" or "notifySession")
                : key is not ("action" or "taskId" or "note" or "notifySession")
            )
                throw new TaskError(
                    "TASK_INVALID_ARGS",
                    $"{key} is not allowed for user task {action}."
                );
        }
        if (
            args.ContainsKey("scope")
            && Text(args["scope"]) is not ("current-session" or "owned" or "current-agent" or "all")
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "scope must be current-session, owned, current-agent, or all."
            );
        Limit(args, "title", 200);
        Limit(args, "description", 20000);
        Limit(args, "taskId", 128);
        Limit(args, "note", 2000);
        if (action == "create" && string.IsNullOrWhiteSpace(Text(args["title"])))
            throw new TaskError("TASK_INVALID_ARGS", "task create requires a non-empty title.");
        if (action != "create" && string.IsNullOrWhiteSpace(Text(args["taskId"])))
            throw new TaskError("TASK_INVALID_ARGS", $"task {action} requires a non-empty taskId.");
        if (action == "comment" && string.IsNullOrWhiteSpace(Text(args["note"])))
            throw new TaskError("TASK_INVALID_ARGS", "A comment requires a non-empty note.");
        if (action == "assign" && !args.ContainsKey("ownerSessionId"))
            throw new TaskError("TASK_INVALID_ARGS", "Owner changes require ownerSessionId.");
        if (
            args.ContainsKey("ownerSessionId")
            && args["ownerSessionId"] is not null
            && (
                string.IsNullOrWhiteSpace(Text(args["ownerSessionId"]))
                || Text(args["ownerSessionId"])!.Length > 256
            )
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "ownerSessionId must identify an existing Session or be null."
            );
        if (
            args.ContainsKey("notifySession")
            && (args["notifySession"] is not JsonValue notify || !notify.TryGetValue<bool>(out _))
        )
            throw new TaskError("TASK_INVALID_ARGS", "notifySession must be a boolean.");
    }

    private static void Limit(JsonObject args, string key, int max)
    {
        if (!args.ContainsKey(key))
            return;
        var value = Text(args[key]);
        if (value is null || value.Length > max)
            throw new TaskError(
                "TASK_INVALID_ARGS",
                $"{key} must be a string of at most {max} characters."
            );
    }
}

internal static class TaskJsonExtensions
{
    internal static bool IsIn(this string? value, params string[] values) =>
        value is not null && values.Contains(value, StringComparer.Ordinal);
}

internal static class SqliteTaskExtensions
{
    internal static void ExecuteNonQuery(this SqliteConnection db, string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}
