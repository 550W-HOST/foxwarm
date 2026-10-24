using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog : IDisposable
{
    private readonly object gate = new();
    private readonly string root;
    private SqliteConnection? db;
    private string? readerConnectionString;
    private long revision = 1;
    private readonly string instance = Guid.NewGuid().ToString("N");
    internal string FilePath => Path.Combine(root, "state", "catalog.sqlite");
    internal string Revision
    {
        get
        {
            lock (gate)
            {
                EnsureInitialized();
                return instance + ":" + revision;
            }
        }
    }
    internal event Action? Changed;

    // Test observation is scoped to this real SQL owner, not a substitute implementation.
    internal Action<string, int>? QueryObserved { get; set; }
    internal Action<string>? BeforeAuthorityProjection { get; set; }

    internal SessionCatalog(string root) => this.root = Path.GetFullPath(root);

    internal void Initialize()
    {
        lock (gate)
            EnsureInitialized();
    }

    private void Open()
    {
        if (db is not null)
            return;
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = FilePath, Pooling = false }.ToString()
        );
        connection.Open();
        try
        {
            var version = Convert.ToInt32(Scalar(connection, "PRAGMA user_version"));
            if (version == 1)
            {
                Execute(connection, MigrateV1Sql);
                version = 2;
            }
            if (version == 2)
            {
                Execute(connection, MigrateV2Sql);
                version = 3;
            }
            if (version != 3)
                throw new InvalidDataException(
                    $"Unsupported Session catalog schema version {version}."
                );
            Execute(
                connection,
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON"
            );
            Execute(connection, WaitPresenceIndexSql);
            db = connection;
            Volatile.Write(
                ref readerConnectionString,
                new SqliteConnectionStringBuilder
                {
                    DataSource = FilePath,
                    Mode = SqliteOpenMode.ReadOnly,
                    Pooling = true,
                    DefaultTimeout = 5,
                }.ToString()
            );
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private static SqliteCommand Command(
        SqliteConnection connection,
        string sql,
        params object?[] args
    )
    {
        var command = connection.CreateCommand();
        for (var index = 0; index < args.Length; index++)
            command.Parameters.AddWithValue("$p" + index, args[index] ?? DBNull.Value);
        // SQL in this owner uses numbered parameters, including bounded repeated-ID batches.
        command.CommandText = sql;
        return command;
    }

    private static void Execute(SqliteConnection connection, string sql, params object?[] args)
    {
        using var command = Command(connection, sql, args);
        command.ExecuteNonQuery();
    }

    private static object? Scalar(SqliteConnection connection, string sql, params object?[] args)
    {
        using var command = Command(connection, sql, args);
        return command.ExecuteScalar();
    }

    private static string Parameters(int count, int start = 0) =>
        string.Join(',', Enumerable.Range(start, count).Select(index => "$p" + index));

    private List<JsonObject> Rows(string sql, params object?[] args)
    {
        EnsureInitialized();
        return Rows(db!, sql, args);
    }

    private List<JsonObject> Rows(SqliteConnection connection, string sql, params object?[] args)
    {
        using var command = Command(connection, sql, args);
        using var reader = command.ExecuteReader();
        var rows = new List<JsonObject>();
        while (reader.Read())
        {
            var row = JsonNode.Parse(reader.GetString(0))!.AsObject();
            if (reader.FieldCount > 1)
            {
                row["busy"] = reader.GetInt64(1) == 1;
                row["queueLength"] = reader.GetInt64(2);
                row["managedPendingCount"] = reader.GetInt64(3);
            }
            rows.Add(row);
        }
        QueryObserved?.Invoke(sql, rows.Count);
        return rows;
    }

    private const string Columns = "metadata_json,busy,queue_length,managed_pending_count";

    // Each ordinary exact read leases its own provider-pooled connection. The writer's
    // connection and transaction remain exclusively owned by gate, including nested reads.
    private SqliteConnection OpenReader()
    {
        var connectionString = Volatile.Read(ref readerConnectionString);
        if (connectionString is null)
        {
            lock (gate)
            {
                EnsureInitialized();
                connectionString = readerConnectionString!;
            }
        }
        var connection = new SqliteConnection(connectionString);
        try
        {
            connection.Open();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    internal JsonObject? Get(string id)
    {
        if (Monitor.IsEntered(gate))
            return Rows($"SELECT {Columns} FROM session_catalog WHERE session_id=$p0", id)
                .FirstOrDefault();
        using var connection = OpenReader();
        return Rows(connection, $"SELECT {Columns} FROM session_catalog WHERE session_id=$p0", id)
            .FirstOrDefault();
    }

    internal JsonObject[] GetMany(IEnumerable<string> requested)
    {
        var ids = requested.Distinct(StringComparer.Ordinal).ToArray();
        if (ids.Length > 200)
            throw new InvalidDataException("Catalog exact batch exceeds 200 IDs.");
        if (ids.Length == 0)
            return [];
        lock (gate)
        {
            var rows = Rows(
                $"SELECT {Columns} FROM session_catalog WHERE session_id IN ({Parameters(ids.Length)})",
                ids.Cast<object?>().ToArray()
            );
            var byId = rows.ToDictionary(row => Text(row["id"])!, StringComparer.Ordinal);
            return ids.Where(byId.ContainsKey).Select(id => byId[id]).ToArray();
        }
    }

    internal JsonObject[] List(int limit = int.MaxValue, int offset = 0)
    {
        lock (gate)
            return Rows(
                    $"SELECT {Columns} FROM session_catalog ORDER BY recent_rank,session_id LIMIT $p0 OFFSET $p1",
                    limit,
                    offset
                )
                .ToArray();
    }

    internal JsonObject Resolve(string requested)
    {
        if (Monitor.IsEntered(gate))
        {
            EnsureInitialized();
            return Resolve(db!, requested);
        }
        using var connection = OpenReader();
        return Resolve(connection, requested);
    }

    private static JsonObject Resolve(SqliteConnection connection, string requested)
    {
        // One statement gives exact precedence and alias ambiguity one SQLite snapshot.
        using var command = Command(
            connection,
            "SELECT session_id,1 AS exact FROM session_catalog WHERE session_id=$p0 "
                + "UNION ALL SELECT session_id,0 FROM session_alias WHERE alias=$p0 "
                + "AND NOT EXISTS(SELECT 1 FROM session_catalog WHERE session_id=$p0) "
                + "ORDER BY exact DESC,session_id LIMIT 2",
            requested
        );
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return new JsonObject { ["kind"] = "missing" };
        var first = reader.GetString(0);
        if (reader.GetInt64(1) == 1)
            return new JsonObject { ["kind"] = "exact", ["sessionId"] = first };
        return reader.Read()
            ? new JsonObject
            {
                ["kind"] = "ambiguous",
                ["sessionIds"] = new JsonArray(first, reader.GetString(0)),
            }
            : new JsonObject { ["kind"] = "alias", ["sessionId"] = first };
    }

    internal JsonObject? Presentation(string id)
    {
        lock (gate)
        {
            var row = Get(id);
            if (row is null)
                return null;
            row["parentSessionId"] = Scalar(
                db!,
                "SELECT parent_session_id FROM session_catalog WHERE session_id=$p0",
                id
            )
                is string parent
                ? parent
                : null;
            return row;
        }
    }

    internal string[] PathIds(string id)
    {
        lock (gate)
        {
            EnsureInitialized();
            var result = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            while (seen.Add(id) && Get(id) is not null)
            {
                result.Add(id);
                if (
                    Scalar(
                        db!,
                        "SELECT parent_session_id FROM session_catalog WHERE session_id=$p0",
                        id
                    )
                    is not string parent
                )
                    break;
                id = parent;
            }
            result.Reverse();
            return result.ToArray();
        }
    }

    internal void Upsert(IEnumerable<JsonObject> input)
    {
        var records = input.Select(Project).ToArray();
        lock (gate)
            UpsertLocked(records);
        Changed?.Invoke();
    }

    private void UpsertLocked(JsonObject[] records)
    {
        EnsureInitialized();
        Execute(db!, "BEGIN IMMEDIATE");
        try
        {
            WriteRowsLocked(records);
            Execute(db!, "COMMIT");
            revision++;
        }
        catch
        {
            Execute(db!, "ROLLBACK");
            throw;
        }
    }

    private void WriteRowsLocked(JsonObject[] records)
    {
        var references = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in records)
        {
            var id = Text(row["id"])!;
            references.Add(id);
            if (Text(row["parentSessionId"]) is { } parentReference)
                references.Add(parentReference);
            using (
                var command = Command(
                    db!,
                    "SELECT alias FROM session_alias WHERE session_id=$p0",
                    id
                )
            )
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    references.Add(reader.GetString(0));
            Insert(db!, row);
            foreach (var alias in row["aliases"]!.AsArray())
                references.Add(Text(alias)!);
        }
        NormalizeParents(db!, references);
    }

    internal void PublishAuthority(JsonObject authority, bool allowInsert = false)
    {
        var id = Text(authority["id"])!;
        BeforeAuthorityProjection?.Invoke(id);
        lock (gate)
        {
            if (Get(id) is { } main)
                OverlayMain(authority, main);
            else if (!allowInsert)
                throw new InvalidOperationException(
                    "Session catalog membership is no longer current."
                );
            UpsertLocked([Project(authority)]);
        }
        Changed?.Invoke();
    }

    internal void Rename(string id, string? name)
    {
        lock (gate)
        {
            var row = Get(id) ?? throw new InvalidDataException("Session not found.");
            if (name is null)
                row.Remove("displayName");
            else
                row["displayName"] = name;
            UpsertLocked([row]);
        }
        Changed?.Invoke();
    }

    private static void Insert(SqliteConnection connection, JsonObject row)
    {
        var fields = new[]
        {
            "session_id",
            "agent",
            "parent_reference",
            "parent_session_id",
            "display_name",
            "archived",
            "pinned",
            "sidebar_order",
            "last_message_time",
            "message_count",
            "busy",
            "queue_length",
            "managed_pending_count",
            "current_node",
            "cwd",
            "vector_index_position",
            "cached_tokens",
            "input_tokens",
            "output_tokens",
            "cost",
            "metadata_json",
        };
        var id = Text(row["id"])!;
        var values = new object?[]
        {
            id,
            Text(row["agent"]),
            Text(row["parentSessionId"]),
            Text(row["parentSessionId"]),
            Text(row["displayName"]),
            Flag(row["archived"]) ? 1 : 0,
            Flag(row["pinned"]) ? 1 : 0,
            Number(row["sidebarOrder"]),
            Number(row["meta"]?["lastMessageTime"]) ?? 0,
            Number(row["meta"]?["messageCount"]) ?? 0,
            Flag(row["busy"]) ? 1 : 0,
            Number(row["queueLength"]) ?? 0,
            Number(row["managedPendingCount"]) ?? 0,
            Text(row["currentNode"]),
            Text(row["cwd"]),
            Number(row["vectorIndexPosition"]),
            Number(row["stats"]?["totalCachedTokens"]) ?? 0,
            Number(row["stats"]?["totalInputTokens"]) ?? 0,
            Number(row["stats"]?["totalOutputTokens"]) ?? 0,
            Number(row["stats"]?["totalCost"]),
            row.ToJsonString(),
        };
        Execute(
            connection,
            $"INSERT INTO session_catalog({string.Join(',', fields)}) VALUES({Parameters(fields.Length)}) ON CONFLICT(session_id) DO UPDATE SET "
                + string.Join(',', fields.Skip(1).Select(field => field + "=excluded." + field)),
            values
        );
        Execute(connection, "DELETE FROM session_alias WHERE session_id=$p0", id);
        var ordinal = 0;
        foreach (var alias in row["aliases"]!.AsArray())
            Execute(
                connection,
                "INSERT INTO session_alias(alias,session_id,ordinal) VALUES($p0,$p1,$p2)",
                Text(alias),
                id,
                ordinal++
            );
    }

    private static void NormalizeParents(
        SqliteConnection connection,
        HashSet<string>? references = null
    )
    {
        if (references?.Count == 0)
            return;
        var args = references?.Cast<object?>().ToArray() ?? [];
        using var command = Command(
            connection,
            "SELECT session_id,parent_reference FROM session_catalog"
                + (
                    references is null
                        ? ""
                        : $" WHERE parent_reference IN ({Parameters(args.Length)})"
                ),
            args
        );
        var rows = new List<(string Id, string? Reference)>();
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                rows.Add((reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)));
        foreach (var (id, reference) in rows)
        {
            string? canonical = null;
            if (!string.IsNullOrEmpty(reference))
            {
                if (
                    Scalar(
                        connection,
                        "SELECT session_id FROM session_catalog WHERE session_id=$p0",
                        reference
                    )
                    is string exact
                )
                    canonical = exact;
                else
                {
                    using var aliasCommand = Command(
                        connection,
                        "SELECT session_id FROM session_alias WHERE alias=$p0 ORDER BY session_id LIMIT 2",
                        reference
                    );
                    using var reader = aliasCommand.ExecuteReader();
                    if (reader.Read())
                    {
                        var first = reader.GetString(0);
                        if (!reader.Read())
                            canonical = first;
                    }
                }
            }
            if (canonical == id)
                canonical = null;
            Execute(
                connection,
                "UPDATE session_catalog SET parent_session_id=$p0 WHERE session_id=$p1 AND parent_session_id IS NOT $p0",
                canonical,
                id
            );
        }
    }

    internal string[] Explain(string sql, params object?[] args)
    {
        lock (gate)
        {
            EnsureInitialized();
            using var command = Command(db!, "EXPLAIN QUERY PLAN " + sql, args);
            using var reader = command.ExecuteReader();
            var lines = new List<string>();
            while (reader.Read())
                lines.Add(reader.GetString(3));
            return lines.ToArray();
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            var connectionString = readerConnectionString;
            Volatile.Write(ref readerConnectionString, null);
            db?.Dispose();
            db = null;
            if (connectionString is not null)
            {
                using var reader = new SqliteConnection(connectionString);
                SqliteConnection.ClearPool(reader);
            }
        }
    }
}
