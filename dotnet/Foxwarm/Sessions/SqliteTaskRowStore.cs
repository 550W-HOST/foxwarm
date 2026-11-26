using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>File-mode Task rows: <c>state/tasks.sqlite</c> under the data root.</summary>
internal sealed class SqliteTaskRowStore(string root) : ITaskRowStore
{
    private readonly string path = Path.Combine(root, "state", "tasks.sqlite");
    private SqliteConnection? connection;

    public bool Exists => File.Exists(path);

    public T Run<T>(TaskRowAccess access, Func<ITaskRows, T> body)
    {
        var db = Open();
        var rows = new Rows(db);
        if (access == TaskRowAccess.Direct)
            return body(rows);
        if (access == TaskRowAccess.Read)
        {
            using var tx = db.BeginTransaction(System.Data.IsolationLevel.Serializable);
            try
            {
                var result = body(rows);
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
            var result = body(rows);
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

    public void Dispose()
    {
        connection?.Dispose();
        connection = null;
    }

    private SqliteConnection Open()
    {
        if (connection is null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            // The store keeps one connection for its lifetime, so a pool would only
            // outlive Dispose: its prune timer captures the opening turn's async
            // context and would keep the Session manager reachable.
            connection = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = path,
                    Cache = SqliteCacheMode.Shared,
                    Pooling = false,
                }.ToString()
            );
            connection.Open();
            Initialize(connection);
        }
        return connection;
    }

    private sealed class Rows(SqliteConnection db) : ITaskRows
    {
        public JsonObject? Read(string id)
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT * FROM tasks WHERE id=$id";
            Add(cmd, "$id", id);
            using var reader = cmd.ExecuteReader();
            return reader.Read() ? Row(reader) : null;
        }

        public void Insert(params object?[] columnValues)
        {
            using var cmd = db.CreateCommand();
            var columns = new List<string>();
            for (var i = 0; i < columnValues.Length; i += 2)
            {
                columns.Add((string)columnValues[i]!);
                Add(cmd, $"$p{i}", columnValues[i + 1]);
            }
            cmd.CommandText =
                $"INSERT INTO tasks({string.Join(',', columns)}) VALUES({string.Join(',', columns.Select((_, index) => $"$p{index * 2}"))})";
            cmd.ExecuteNonQuery();
        }

        public void Update(string id, params object?[] columnValues)
        {
            using var cmd = db.CreateCommand();
            var sets = new List<string>();
            for (var i = 0; i < columnValues.Length; i += 2)
            {
                var key = (string)columnValues[i]!;
                sets.Add($"{key}=$p{i}");
                Add(cmd, $"$p{i}", columnValues[i + 1]);
            }
            cmd.CommandText = $"UPDATE tasks SET {string.Join(',', sets)} WHERE id=$id";
            Add(cmd, "$id", id);
            cmd.ExecuteNonQuery();
        }

        public void SettlePendingNotification(
            string id,
            string column,
            string status,
            long? revision
        )
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText =
                $"UPDATE tasks SET {column}=$status WHERE id=$id AND {column}='pending'"
                + (revision is null ? "" : " AND assignmentRevision=$revision");
            cmd.Parameters.AddWithValue("$status", status);
            cmd.Parameters.AddWithValue("$id", id);
            if (revision is not null)
                cmd.Parameters.AddWithValue("$revision", revision.Value);
            cmd.ExecuteNonQuery();
        }

