using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Projects;

// Presentation membership only. Conversation authority stays in Session storage.
internal sealed class ProjectStore : IDisposable
{
    private readonly object gate = new();
    private readonly SqliteConnection db;

    internal ProjectStore(string file)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        db = new(
            new SqliteConnectionStringBuilder { DataSource = file, Pooling = false }.ToString()
        );
        db.Open();
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        using var version = Command("PRAGMA user_version");
        if (Convert.ToInt32(version.ExecuteScalar()) is not (0 or 1 or 2))
            throw new InvalidDataException("Unsupported project database version.");
        db.ExecuteNonQuery(
            """
            PRAGMA foreign_keys=ON;
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, node_id TEXT NOT NULL, root_path TEXT NOT NULL,
                created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
                UNIQUE(node_id, root_path)
            );
            CREATE TABLE IF NOT EXISTS work_sessions (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
                created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS work_sessions_project_idx ON work_sessions(project_id, created_at, id);
            CREATE TABLE IF NOT EXISTS work_tabs (
                id TEXT PRIMARY KEY, work_session_id TEXT NOT NULL REFERENCES work_sessions(id), type TEXT NOT NULL,
                title TEXT NOT NULL, resource_id TEXT, request_id TEXT UNIQUE, agent_id TEXT, created_at INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'ready'
            );
            CREATE INDEX IF NOT EXISTS work_tabs_session_idx ON work_tabs(work_session_id, created_at, id);
            CREATE UNIQUE INDEX IF NOT EXISTS work_tabs_agent_resource_idx ON work_tabs(resource_id)
                WHERE type='agent' AND resource_id IS NOT NULL;
            """
        );
        if (!Rows("PRAGMA table_info(work_tabs)").Any(row => Text(row, "name") == "agent_id"))
            db.ExecuteNonQuery("ALTER TABLE work_tabs ADD COLUMN agent_id TEXT");
        db.ExecuteNonQuery("PRAGMA user_version=2");
    }

    internal static string? Text(JsonObject row, string name) => SessionWait.Text(row[name]);

    private static bool Archived(JsonObject row) => row["archived"]?.GetValue<bool>() == true;

    private static string NewId() => Guid.NewGuid().ToString();

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private SqliteCommand Command(string sql, params object?[] values)
    {
        var command = db.CreateCommand();
        command.CommandText = sql;
        for (var i = 0; i < values.Length; i++)
            command.Parameters.AddWithValue("$p" + i, values[i] ?? DBNull.Value);
        return command;
    }

    private void Write(string sql, params object?[] values)
    {
        using var command = Command(sql, values);
        command.ExecuteNonQuery();
    }

    private List<JsonObject> Rows(string sql, params object?[] values)
    {
        using var command = Command(sql, values);
        using var reader = command.ExecuteReader();
        var rows = new List<JsonObject>();
        while (reader.Read())
        {
            var row = new JsonObject();
            for (var i = 0; i < reader.FieldCount; i++)
            {
                if (reader.IsDBNull(i))
                    continue;
                var name = reader.GetName(i);
                var key = name switch
                {
                    "node_id" => "nodeId",
                    "root_path" => "rootPath",
                    "created_at" => "createdAt",
                    "project_id" => "projectId",
                    "work_session_id" => "workspaceSessionId",
                    "resource_id" => "resourceId",
                    "request_id" => "requestId",
                    "agent_id" => "agentId",
                    _ => name,
                };
                row[key] =
                    name == "archived"
                        ? JsonValue.Create(reader.GetInt64(i) != 0)
                        : JsonSerializerNode(reader.GetValue(i));
            }
            rows.Add(row);
        }
        return rows;
    }

    private static JsonNode? JsonSerializerNode(object value) =>
        System.Text.Json.JsonSerializer.SerializeToNode(value);

    private JsonObject Session(JsonObject row)
    {
        row["tabs"] = new JsonArray(
            Rows(
                    "SELECT * FROM work_tabs WHERE work_session_id=$p0 ORDER BY created_at,id LIMIT 1000",
                    Text(row, "id")
                )
                .Cast<JsonNode?>()
                .ToArray()
        );
        return row;
    }

    private JsonObject Project(JsonObject row)
    {
        row["sessions"] = new JsonArray(
            Rows(
                    "SELECT * FROM work_sessions WHERE project_id=$p0 ORDER BY created_at,id LIMIT 1000",
                    Text(row, "id")
                )
                .Select(Session)
                .Cast<JsonNode?>()
                .ToArray()
        );
        return row;
    }

    internal JsonArray List(int limit, int offset)
    {
        lock (gate)
            return new(
                Rows(
                        "SELECT * FROM projects ORDER BY created_at,id LIMIT $p0 OFFSET $p1",
                        limit,
                        offset
                    )
                    .Select(Project)
                    .Cast<JsonNode?>()
                    .ToArray()
            );
    }

    internal JsonObject? GetProject(string id)
    {
        lock (gate)
            return Rows("SELECT * FROM projects WHERE id=$p0", id).Select(Project).FirstOrDefault();
    }

    internal JsonObject? GetSession(string id)
    {
        lock (gate)
            return Rows("SELECT * FROM work_sessions WHERE id=$p0", id)
                .Select(Session)
                .FirstOrDefault();
    }

    internal JsonObject? GetTab(string id)
    {
        lock (gate)
            return Rows("SELECT * FROM work_tabs WHERE id=$p0", id).FirstOrDefault();
    }

    internal JsonObject? FindRequest(string request)
    {
        lock (gate)
            return Rows("SELECT * FROM work_tabs WHERE request_id=$p0", request).FirstOrDefault();
    }

    internal JsonObject CreateProject(string name, string node, string root)
    {
        lock (gate)
        {
            var existing = Rows(
                    "SELECT id FROM projects WHERE node_id=$p0 AND root_path=$p1",
                    node,
                    root
                )
                .FirstOrDefault();
            var id = existing is null ? NewId() : Text(existing, "id")!;
            if (existing is null)
                Write(
                    "INSERT INTO projects(id,name,node_id,root_path,created_at) VALUES($p0,$p1,$p2,$p3,$p4)",
                    id,
                    name,
                    node,
                    root,
                    Now()
                );
            else
                Write("UPDATE projects SET archived=0 WHERE id=$p0", id);
            return GetProject(id)!;
        }
    }

    internal JsonObject UpdateProject(string id, string? name, bool? archived)
    {
        lock (gate)
        {
            var old = GetProject(id) ?? throw new InvalidDataException("Project not found.");
            Write(
                "UPDATE projects SET name=$p0,archived=$p1 WHERE id=$p2",
                name ?? Text(old, "name"),
                archived ?? Archived(old),
                id
            );
            return GetProject(id)!;
        }
    }

    internal JsonObject CreateSession(string projectId, string title)
    {
        lock (gate)
        {
            var project = GetProject(projectId);
            if (project is null || Archived(project))
                throw new InvalidDataException("Project not found or archived.");
            var id = NewId();
            Write(
                "INSERT INTO work_sessions(id,project_id,title,created_at) VALUES($p0,$p1,$p2,$p3)",
                id,
                projectId,
                title,
                Now()
            );
            return GetSession(id)!;
        }
    }

    internal JsonObject UpdateSession(string id, string? title, bool? archived)
    {
        lock (gate)
        {
            var old =
                GetSession(id) ?? throw new InvalidDataException("Workspace session not found.");
            Write(
                "UPDATE work_sessions SET title=$p0,archived=$p1 WHERE id=$p2",
                title ?? Text(old, "title"),
                archived ?? Archived(old),
                id
            );
            return GetSession(id)!;
        }
    }

    internal JsonObject CreateTab(
        string sessionId,
        string type,
        string title,
        string? requestId,
        string? agent
    )
    {
        lock (gate)
        {
            var session = GetSession(sessionId);
            if (session is null || Archived(session))
                throw new InvalidDataException("Workspace session not found or archived.");
            var project = GetProject(Text(session, "projectId")!);
            if (project is null || Archived(project))
                throw new InvalidDataException("Project not found or archived.");
            if (requestId is not null && FindRequest(requestId) is { } old)
            {
                if (
                    Text(old, "workspaceSessionId") != sessionId
                    || Text(old, "type") != type
                    || agent is not null
                        && Text(old, "agentId") is { } oldAgent
                        && oldAgent != agent
                )
                    throw new InvalidDataException("Request ID already belongs to another tab.");
                return old;
            }
            var id = NewId();
            Write(
                """
                INSERT INTO work_tabs(id,work_session_id,type,title,request_id,agent_id,created_at,state)
                VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,$p7)
                """,
                id,
                sessionId,
                type,
                title,
                requestId,
                agent,
                Now(),
                type == "agent" ? "pending" : "ready"
            );
            return GetTab(id)!;
        }
    }

    internal JsonObject LinkExisting(
        string sessionId,
        string title,
        string? requestId,
        string resourceId,
        string agent
    )
    {
        lock (gate)
        {
            db.ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var tab = CreateTab(sessionId, "agent", title, requestId, agent);
                var id = Text(tab, "id")!;
                if (Text(tab, "resourceId") is { } previous && previous != resourceId)
                    throw new InvalidDataException(
                        "Request ID was already used with a different Agent session."
                    );
                if (
                    Rows(
                        "SELECT id FROM work_tabs WHERE type='agent' AND resource_id=$p0 AND id<>$p1",
                        resourceId,
                        id
                    ).Count > 0
                )
                    throw new InvalidDataException(
                        "Agent session already belongs to another workspace."
                    );
                var linked = UpdateTab(id, null, resourceId, "ready");
                db.ExecuteNonQuery("COMMIT");
                return linked;
            }
            catch
            {
                db.ExecuteNonQuery("ROLLBACK");
                throw;
            }
        }
    }

    internal JsonObject UpdateTab(
        string id,
        string? title = null,
        string? resourceId = null,
        string? state = null
    )
    {
        lock (gate)
        {
            var old = GetTab(id) ?? throw new InvalidDataException("Tab not found.");
            Write(
                "UPDATE work_tabs SET title=$p0,resource_id=$p1,state=$p2 WHERE id=$p3",
                title ?? Text(old, "title"),
                resourceId ?? Text(old, "resourceId"),
                state ?? Text(old, "state"),
                id
            );
            return GetTab(id)!;
        }
    }

    internal void DeleteTab(string id)
    {
        lock (gate)
        {
            using var command = Command("DELETE FROM work_tabs WHERE id=$p0", id);
            if (command.ExecuteNonQuery() == 0)
                throw new InvalidDataException("Tab not found.");
        }
    }

    public void Dispose()
    {
        lock (gate)
            db.Dispose();
    }
}
