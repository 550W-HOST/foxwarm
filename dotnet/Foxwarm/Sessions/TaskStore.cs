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

internal sealed record TaskAssignmentPlan(long Revision, string? NewOwner, string? PreviousOwner);

internal sealed record TaskStoreResult(
    JsonObject Payload,
    TaskAssignmentPlan? Assignment = null,
    bool Completed = false
);

internal sealed class TaskStore : IDisposable
{
    private const int ListLimit = 50;
    private const int ChildLimit = 20;
    private const int NoteLimit = 10;
    private readonly string path;
    private readonly Func<string, string?> resolveAlias;
    private readonly Func<string, IReadOnlyList<string>> aliases;
    private readonly object gate = new();
    private SqliteConnection? connection;

    internal TaskStore(
        string root,
        Func<string, string?> resolveAlias,
        Func<string, IReadOnlyList<string>> aliases
    )
    {
        path = Path.Combine(root, "state", "tasks.sqlite");
        this.resolveAlias = resolveAlias;
        this.aliases = aliases;
    }

    internal TaskStoreResult Execute(
        JsonObject args,
        string? actor,
        int? httpLimit = null,
        long? anchorSeq = null
    )
    {
        Validate(args, httpLimit);
        var action = Text(args["action"]);
        if (action is not ("list" or "get") && string.IsNullOrEmpty(actor))
            throw new TaskError("TASK_INVALID_ARGS", "task requires a current Session.");
        lock (gate)
        {
            var db = Open();
            var read = action is "list" or "get";
            if (read)
            {
                using var tx = db.BeginTransaction(System.Data.IsolationLevel.Serializable);
                try
                {
                    var result = ExecuteTransaction(
                        db,
                        args,
                        actor,
                        httpLimit ?? ListLimit,
                        anchorSeq
                    );
                    tx.Commit();
                    return result;
                }
                catch
                {
                    try
                    {
                        tx.Rollback();
                    }
                    catch { }
                    throw;
                }
            }
            db.ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var result = ExecuteTransaction(db, args, actor, httpLimit ?? ListLimit, anchorSeq);
                db.ExecuteNonQuery("COMMIT");
                return result;
            }
            catch
            {
                try
                {
                    db.ExecuteNonQuery("ROLLBACK");
                }
                catch { }
                throw;
            }
        }
    }

    internal string? DefaultActor(JsonObject args)
    {
        var id = Text(args["taskId"]);
        if (id is null)
            return null;
        lock (gate)
        {
            var db = Open();
            var row = Read(db, id);
            return row is null
                ? null
                : Canonical(Text(row["ownerSessionId"]) ?? Text(row["createdBySessionId"]));
        }
    }

    internal void MigrateLegacyGoal(string sessionId, string goal, long anchorSeq)
    {
        lock (gate)
        {
            var db = Open();
            db.ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var references = References(sessionId);
                var placeholders = string.Join(',', references.Select((_, index) => "$r" + index));
                using var find = db.CreateCommand();
                find.CommandText =
                    $"SELECT id FROM tasks WHERE legacyGoalSessionId IN ({placeholders}) ORDER BY createdAt,id LIMIT 1";
                for (var index = 0; index < references.Count; index++)
                    Add(find, "$r" + index, references[index]);
                var existing = find.ExecuteScalar()?.ToString();
                if (existing is null)
                {
                    var id = NewTaskId();
                    var now = Now();
                    using var insert = db.CreateCommand();
                    insert.CommandText =
                        "INSERT INTO tasks(id,title,description,status,createdBySessionId,ownerSessionId,createdAt,updatedAt,legacyGoalSessionId,reminderLastSeq) VALUES($id,$title,$description,'active',$creator,$owner,$now,$now,$legacy,$anchor)";
                    Add(insert, "$id", id);
                    Add(
                        insert,
                        "$title",
                        SessionGoal.Trim(goal).Split('\n')[0][
                            ..Math.Min(200, SessionGoal.Trim(goal).Split('\n')[0].Length)
                        ]
                    );
                    Add(insert, "$description", goal);
                    Add(insert, "$creator", Canonical(sessionId));
                    Add(insert, "$owner", Canonical(sessionId));
                    Add(insert, "$now", now);
                    Add(insert, "$legacy", sessionId);
                    Add(insert, "$anchor", anchorSeq);
                    insert.ExecuteNonQuery();
                }
                else if (Read(db, existing) is { } existingRow)
                {
                    var creator = Canonical(Text(existingRow["createdBySessionId"]));
                    var owner = Canonical(Text(existingRow["ownerSessionId"]));
                    var attached = Canonical(Text(existingRow["attachedSessionId"]));
                    var previousOwner = Canonical(Text(existingRow["previousOwnerSessionId"]));
                    Update(
                        db,
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
                db.ExecuteNonQuery("COMMIT");
            }
            catch
            {
                try
                {
                    db.ExecuteNonQuery("ROLLBACK");
                }
                catch { }
                throw;
            }
        }
    }

    internal string? ReadStoredDescription(string taskId)
    {
        lock (gate)
        {
            var db = Open();
            using var command = db.CreateCommand();
            command.CommandText = "SELECT description FROM tasks WHERE id=$id";
            Add(command, "$id", taskId);
            var value = command.ExecuteScalar();
            if (value is null or DBNull)
                return null;
            return value.ToString();
        }
    }

    internal void AttachChild(string taskId, string childSessionId)
    {
        lock (gate)
        {
            var db = Open();
            db.ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var task =
                    Read(db, taskId)
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
                Update(
                    db,
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
                AddNote(
                    db,
                    taskId,
                    childSessionId,
                    $"Attached new Session {Canonical(childSessionId)}.",
                    now
                );
                db.ExecuteNonQuery("COMMIT");
            }
            catch
            {
                try
                {
                    db.ExecuteNonQuery("ROLLBACK");
                }
                catch { }
                throw;
            }
        }
    }

    internal JsonObject TaskContext(
        string sessionId,
        IReadOnlyList<long> sequences,
        bool consume,
        IReadOnlyList<string> retained
    )
    {
        lock (gate)
        {
            var db = Open();
            db.ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var references = References(sessionId);
                var result = new List<JsonObject>();
                using var cmd = db.CreateCommand();
                cmd.CommandText = "SELECT * FROM tasks WHERE status='active' ORDER BY createdAt,id";
                using var reader = cmd.ExecuteReader();
                var rows = new List<JsonObject>();
                while (reader.Read())
                    rows.Add(Row(reader));
                var latest = sequences.Count == 0 ? 0 : sequences.Max();
                foreach (var row in rows)
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
                        Update(
                            db,
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
                    if (consume && (due || retained.Contains(id)))
                    {
                        result.Add(
                            new JsonObject
                            {
                                ["id"] = id,
                                ["title"] = Text(row["title"]),
                                ["status"] = Text(row["status"]),
                            }
                        );
                        if (due)
                            count = 0;
                    }
                    Update(
                        db,
                        id,
                        "reminderLastSeq",
                        Math.Max(latest, last),
                        "reminderMessageCount",
                        count
                    );
                }
                db.ExecuteNonQuery("COMMIT");
                var tasks = new JsonArray(result.Take(50).Select(item => (JsonNode)item).ToArray());
                return new JsonObject
                {
                    ["tasks"] = tasks,
                    ["omitted"] = Math.Max(0, result.Count - tasks.Count),
                };
            }
            catch
            {
                try
                {
                    db.ExecuteNonQuery("ROLLBACK");
                }
                catch { }
                throw;
            }
        }
    }

    internal void MarkNotification(
        string taskId,
        string field,
        string status,
        long? revision = null
    )
    {
        lock (gate)
        {
            var db = Open();
            db.ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var sql =
                    $"UPDATE tasks SET {field}=$status WHERE id=$id AND {field}='pending'"
                    + (revision is null ? "" : " AND assignmentRevision=$revision");
                using var cmd = db.CreateCommand();
                cmd.CommandText = sql;
                cmd.Parameters.AddWithValue("$status", status);
                cmd.Parameters.AddWithValue("$id", taskId);
                if (revision is not null)
                    cmd.Parameters.AddWithValue("$revision", revision.Value);
                cmd.ExecuteNonQuery();
                db.ExecuteNonQuery("COMMIT");
            }
            catch
            {
                try
                {
                    db.ExecuteNonQuery("ROLLBACK");
                }
                catch { }
                throw;
            }
        }
    }

    private TaskStoreResult ExecuteTransaction(
        SqliteConnection db,
        JsonObject args,
        string? actor,
        int limit,
        long? anchorSeq
    )
    {
        var action = Text(args["action"])!;
        if (action == "list")
        {
            var status = Text(args["status"]);
            var where = status is null ? "status IN ('open','active')" : "status=$status";
            var rows = Query(
                db,
                $"SELECT id,title,status,parentTaskId,createdBySessionId,ownerSessionId,updatedAt FROM tasks WHERE {where} ORDER BY updatedAt DESC,id LIMIT $limit",
                status,
                Math.Min(ListLimit, Math.Max(1, limit))
            );
            rows = rows.Select(CanonicalReferences).ToList();
            var total = ScalarInt(db, $"SELECT COUNT(*) FROM tasks WHERE {where}", status);
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
            if (parent is not null && !Exists(db, parent))
                throw new TaskError("TASK_NOT_FOUND", $"Task {parent} not found.", 404);
            var id = NewTaskId();
            var requestedOwner =
                args.ContainsKey("ownerSessionId") && args["ownerSessionId"] is null
                    ? null
                    : Canonical(Text(args["ownerSessionId"]));
            var notifyNew =
                requestedOwner is not null && args["notifySession"]?.GetValue<bool>() == true;
            var now = Now();
            using var cmd = db.CreateCommand();
            cmd.CommandText =
                "INSERT INTO tasks(id,title,description,status,parentTaskId,createdBySessionId,ownerSessionId,createdAt,updatedAt,assignmentRevision,assignmentNotificationStatus,reminderLastSeq) VALUES($id,$title,$description,$status,$parent,$creator,$owner,$now,$now,$revision,$notification,$anchor)";
            Add(cmd, "$id", id);
            Add(cmd, "$title", Text(args["title"])!);
            Add(cmd, "$description", Text(args["description"]));
            Add(cmd, "$parent", parent);
            Add(cmd, "$creator", Canonical(actor!));
            Add(cmd, "$owner", requestedOwner);
            Add(cmd, "$now", now);
            Add(cmd, "$status", requestedOwner is null ? "open" : "active");
            Add(cmd, "$revision", requestedOwner is null ? 0 : 1);
            Add(cmd, "$notification", notifyNew ? "pending" : null);
            Add(cmd, "$anchor", requestedOwner == Canonical(actor!) ? anchorSeq : null);
            cmd.ExecuteNonQuery();
            return new(
                TaskJson(new JsonObject { ["task"] = Public(db, id) }),
                notifyNew ? new TaskAssignmentPlan(1, requestedOwner, null) : null
            );
        }
        if (taskId is null)
            throw new TaskError("TASK_INVALID_ARGS", $"task {action} requires a non-empty taskId.");
        var task =
            Read(db, taskId)
            ?? throw new TaskError("TASK_NOT_FOUND", $"Task {taskId} not found.", 404);
        if (action == "get")
            return new(TaskJson(Details(db, task["id"]!.GetValue<string>())));
        var state =
            $"status={Text(task["status"])}, owner={Text(task["ownerSessionId"]) ?? "unclaimed"}";
        if (Text(task["status"]) is "completed" or "cancelled")
            throw new TaskError(
                "TASK_TERMINAL",
                $"Task {taskId} is terminal ({state}); {action} is not allowed.",
                409
            );
        actor = Canonical(
            actor ?? throw new TaskError("TASK_INVALID_ARGS", "task requires a current Session.")
        );
        var owner = Canonical(Text(task["ownerSessionId"]));
        var creator = Canonical(Text(task["createdBySessionId"])!);
        Update(
            db,
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
                Update(
                    db,
                    taskId,
                    "ownerSessionId",
                    actor,
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
            var permitted = action is "assign" or "cancel"
                ? actor == creator || actor == owner
                : actor == (owner ?? creator);
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
                    Update(
                        db,
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
                        AddNote(
                            db,
                            taskId,
                            actor!,
                            $"Owner changed from {owner ?? "unclaimed"} to {requested ?? "unclaimed"}.",
                            now2
                        );
                    plan = new(
                        revision,
                        notifyNew ? requested : null,
                        notifyPrevious ? previous : null
                    );
                    break;
                case "update":
                    Update(
                        db,
                        taskId,
                        "description",
                        Text(args["description"]) ?? Text(task["description"]),
                        "status",
                        Text(args["status"]) ?? Text(task["status"]),
                        "updatedAt",
                        now2
                    );
                    if (args["note"] is not null)
                        AddNote(db, taskId, actor!, Text(args["note"])!, now2);
                    if (Text(args["status"]) == "active" && Text(task["status"]) != "active")
                        Update(db, taskId, "reminderLastSeq", anchorSeq, "reminderMessageCount", 0);
                    break;
                case "complete":
                    Update(
                        db,
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
                    Update(
                        db,
                        taskId,
                        "status",
                        "cancelled",
                        "cancelledAt",
                        now2,
                        "updatedAt",
                        now2
                    );
                    if (args["reason"] is not null)
                        AddNote(db, taskId, actor!, Text(args["reason"])!, now2);
                    break;
            }
        }
        var payload = new JsonObject { ["task"] = Public(db, taskId) };
        return new(TaskJson(payload), plan, completed);
    }

    private JsonObject Details(SqliteConnection db, string id)
    {
        var task = Public(db, id);
        var children = Query(
            db,
            "SELECT id,title,status,ownerSessionId FROM tasks WHERE parentTaskId=$id ORDER BY createdAt,id LIMIT 20",
            null,
            20,
            id
        );
        var childCount = ScalarInt(
            db,
            "SELECT COUNT(*) FROM tasks WHERE parentTaskId=$id",
            null,
            id
        );
        var notes = Query(
            db,
            "SELECT sessionId,text,createdAt FROM task_notes WHERE taskId=$id ORDER BY id DESC LIMIT 10",
            null,
            10,
            id
        );
        notes.Reverse();
        notes = notes.Select(CanonicalReferences).ToList();
        children = children.Select(CanonicalReferences).ToList();
        var noteCount = ScalarInt(db, "SELECT COUNT(*) FROM task_notes WHERE taskId=$id", null, id);
        return new JsonObject
        {
            ["task"] = task,
            ["children"] = new JsonArray(children.ToArray()),
            ["childrenOmitted"] = childCount - children.Count,
            ["notes"] = new JsonArray(notes.ToArray()),
            ["notesOmitted"] = noteCount - notes.Count,
        };
    }

    private JsonObject Public(SqliteConnection db, string id)
    {
        var row =
            Read(db, id) ?? throw new TaskError("TASK_NOT_FOUND", $"Task {id} not found.", 404);
        foreach (
            var key in new[]
            {
                "legacyGoalSessionId",
                "reminderLastSeq",
                "reminderMessageCount",
                "assignmentRevision",
            }
        )
            row.Remove(key);
        if (Text(row["description"]) is { Length: > 4000 } description)
            row["description"] = description[..3999] + "…";
        return CanonicalReferences(row);
    }

    private JsonObject? Read(SqliteConnection db, string id)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT * FROM tasks WHERE id=$id";
        Add(cmd, "$id", id);
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? Row(reader) : null;
    }

    private static JsonObject Row(SqliteDataReader reader)
    {
        var row = new JsonObject();
        for (var i = 0; i < reader.FieldCount; i++)
            row[reader.GetName(i)] = reader.IsDBNull(i)
                ? null
                : JsonValue.Create(reader.GetValue(i));
        return row;
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

    private static JsonObject TaskJson(JsonObject value) => value;

    private bool Exists(SqliteConnection db, string id) => Read(db, id) is not null;

    private List<JsonObject> Query(
        SqliteConnection db,
        string sql,
        string? status,
        int limit,
        string? id = null
    )
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        if (status is not null)
            Add(cmd, "$status", status);
        Add(cmd, "$limit", limit);
        if (id is not null)
            Add(cmd, "$id", id);
        using var r = cmd.ExecuteReader();
        var result = new List<JsonObject>();
        while (r.Read())
            result.Add(Row(r));
        return result;
    }

    private int ScalarInt(SqliteConnection db, string sql, string? status, string? id = null)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        if (status is not null)
            Add(cmd, "$status", status);
        if (id is not null)
            Add(cmd, "$id", id);
        return Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private void AddNote(
        SqliteConnection db,
        string taskId,
        string sessionId,
        string text,
        long now
    )
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText =
            "INSERT INTO task_notes(taskId,sessionId,text,createdAt) VALUES($task,$session,$text,$now)";
        Add(cmd, "$task", taskId);
        Add(cmd, "$session", sessionId);
        Add(cmd, "$text", text);
        Add(cmd, "$now", now);
        cmd.ExecuteNonQuery();
    }

    private static void Update(SqliteConnection db, string id, params object?[] values)
    {
        using var cmd = db.CreateCommand();
        var sets = new List<string>();
        for (var i = 0; i < values.Length; i += 2)
        {
            var key = (string)values[i]!;
            sets.Add($"{key}=$p{i}");
            Add(cmd, $"$p{i}", values[i + 1]);
        }
        cmd.CommandText = $"UPDATE tasks SET {string.Join(',', sets)} WHERE id=$id";
        Add(cmd, "$id", id);
        cmd.ExecuteNonQuery();
    }

    private static void Add(SqliteCommand cmd, string name, object? value) =>
        cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);

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

    private SqliteConnection Open()
    {
        if (connection is null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            connection = new SqliteConnection($"Data Source={path};Cache=Shared");
            connection.Open();
            Initialize(connection);
        }
        return connection;
    }

    private static void Initialize(SqliteConnection db)
    {
        db.ExecuteNonQuery(
            "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; "
                + "CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,status TEXT NOT NULL CHECK(status IN ('open','active','completed','cancelled')),parentTaskId TEXT REFERENCES tasks(id),createdBySessionId TEXT NOT NULL,ownerSessionId TEXT,result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,completedAt INTEGER,cancelledAt INTEGER); "
                + "CREATE TABLE IF NOT EXISTS task_notes(id INTEGER PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),sessionId TEXT NOT NULL,text TEXT NOT NULL,createdAt INTEGER NOT NULL);"
        );
        foreach (
            var column in new[]
            {
                ("completionNotificationStatus", "TEXT"),
                ("assignmentNotificationStatus", "TEXT"),
                ("previousOwnerSessionId", "TEXT"),
                ("previousOwnerNotificationStatus", "TEXT"),
                ("assignmentRevision", "INTEGER NOT NULL DEFAULT 0"),
                ("attachedSessionId", "TEXT"),
                ("legacyGoalSessionId", "TEXT"),
                ("reminderLastSeq", "INTEGER"),
                ("reminderMessageCount", "INTEGER NOT NULL DEFAULT 0"),
            }
        )
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = "PRAGMA table_info(tasks)";
            using var r = cmd.ExecuteReader();
            var found = false;
            while (r.Read())
                if (r.GetString(1) == column.Item1)
                    found = true;
            if (!found)
                db.ExecuteNonQuery($"ALTER TABLE tasks ADD COLUMN {column.Item1} {column.Item2}");
        }
        db.ExecuteNonQuery(
            "CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,updatedAt); "
                + "CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parentTaskId,createdAt); "
                + "CREATE INDEX IF NOT EXISTS tasks_self_owned ON tasks(createdBySessionId,ownerSessionId,status,createdAt,id); "
                + "CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(taskId,id); "
                + "CREATE UNIQUE INDEX IF NOT EXISTS tasks_legacy_goal ON tasks(legacyGoalSessionId);"
        );
    }

    public void Dispose()
    {
        lock (gate)
        {
            connection?.Dispose();
            connection = null;
        }
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
        Limit(args, "title", 200);
        Limit(args, "description", 4000);
        Limit(args, "result", 4000);
        Limit(args, "reason", 1000);
        Limit(args, "note", 1000);
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
        if (action == "create" && string.IsNullOrWhiteSpace(Text(args["title"])))
            throw new TaskError("TASK_INVALID_ARGS", "task create requires a non-empty title.");
        if (
            action is not "create" and not "list"
            && string.IsNullOrWhiteSpace(Text(args["taskId"]))
        )
            throw new TaskError("TASK_INVALID_ARGS", $"task {action} requires a non-empty taskId.");
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
        if (args["notifySession"] is JsonValue notify && !notify.TryGetValue<bool>(out _))
            throw new TaskError("TASK_INVALID_ARGS", "notifySession must be a boolean.");
        if (
            action == "update"
            && !args.ContainsKey("description")
            && !args.ContainsKey("note")
            && !args.ContainsKey("status")
        )
            throw new TaskError(
                "TASK_INVALID_ARGS",
                "task update requires description, note, or status."
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
            "list" => key is "status",
            "get" or "claim" => key is "taskId",
            "assign" => key is "taskId" or "ownerSessionId" or "notifySession",
            "update" => key is "taskId" or "description" or "note" or "status",
            "complete" => key is "taskId" or "result",
            "cancel" => key is "taskId" or "reason",
            _ => false,
        };

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