        public void AddNote(
            string taskId,
            string? sessionId,
            string authorKind,
            string text,
            long createdAt
        )
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText =
                "INSERT INTO task_notes(taskId,authorKind,sessionId,text,createdAt) VALUES($task,$kind,$session,$text,$now)";
            Add(cmd, "$task", taskId);
            Add(cmd, "$kind", authorKind);
            Add(cmd, "$session", sessionId);
            Add(cmd, "$text", text);
            Add(cmd, "$now", createdAt);
            cmd.ExecuteNonQuery();
        }

        public string? FindLegacyGoal(IReadOnlyList<string> sessionReferences)
        {
            var placeholders = string.Join(
                ',',
                sessionReferences.Select((_, index) => "$r" + index)
            );
            using var find = db.CreateCommand();
            find.CommandText =
                $"SELECT id FROM tasks WHERE legacyGoalSessionId IN ({placeholders}) ORDER BY createdAt,id LIMIT 1";
            for (var index = 0; index < sessionReferences.Count; index++)
                Add(find, "$r" + index, sessionReferences[index]);
            return find.ExecuteScalar()?.ToString();
        }

        public List<JsonObject> ActiveTasks() =>
            Query("SELECT * FROM tasks WHERE status='active' ORDER BY createdAt,id", null, null);

        public List<JsonObject> List(TaskListFilter filter, int limit) =>
            Query(
                $"SELECT id,title,status,parentTaskId,createdByKind,createdBySessionId,ownerSessionId,updatedAt FROM tasks WHERE {Where(filter)} ORDER BY updatedAt DESC,id LIMIT $limit",
                limit,
                null,
                filter
            );

        public int Count(TaskListFilter filter) =>
            Scalar($"SELECT COUNT(*) FROM tasks WHERE {Where(filter)}", null, filter);

        public List<JsonObject> Children(string parentId, int limit) =>
            Query(
                "SELECT id,title,status,ownerSessionId FROM tasks WHERE parentTaskId=$id ORDER BY createdAt,id LIMIT $limit",
                limit,
                parentId
            );

        public int ChildCount(string parentId) =>
            Scalar("SELECT COUNT(*) FROM tasks WHERE parentTaskId=$id", parentId);

        public List<JsonObject> LatestNotes(string taskId, int limit) =>
            Query(
                "SELECT authorKind,sessionId,text,createdAt FROM task_notes WHERE taskId=$id ORDER BY id DESC LIMIT $limit",
                limit,
                taskId
            );

        public int NoteCount(string taskId) =>
            Scalar("SELECT COUNT(*) FROM task_notes WHERE taskId=$id", taskId);

        private static string Where(TaskListFilter filter)
        {
            var where =
                filter.Status is null ? "status IN ('open','active')" : "status=$status";
            if (filter.ScopeIds is { } scoped)
            {
                var placeholders = string.Join(',', scoped.Select((_, i) => "$scope" + i));
                where +=
                    scoped.Count == 0 ? " AND 0"
                    : filter.OwnedOnly ? $" AND ownerSessionId IN ({placeholders})"
                    : $" AND (createdBySessionId IN ({placeholders}) OR ownerSessionId IN ({placeholders}))";
            }
            return where;
        }

        private List<JsonObject> Query(
            string sql,
            int? limit,
            string? id,
            TaskListFilter? filter = null
        )
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = sql;
            Bind(cmd, id, filter);
            if (limit is not null)
                Add(cmd, "$limit", limit.Value);
            using var r = cmd.ExecuteReader();
            var result = new List<JsonObject>();
            while (r.Read())
                result.Add(Row(r));
            return result;
        }

        private int Scalar(string sql, string? id, TaskListFilter? filter = null)
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = sql;
            Bind(cmd, id, filter);
            return Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
        }

        private static void Bind(SqliteCommand cmd, string? id, TaskListFilter? filter)
        {
            if (filter?.Status is { } status)
                Add(cmd, "$status", status);
            if (id is not null)
                Add(cmd, "$id", id);
            if (filter?.ScopeIds is { } scopeIds)
                for (var i = 0; i < scopeIds.Count; i++)
                    Add(cmd, "$scope" + i, scopeIds[i]);
        }

        private static JsonObject Row(SqliteDataReader reader)
        {
            var row = new JsonObject();
            for (var i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i)
                    ? null
                    : TaskRowValues.Value(reader.GetValue(i));
            return row;
        }
    }

    private static void Add(SqliteCommand cmd, string name, object? value) =>
        cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);

    private static void Initialize(SqliteConnection db)
    {
        db.ExecuteNonQuery(
            "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; "
                + "CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,status TEXT NOT NULL CHECK(status IN ('open','active','completed','cancelled')),parentTaskId TEXT REFERENCES tasks(id),createdByKind TEXT NOT NULL DEFAULT 'session' CHECK(createdByKind IN ('session','user')),createdBySessionId TEXT,ownerSessionId TEXT,result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,completedAt INTEGER,cancelledAt INTEGER); "
                + "CREATE TABLE IF NOT EXISTS task_notes(id INTEGER PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),authorKind TEXT NOT NULL DEFAULT 'session' CHECK(authorKind IN ('session','user')),sessionId TEXT,text TEXT NOT NULL,createdAt INTEGER NOT NULL);"
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
        MigrateActorColumns(db);
        // Added after the actor migration, which rebuilds the table from its older column set.
        using (var info = db.CreateCommand())
        {
            info.CommandText = "PRAGMA table_info(tasks)";
            var found = false;
            using (var reader = info.ExecuteReader())
                while (reader.Read())
                    if (reader.GetString(1) == "ownerAssignedAt")
                        found = true;
            if (!found)
                db.ExecuteNonQuery("ALTER TABLE tasks ADD COLUMN ownerAssignedAt INTEGER");
        }
        db.ExecuteNonQuery(
            "CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,updatedAt); "
                + "CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parentTaskId,createdAt); "
                + "CREATE INDEX IF NOT EXISTS tasks_self_owned ON tasks(createdBySessionId,ownerSessionId,status,createdAt,id); "
                + "CREATE INDEX IF NOT EXISTS task_notes_task ON task_notes(taskId,id); "
                + "CREATE UNIQUE INDEX IF NOT EXISTS tasks_legacy_goal ON tasks(legacyGoalSessionId);"
        );
    }

    private static void MigrateActorColumns(SqliteConnection db)
    {
        static bool Has(SqliteConnection connection, string table, string column)
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"PRAGMA table_info({table})";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                if (reader.GetString(1) == column)
                    return true;
            return false;
        }
        if (Has(db, "tasks", "createdByKind") && Has(db, "task_notes", "authorKind"))
            return;
        db.ExecuteNonQuery("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
        try
        {
            db.ExecuteNonQuery(
                "DROP INDEX IF EXISTS tasks_status; DROP INDEX IF EXISTS tasks_parent; DROP INDEX IF EXISTS tasks_legacy_goal; DROP INDEX IF EXISTS tasks_self_owned; DROP INDEX IF EXISTS task_notes_task;"
            );
            db.ExecuteNonQuery(
                "ALTER TABLE tasks RENAME TO tasks_actor_legacy; ALTER TABLE task_notes RENAME TO task_notes_actor_legacy;"
            );
            db.ExecuteNonQuery(
                "CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,status TEXT NOT NULL CHECK(status IN ('open','active','completed','cancelled')),parentTaskId TEXT REFERENCES tasks(id),createdByKind TEXT NOT NULL DEFAULT 'session' CHECK(createdByKind IN ('session','user')),createdBySessionId TEXT,ownerSessionId TEXT,result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,completedAt INTEGER,cancelledAt INTEGER,completionNotificationStatus TEXT,assignmentNotificationStatus TEXT,previousOwnerSessionId TEXT,previousOwnerNotificationStatus TEXT,assignmentRevision INTEGER NOT NULL DEFAULT 0,attachedSessionId TEXT,legacyGoalSessionId TEXT,reminderLastSeq INTEGER,reminderMessageCount INTEGER NOT NULL DEFAULT 0);"
            );
            db.ExecuteNonQuery(
                "INSERT INTO tasks(id,title,description,status,parentTaskId,createdByKind,createdBySessionId,ownerSessionId,result,createdAt,updatedAt,completedAt,cancelledAt,completionNotificationStatus,assignmentNotificationStatus,previousOwnerSessionId,previousOwnerNotificationStatus,assignmentRevision,attachedSessionId,legacyGoalSessionId,reminderLastSeq,reminderMessageCount) SELECT id,title,description,status,parentTaskId,'session',createdBySessionId,ownerSessionId,result,createdAt,updatedAt,completedAt,cancelledAt,completionNotificationStatus,assignmentNotificationStatus,previousOwnerSessionId,previousOwnerNotificationStatus,assignmentRevision,attachedSessionId,legacyGoalSessionId,reminderLastSeq,reminderMessageCount FROM tasks_actor_legacy;"
            );
            db.ExecuteNonQuery(
                "CREATE TABLE task_notes(id INTEGER PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),authorKind TEXT NOT NULL DEFAULT 'session' CHECK(authorKind IN ('session','user')),sessionId TEXT,text TEXT NOT NULL,createdAt INTEGER NOT NULL);"
            );
            db.ExecuteNonQuery(
                "INSERT INTO task_notes(id,taskId,authorKind,sessionId,text,createdAt) SELECT id,taskId,'session',sessionId,text,createdAt FROM task_notes_actor_legacy; DROP TABLE task_notes_actor_legacy; DROP TABLE tasks_actor_legacy;"
            );
            db.ExecuteNonQuery("COMMIT; PRAGMA foreign_keys=ON;");
        }
        catch
        {
            try
            {
                db.ExecuteNonQuery("ROLLBACK; PRAGMA foreign_keys=ON;");
            }
            catch { }
            throw;
        }
    }
}
