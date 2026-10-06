using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>Exact persisted evidence and inactive cleanup; never initializes a Worker runtime.</summary>
internal sealed class SessionDeletionWorkerStore(string root)
{
    private string FilePath => Path.Combine(root, "state", "session-runtime.sqlite");

    private SqliteConnection? Open(bool writable = false)
    {
        try
        {
            _ = File.GetAttributes(FilePath);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = FilePath,
                Mode = writable ? SqliteOpenMode.ReadWrite : SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        try
        {
            connection.Open();
            Validate(connection);
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private static SqliteCommand Command(SqliteConnection db, string sql, string? id = null)
    {
        var command = db.CreateCommand();
        command.CommandText = sql;
        if (id is not null)
            command.Parameters.AddWithValue("$id", id);
        return command;
    }

    private static object? Scalar(SqliteConnection db, string sql, string? id = null)
    {
        using var command = Command(db, sql, id);
        return command.ExecuteScalar();
    }

    private static void Execute(SqliteConnection db, string sql, string? id = null)
    {
        using var command = Command(db, sql, id);
        command.ExecuteNonQuery();
    }

    private static void Validate(SqliteConnection db)
    {
        if (Convert.ToInt64(Scalar(db, "PRAGMA user_version")) != 2)
            throw new InvalidDataException("Worker evidence has an unsupported schema version.");
        CheckTable(
            db,
            "session_worker_ownership",
            [
                ("session_id", "TEXT", 1, null, 1),
                ("generation", "INTEGER", 1, "0", 0),
                ("state", "TEXT", 1, "'inactive'", 0),
                ("incarnation_id", "TEXT", 0, null, 0),
                ("worker_pid", "INTEGER", 0, null, 0),
                ("process_identity", "TEXT", 0, null, 0),
                ("activated_at", "INTEGER", 0, null, 0),
                ("mailbox_cursor", "INTEGER", 1, "0", 0),
                ("last_activity_at", "INTEGER", 1, "0", 0),
                ("updated_at", "INTEGER", 1, null, 0),
                ("last_exit_reason", "TEXT", 0, null, 0),
            ],
            [
                "check (state in ('inactive','candidate','ready','draining'))",
                "check (generation >= 0)",
                "check (mailbox_cursor >= 0)",
                "check (last_activity_at >= 0)",
                "check (updated_at >= 0)",
                "state = 'inactive'",
                "state = 'candidate'",
                "state = 'ready'",
                "state = 'draining'",
            ]
        );
        CheckTable(
            db,
            "session_worker_mailbox",
            [
                ("id", "INTEGER", 1, null, 1),
                ("session_id", "TEXT", 1, null, 0),
                ("intent_id", "TEXT", 1, null, 0),
                ("kind", "TEXT", 1, null, 0),
                ("payload_json", "TEXT", 1, null, 0),
                ("created_at", "INTEGER", 1, null, 0),
                ("applied_generation", "INTEGER", 0, null, 0),
                ("applied_incarnation_id", "TEXT", 0, null, 0),
                ("applied_at", "INTEGER", 0, null, 0),
            ],
            [
                "check (created_at >= 0)",
                "applied_generation is null and applied_incarnation_id is null and applied_at is null",
                "applied_at >= created_at",
            ]
        );
        var indexes = new List<(string Name, long Unique, long Partial)>();
        using (var command = Command(db, "PRAGMA index_list(session_worker_mailbox)"))
        using (var rows = command.ExecuteReader())
            while (rows.Read())
                indexes.Add((rows.GetString(1), rows.GetInt64(2), rows.GetInt64(4)));
        string[] Columns(string index)
        {
            var result = new List<string>();
            using var command = Command(
                db,
                "PRAGMA index_info(\"" + index.Replace("\"", "\"\"") + "\")"
            );
            using var rows = command.ExecuteReader();
            while (rows.Read())
                result.Add(rows.GetString(2));
            return result.ToArray();
        }
        if (
            !indexes.Any(index =>
                index.Unique == 1
                && index.Partial == 0
                && Columns(index.Name).SequenceEqual(["session_id", "intent_id"])
            )
        )
            throw new InvalidDataException(
                "Worker evidence lacks the source intent uniqueness boundary."
            );
        var pending = indexes.FirstOrDefault(index =>
            index.Name == "idx_session_worker_mailbox_pending"
        );
        var pendingSql = Normalize(
            Scalar(
                db,
                "SELECT sql FROM sqlite_master WHERE name='idx_session_worker_mailbox_pending'"
            ) as string
                ?? ""
        );
        if (
            pending.Name is null
            || pending.Unique != 0
            || pending.Partial != 1
            || !Columns(pending.Name).SequenceEqual(["session_id", "id"])
            || !pendingSql.EndsWith("where applied_at is null", StringComparison.Ordinal)
        )
            throw new InvalidDataException("Worker pending index is unsupported.");
        if (
            Scalar(
                db,
                """
SELECT session_id FROM session_worker_ownership WHERE generation < 0 OR mailbox_cursor < 0 OR last_activity_at < 0 OR updated_at < 0 OR
(state='inactive' AND (incarnation_id IS NOT NULL OR worker_pid IS NOT NULL OR process_identity IS NOT NULL OR activated_at IS NOT NULL)) OR
(state='candidate' AND (incarnation_id IS NULL OR activated_at IS NOT NULL OR ((worker_pid IS NULL) != (process_identity IS NULL)))) OR
(state='ready' AND (incarnation_id IS NULL OR worker_pid IS NULL OR process_identity IS NULL OR activated_at IS NULL)) OR
(state='draining' AND (incarnation_id IS NULL OR ((process_identity IS NULL) != (activated_at IS NULL)) OR (process_identity IS NOT NULL AND worker_pid IS NULL))) LIMIT 1
"""
            )
            is not null
        )
            throw new InvalidDataException("Worker ownership evidence is invalid.");
        if (
            Scalar(
                db,
                """
SELECT m.id FROM session_worker_mailbox m LEFT JOIN session_worker_ownership o ON o.session_id=m.session_id WHERE
(m.applied_at IS NOT NULL AND o.session_id IS NULL) OR m.created_at < 0 OR
((m.applied_at IS NULL) != (m.applied_generation IS NULL)) OR ((m.applied_at IS NULL) != (m.applied_incarnation_id IS NULL)) OR
(m.applied_at IS NOT NULL AND (m.applied_generation < 0 OR m.applied_at < m.created_at)) OR
(m.applied_at IS NULL AND m.id <= o.mailbox_cursor) OR (m.applied_at IS NOT NULL AND m.id > o.mailbox_cursor) LIMIT 1
"""
            )
            is not null
        )
            throw new InvalidDataException("Worker mailbox evidence is invalid.");
        using var payloads = Command(db, "SELECT payload_json FROM session_worker_mailbox");
        using var values = payloads.ExecuteReader();
        while (values.Read())
        {
            var raw = values.GetString(0);
            try
            {
                if (StableJson(System.Text.Json.Nodes.JsonNode.Parse(raw)) != raw)
                    throw new InvalidDataException("Worker mailbox payload is not canonical.");
            }
            catch (Exception error)
                when (error
                        is System.Text.Json.JsonException
                            or ArgumentException
                            or InvalidOperationException
                )
            {
                throw new InvalidDataException("Worker mailbox payload is invalid.", error);
            }
        }
    }

    private static string StableJson(System.Text.Json.Nodes.JsonNode? node) =>
        node switch
        {
            null => "null",
            System.Text.Json.Nodes.JsonObject map => "{"
                + string.Join(
                    ",",
                    map.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                        .Select(pair =>
                            EcmaJson.Stringify(System.Text.Json.Nodes.JsonValue.Create(pair.Key)!)
                            + ":"
                            + StableJson(pair.Value)
                        )
                )
                + "}",
            System.Text.Json.Nodes.JsonArray array => "["
                + string.Join(",", array.Select(StableJson))
                + "]",
            _ => EcmaJson.Stringify(node),
        };

    private static string Normalize(string text) =>
        System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ").Trim().ToLowerInvariant();

    private static void CheckTable(
        SqliteConnection db,
        string table,
        (string Name, string Type, long Required, string? Default, long Key)[] expected,
        string[] checks
    )
    {
        var actual = new List<(string, string, long, string?, long)>();
        using (var command = Command(db, "PRAGMA table_info(" + table + ")"))
        using (var rows = command.ExecuteReader())
            while (rows.Read())
                actual.Add(
                    (
                        rows.GetString(1),
                        rows.GetString(2),
                        rows.GetInt64(3),
                        rows.IsDBNull(4) ? null : rows.GetString(4),
                        rows.GetInt64(5)
                    )
                );
        if (
            !actual
                .OrderBy(row => row.Item1, StringComparer.Ordinal)
                .SequenceEqual(expected.OrderBy(row => row.Name, StringComparer.Ordinal))
        )
            throw new InvalidDataException("Worker table structure is unsupported.");
        var sql = Normalize(
            Scalar(db, "SELECT sql FROM sqlite_master WHERE name='" + table + "'") as string ?? ""
        );
        if (checks.Any(check => !sql.Contains(check, StringComparison.Ordinal)))
            throw new InvalidDataException("Worker schema constraints are unsupported.");
    }

    internal void Preflight(IEnumerable<string> ids)
    {
        using var db = Open();
        if (db is null)
            return;
        foreach (var id in ids)
            if (
                Scalar(db, "SELECT state FROM session_worker_ownership WHERE session_id=$id", id)
                    is string state
                && state != "inactive"
            )
                throw new SessionDeletionException(
                    "This target has unsupported Worker ownership.",
                    "SESSION_DELETE_WORKER_UNSUPPORTED",
                    409,
                    new System.Text.Json.Nodes.JsonObject
                    {
                        ["sessionId"] = id,
                        ["ownershipState"] = state,
                    }
                );
    }

    internal bool CleanupInactive(string id)
    {
        using var db = Open(true);
        if (db is null)
            return false;
        Execute(db, "PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
        try
        {
            Validate(db);
            var state =
                Scalar(db, "SELECT state FROM session_worker_ownership WHERE session_id=$id", id)
                as string;
            if (state is not null && state != "inactive")
                throw new InvalidDataException("Worker ownership changed before cleanup.");
            if (state is not null)
                Execute(
                    db,
                    "DELETE FROM session_worker_mailbox WHERE session_id=$id; DELETE FROM session_worker_ownership WHERE session_id=$id",
                    id
                );
            Execute(db, "COMMIT");
            return state is not null;
        }
        catch
        {
            Execute(db, "ROLLBACK");
            throw;
        }
    }
}
