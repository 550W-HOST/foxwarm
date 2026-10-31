using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed class ProjectConflictException(string message) : InvalidOperationException(message);

// The workspace catalog owns grouping only. Conversation authority stays with SessionManager.
// Its schema is shared with the Source catalog so existing projects survive Main migration.
internal sealed class ProjectStore(string root) : IDisposable
{
    private readonly object gate = new();
    private SqliteConnection? connection;

    private SqliteConnection Open()
    {
        if (connection is not null)
            return connection;
        var path = Path.Combine(root, "state", "projects.sqlite");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var db = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = path }.ToString()
        );
        db.Open();
        try
        {
            using var version = db.CreateCommand();
            version.CommandText = "PRAGMA user_version";
            if (Convert.ToInt64(version.ExecuteScalar()) is not (0 or 1 or 2))
                throw new InvalidDataException("Unsupported project database version.");
            db.ExecuteNonQuery(
                """
                PRAGMA foreign_keys=ON;
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, node_id TEXT NOT NULL, root_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, UNIQUE(node_id,root_path)
                );
                CREATE TABLE IF NOT EXISTS work_sessions (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
                    created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS work_sessions_project_idx ON work_sessions(project_id,created_at,id);
                CREATE TABLE IF NOT EXISTS work_tabs (
                    id TEXT PRIMARY KEY, work_session_id TEXT NOT NULL REFERENCES work_sessions(id), type TEXT NOT NULL,
                    title TEXT NOT NULL, resource_id TEXT, request_id TEXT UNIQUE, agent_id TEXT, created_at INTEGER NOT NULL,
                    state TEXT NOT NULL DEFAULT 'ready'
                );
                CREATE INDEX IF NOT EXISTS work_tabs_session_idx ON work_tabs(work_session_id,created_at,id);
                CREATE UNIQUE INDEX IF NOT EXISTS work_tabs_agent_resource_idx ON work_tabs(resource_id)
                    WHERE type='agent' AND resource_id IS NOT NULL;
                """
            );
            using var columns = db.CreateCommand();
            columns.CommandText =
                "SELECT COUNT(*) FROM pragma_table_info('work_tabs') WHERE name='agent_id'";
            if (Convert.ToInt64(columns.ExecuteScalar()) == 0)
                db.ExecuteNonQuery("ALTER TABLE work_tabs ADD COLUMN agent_id TEXT");
            db.ExecuteNonQuery("PRAGMA user_version=2");
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            return connection = db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private SqliteCommand Command(string sql, object?[] values)
    {
        var command = Open().CreateCommand();
        command.CommandText = sql;
        for (var i = 0; i < values.Length; i++)
            command.Parameters.AddWithValue("$" + i, values[i] ?? DBNull.Value);
        return command;
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
                row[reader.GetName(i)] = reader.GetValue(i) switch
                {
                    string text => JsonValue.Create(text),
                    long number => JsonValue.Create(number),
                    DBNull => null,
                    _ => throw new InvalidDataException("Invalid project database value."),
                };
            rows.Add(row);
        }
        return rows;
    }

    private int Write(string sql, params object?[] values)
    {
        using var command = Command(sql, values);
        return command.ExecuteNonQuery();
    }

    private static string Text(JsonObject row, string key) => row[key]!.GetValue<string>();

    private static JsonObject Tab(JsonObject row) =>
        new()
        {
            ["id"] = row["id"]!.DeepClone(),
            ["workspaceSessionId"] = row["work_session_id"]!.DeepClone(),
            ["type"] = row["type"]!.DeepClone(),
            ["title"] = row["title"]!.DeepClone(),
            ["resourceId"] = row["resource_id"]?.DeepClone(),
            ["createdAt"] = row["created_at"]!.DeepClone(),
            ["state"] = row["state"]!.DeepClone(),
            ["requestId"] = row["request_id"]?.DeepClone(),
            ["agentId"] = row["agent_id"]?.DeepClone(),
        };

    private JsonObject Session(JsonObject row) =>
        new()
        {
            ["id"] = row["id"]!.DeepClone(),
            ["projectId"] = row["project_id"]!.DeepClone(),
            ["title"] = row["title"]!.DeepClone(),
            ["createdAt"] = row["created_at"]!.DeepClone(),
            ["archived"] = row["archived"]!.GetValue<long>() != 0,
            ["tabs"] = new JsonArray(
                Rows(
                        "SELECT * FROM work_tabs WHERE work_session_id=$0 ORDER BY created_at,id LIMIT 1000",
                        Text(row, "id")
                    )
                    .Select(Tab)
                    .Cast<JsonNode?>()
                    .ToArray()
            ),
        };

    private JsonObject Project(JsonObject row) =>
        new()
        {
            ["id"] = row["id"]!.DeepClone(),
            ["name"] = row["name"]!.DeepClone(),
            ["nodeId"] = row["node_id"]!.DeepClone(),
            ["rootPath"] = row["root_path"]!.DeepClone(),
            ["createdAt"] = row["created_at"]!.DeepClone(),
            ["archived"] = row["archived"]!.GetValue<long>() != 0,
            ["sessions"] = new JsonArray(
                Rows(
                        "SELECT * FROM work_sessions WHERE project_id=$0 ORDER BY created_at,id LIMIT 1000",
                        Text(row, "id")
                    )
                    .Select(Session)
                    .Cast<JsonNode?>()
                    .ToArray()
            ),
        };

    internal JsonArray List(int limit, int offset)
    {
        lock (gate)
            return new(
                Rows(
                        "SELECT * FROM projects ORDER BY created_at,id LIMIT $0 OFFSET $1",
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
            return Rows("SELECT * FROM projects WHERE id=$0", id).FirstOrDefault() is { } row
                ? Project(row)
                : null;
    }

    internal JsonObject? GetSession(string id)
    {
        lock (gate)
            return Rows("SELECT * FROM work_sessions WHERE id=$0", id).FirstOrDefault() is { } row
                ? Session(row)
                : null;
    }

    internal JsonObject? GetTab(string id)
    {
        lock (gate)
            return Rows("SELECT * FROM work_tabs WHERE id=$0", id).FirstOrDefault() is { } row
                ? Tab(row)
                : null;
    }

    internal JsonObject CreateProject(string name, string node, string path)
    {
        lock (gate)
        {
            if (
                Rows("SELECT id FROM projects WHERE node_id=$0 AND root_path=$1", node, path)
                    .FirstOrDefault() is
                { } existing
            )
                return UpdateProject(Text(existing, "id"), archived: false);
            var id = Guid.NewGuid().ToString();
            Write(
                "INSERT INTO projects(id,name,node_id,root_path,created_at) VALUES($0,$1,$2,$3,$4)",
                id,
                name,
                node,
                path,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            return GetProject(id)!;
        }
    }

    internal JsonObject UpdateProject(string id, string? name = null, bool? archived = null)
    {
        lock (gate)
        {
            var existing = GetProject(id) ?? throw new KeyNotFoundException("Project not found.");
            Write(
                "UPDATE projects SET name=$0,archived=$1 WHERE id=$2",
                name ?? Text(existing, "name"),
                (archived ?? existing["archived"]!.GetValue<bool>()) ? 1 : 0,
                id
            );
            return GetProject(id)!;
        }
    }

    internal JsonObject CreateSession(string projectId, string title)
    {
        lock (gate)
        {
            RequireActiveProject(projectId);
            var id = Guid.NewGuid().ToString();
            Write(
                "INSERT INTO work_sessions(id,project_id,title,created_at) VALUES($0,$1,$2,$3)",
                id,
                projectId,
                title,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            return GetSession(id)!;
        }
    }

    internal JsonObject UpdateSession(string id, string? title = null, bool? archived = null)
    {
        lock (gate)
        {
            var existing =
                GetSession(id) ?? throw new KeyNotFoundException("Workspace session not found.");
            Write(
                "UPDATE work_sessions SET title=$0,archived=$1 WHERE id=$2",
                title ?? Text(existing, "title"),
                (archived ?? existing["archived"]!.GetValue<bool>()) ? 1 : 0,
                id
            );
            return GetSession(id)!;
        }
    }

    private void RequireActiveProject(string id)
    {
        if (GetProject(id) is not { } project || project["archived"]!.GetValue<bool>())
            throw new KeyNotFoundException("Project not found or archived.");
    }

    internal JsonObject? FindRequest(string requestId)
    {
        lock (gate)
            return
                Rows("SELECT * FROM work_tabs WHERE request_id=$0", requestId).FirstOrDefault()
                    is { } row
                ? Tab(row)
                : null;
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
            if (GetSession(sessionId) is not { } session || session["archived"]!.GetValue<bool>())
                throw new KeyNotFoundException("Workspace session not found or archived.");
            RequireActiveProject(Text(session, "projectId"));
            if (requestId is not null && FindRequest(requestId) is { } existing)
            {
                if (
                    Text(existing, "workspaceSessionId") != sessionId
                    || Text(existing, "type") != type
                    || (
                        agent is not null
                        && existing["agentId"] is not null
                        && Text(existing, "agentId") != agent
                    )
                )
                    throw new ProjectConflictException(
                        "Request ID already belongs to another tab."
                    );
                return existing;
            }
            var id = Guid.NewGuid().ToString();
            Write(
                "INSERT INTO work_tabs(id,work_session_id,type,title,request_id,agent_id,created_at,state) VALUES($0,$1,$2,$3,$4,$5,$6,$7)",
                id,
                sessionId,
                type,
                title,
                requestId,
                agent,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                type == "agent" ? "pending" : "ready"
            );
            return GetTab(id)!;
        }
    }

    internal JsonObject LinkExisting(
        string session,
        string title,
        string? request,
        string resource,
        string agent
    )
    {
        lock (gate)
        {
            Open().ExecuteNonQuery("BEGIN IMMEDIATE");
            try
            {
                var tab = CreateTab(session, "agent", title, request, agent);
                if (tab["resourceId"] is not null && Text(tab, "resourceId") != resource)
                    throw new ProjectConflictException(
                        "Request ID was already used with a different Agent session."
                    );
                if (
                    Rows(
                        "SELECT id FROM work_tabs WHERE type='agent' AND resource_id=$0 AND id<>$1",
                        resource,
                        Text(tab, "id")
                    ).Count > 0
                )
                    throw new ProjectConflictException(
                        "Agent session already belongs to another workspace."
                    );
                var linked = UpdateTab(Text(tab, "id"), resource: resource, state: "ready");
                Open().ExecuteNonQuery("COMMIT");
                return linked;
            }
            catch
            {
                Open().ExecuteNonQuery("ROLLBACK");
                throw;
            }
        }
    }

    internal JsonObject UpdateTab(
        string id,
        string? title = null,
        string? resource = null,
        string? state = null
    )
    {
        lock (gate)
        {
            var existing = GetTab(id) ?? throw new KeyNotFoundException("Tab not found.");
            Write(
                "UPDATE work_tabs SET title=$0,resource_id=$1,state=$2 WHERE id=$3",
                title ?? Text(existing, "title"),
                resource ?? SessionWait.Text(existing["resourceId"]),
                state ?? Text(existing, "state"),
                id
            );
            return GetTab(id)!;
        }
    }

    internal bool DeleteTab(string id)
    {
        lock (gate)
            return Write("DELETE FROM work_tabs WHERE id=$0", id) > 0;
    }

    public void Dispose()
    {
        lock (gate)
        {
            connection?.Dispose();
            connection = null;
        }
    }
}
