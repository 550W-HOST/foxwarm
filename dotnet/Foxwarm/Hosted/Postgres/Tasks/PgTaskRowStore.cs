using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres;

internal sealed class PgTaskRowStore(TenantDb database) : ITaskRowStore
{
    // The two-int advisory key is (tenant, store). Direct writes share the same lock so they
    // cannot interleave with a write callback, but release it after each statement.
    private const int TaskWriterLock = 400;

    public bool Exists => database.Read(tx => tx.Scalar("SELECT 1 FROM tasks LIMIT 1") is not null);

    public T Run<T>(TaskRowAccess access, Func<ITaskRows, T> body) =>
        access switch
        {
            TaskRowAccess.Direct => body(new Rows(database)),
            TaskRowAccess.Read => database.Read(tx => body(new Rows(database, tx)), snapshot: true),
            TaskRowAccess.Write => Write(database, tx => body(new Rows(database, tx))),
            _ => throw new ArgumentOutOfRangeException(nameof(access)),
        };

    public void Dispose() { }

    private static T Write<T>(TenantDb database, Func<PgTx, T> body)
    {
        string? xid = null;
        return database.Write(
            tx =>
            {
                using (var command = tx.Command(
                    "SELECT pg_advisory_xact_lock($1, $2), pg_current_xact_id()::text",
                    tx.TenantId,
                    TaskWriterLock
                ))
                using (var row = command.ExecuteReader())
                {
                    row.Read();
                    xid = row.GetString(1);
                }
                return body(tx);
            },
            new PgWriteOptions(Verify: tx =>
                tx.Scalar("SELECT pg_xact_status($1::xid8)", xid) switch
                {
                    "committed" => true,
                    "aborted" => false,
                    _ => throw new InvalidOperationException("The Task transaction outcome is unavailable."),
                }
            )
        );
    }

    private sealed class Rows(TenantDb database, PgTx? transaction = null) : ITaskRows
    {
        private const string ListPredicate = """
            WHERE (($1::text IS NULL AND status IN ('open','active')) OR status = $1)
              AND ($2::text[] IS NULL OR "ownerSessionId" = ANY($2)
                OR (NOT $3 AND "createdBySessionId" = ANY($2)))
            """;

        public JsonObject? Read(string id) =>
            Query("SELECT * FROM tasks WHERE id = $1", id).SingleOrDefault();

        public void Insert(params object?[] columnValues)
        {
            var columns = new List<string>();
            var values = new List<object?>();
            for (var i = 0; i < columnValues.Length; i += 2)
            {
                columns.Add(Identifier((string)columnValues[i]!));
                values.Add(columnValues[i + 1]);
            }
            var parameters = Enumerable.Range(1, values.Count).Select(i => $"${i}");
            Execute(
                $"INSERT INTO tasks ({string.Join(',', columns)}) VALUES ({string.Join(',', parameters)})",
                values.ToArray()
            );
        }

        public void Update(string id, params object?[] columnValues)
        {
            var sets = new List<string>();
            var values = new List<object?> { id };
            for (var i = 0; i < columnValues.Length; i += 2)
            {
                values.Add(columnValues[i + 1]);
                sets.Add($"{Identifier((string)columnValues[i]!)} = ${values.Count}");
            }
            Execute($"UPDATE tasks SET {string.Join(',', sets)} WHERE id = $1", values.ToArray());
        }

        public void SettlePendingNotification(string id, string column, string status, long? revision)
        {
            var field = Identifier(column);
            var sql = $"UPDATE tasks SET {field} = $2 WHERE id = $1 AND {field} = 'pending'";
            if (revision is { } value)
                Execute(sql + " AND \"assignmentRevision\" = $3", id, status, value);
            else
                Execute(sql, id, status);
        }

        public void AddNote(string taskId, string? sessionId, string authorKind, string text, long createdAt) =>
            Execute(
                """
                INSERT INTO task_notes ("taskId", "authorKind", "sessionId", text, "createdAt")
                VALUES ($1, $2, $3, $4, $5)
                """,
                taskId, authorKind, sessionId, text, createdAt
            );

        public string? FindLegacyGoal(IReadOnlyList<string> sessionReferences) =>
            Read(tx => (string?)tx.Scalar(
                """
                SELECT id FROM tasks WHERE "legacyGoalSessionId" = ANY($1::text[])
                ORDER BY "createdAt" ASC NULLS FIRST, id ASC NULLS FIRST LIMIT 1
                """,
                (object)sessionReferences.ToArray()
            ));

        public List<JsonObject> ActiveTasks() => Query(
            """
            SELECT * FROM tasks WHERE status = 'active'
            ORDER BY "createdAt" ASC NULLS FIRST, id ASC NULLS FIRST
            """
        );

        public List<JsonObject> List(TaskListFilter filter, int limit) => Query(
            """
            SELECT id, title, status, "parentTaskId", "createdByKind", "createdBySessionId", "ownerSessionId", "updatedAt"
            FROM tasks
            """
                + " " + ListPredicate + " "
                + """ORDER BY "updatedAt" DESC NULLS LAST, id ASC NULLS FIRST LIMIT $4""",
            filter.Status, filter.ScopeIds?.ToArray(), filter.OwnedOnly, limit
        );

        public int Count(TaskListFilter filter) =>
            Count("SELECT count(*) FROM tasks " + ListPredicate,
                filter.Status, filter.ScopeIds?.ToArray(), filter.OwnedOnly);

        public List<JsonObject> Children(string parentId, int limit) => Query(
            """
            SELECT id, title, status, "ownerSessionId" FROM tasks WHERE "parentTaskId" = $1
            ORDER BY "createdAt" ASC NULLS FIRST, id ASC NULLS FIRST LIMIT $2
            """,
            parentId, limit
        );

        public int ChildCount(string parentId) =>
            Count("""SELECT count(*) FROM tasks WHERE "parentTaskId" = $1""", parentId);

        public List<JsonObject> LatestNotes(string taskId, int limit) => Query(
            """
            SELECT "authorKind", "sessionId", text, "createdAt" FROM task_notes WHERE "taskId" = $1
            ORDER BY id DESC NULLS LAST LIMIT $2
            """,
            taskId, limit
        );

        public int NoteCount(string taskId) =>
            Count("""SELECT count(*) FROM task_notes WHERE "taskId" = $1""", taskId);

        private static string Identifier(string column) => "\"" + column.Replace("\"", "\"\"") + "\"";

        private T Read<T>(Func<PgTx, T> body) =>
            transaction is { } tx ? body(tx) : database.Read(body);

        private void Execute(string sql, params object?[] args)
        {
            if (transaction is { } tx)
                tx.Execute(sql, args);
            else
                Write(database, tx => tx.Execute(sql, args));
        }

        private int Count(string sql, params object?[] args) =>
            Read(tx => Convert.ToInt32(tx.Scalar(sql, args), CultureInfo.InvariantCulture));

        private List<JsonObject> Query(string sql, params object?[] args) => Read(tx =>
        {
            using var command = tx.Command(sql, args);
            using var reader = command.ExecuteReader();
            var result = new List<JsonObject>();
            while (reader.Read())
            {
                var row = new JsonObject();
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    var column = reader.GetName(i);
                    if (column != "tenant_id")
                        row[column] = reader.IsDBNull(i) ? null : TaskRowValues.Value(reader.GetValue(i));
                }
                result.Add(row);
            }
            return result;
        });
    }
}
