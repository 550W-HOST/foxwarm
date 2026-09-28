using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.SessionPersistence;

public sealed record ArchiveMessageRecord(
    string SessionId,
    string Agent,
    long Seq,
    double Timestamp,
    string Role,
    JsonObject Message,
    string MessageJson)
{
    public static ArchiveMessageRecord Create(string sessionId, string agent, long seq, double timestamp, JsonObject message)
    {
        var role = message["role"]?.GetValue<string>()
            ?? throw new InvalidDataException("Archive message role is required.");
        SessionAuthorityDocument.ValidateMessage(message, checked((int)seq), $"archive message {seq}");
        ValidateArchiveShape(message, seq);
        var messageJson = EcmaJson.Stringify(message);
        return new ArchiveMessageRecord(sessionId, agent, seq, timestamp, role, (JsonObject)message.DeepClone(), messageJson);
    }

    internal static ArchiveMessageRecord FromStored(
        string sessionId, string agent, long seq, double timestamp, string role, string messageJson)
    {
        JsonObject message;
        try { message = JsonNode.Parse(messageJson) as JsonObject ?? throw new JsonException(); }
        catch (JsonException error) { throw new InvalidDataException($"Archive message {sessionId}#{seq} has invalid message_json.", error); }
        SessionAuthorityDocument.ValidateMessage(message, checked((int)seq), $"archive message {seq}");
        ValidateArchiveShape(message, seq);
        if (message["role"]?.GetValue<string>() != role)
            throw new InvalidDataException($"Archive message {sessionId}#{seq} role does not match message_json.");
        var meta = (JsonObject)message["__meta"]!;
        var innerTimestamp = SessionAuthorityDocument.ReadFiniteNumber(meta["timestamp"]!, $"archive message {sessionId}#{seq} timestamp");
        if (innerTimestamp != timestamp)
            throw new InvalidDataException($"Archive message {sessionId}#{seq} timestamp does not match message_json.");
        return new ArchiveMessageRecord(sessionId, agent, seq, timestamp, role, message, messageJson);
    }

    private static void ValidateArchiveShape(JsonObject message, long seq)
    {
        if (message.ContainsKey("modelVisible")
            && (message["modelVisible"] is not JsonValue visibility || !visibility.TryGetValue<bool>(out _)))
            throw new InvalidDataException($"Archive message {seq} modelVisible must be boolean.");
        if (message.ContainsKey("providerMeta"))
        {
            var provider = message["providerMeta"] as JsonObject
                ?? throw new InvalidDataException($"Archive message {seq} providerMeta must be an object.");
            if (provider["providerSpecificFields"] is not JsonObject)
                throw new InvalidDataException($"Archive message {seq} providerSpecificFields must be an object.");
            if (provider.ContainsKey("sourceModelId")
                && (provider["sourceModelId"] is not JsonValue source || !source.TryGetValue<string>(out _)))
                throw new InvalidDataException($"Archive message {seq} sourceModelId must be a string.");
        }
        foreach (var (partNode, index) in ((JsonArray)message["parts"]!).Select((value, partIndex) => (value, partIndex)))
        {
            var part = (JsonObject)partNode!;
            foreach (var field in new[] { "text", "system", "thinking", "toolUseId" })
                if (part.ContainsKey(field) && (part[field] is not JsonValue text || !text.TryGetValue<string>(out _)))
                    throw new InvalidDataException($"Archive message {seq} part {index} {field} must be a string.");
            if (part.ContainsKey("phase"))
            {
                if (part["phase"] is not JsonValue phaseValue || !phaseValue.TryGetValue<string>(out var phase)
                    || phase is not ("commentary" or "final_answer"))
                    throw new InvalidDataException($"Archive message {seq} part {index} phase is invalid.");
            }
            if (part.ContainsKey("systemPayload")
                && (part["systemPayload"] is not JsonValue payload || !payload.TryGetValue<bool>(out _)))
                throw new InvalidDataException($"Archive message {seq} part {index} systemPayload must be boolean.");
            if (part.ContainsKey("functionCall"))
            {
                var call = part["functionCall"] as JsonObject
                    ?? throw new InvalidDataException($"Archive message {seq} part {index} functionCall must be an object.");
                if (call["id"] is not JsonValue id || !id.TryGetValue<string>(out _)
                    || call["name"] is not JsonValue name || !name.TryGetValue<string>(out _)
                    || call["args"] is not JsonObject)
                    throw new InvalidDataException($"Archive message {seq} part {index} functionCall shape is invalid.");
            }
            if (part.ContainsKey("functionResponse"))
            {
                var response = part["functionResponse"] as JsonObject
                    ?? throw new InvalidDataException($"Archive message {seq} part {index} functionResponse must be an object.");
                if (response["tool_use_id"] is not JsonValue toolUseId || !toolUseId.TryGetValue<string>(out _)
                    || response["name"] is not JsonValue name || !name.TryGetValue<string>(out _)
                    || !response.ContainsKey("response"))
                    throw new InvalidDataException($"Archive message {seq} part {index} functionResponse shape is invalid.");
            }
            if (part.ContainsKey("providerMeta") && part["providerMeta"] is not JsonObject)
                throw new InvalidDataException($"Archive message {seq} part {index} providerMeta must be an object.");
        }
    }
}

public sealed partial class SqliteArchiveMessageStore
{
    private readonly string databasePath;
    private readonly string sessionId;

    public SqliteArchiveMessageStore(string databasePath, string sessionId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        this.databasePath = Path.GetFullPath(databasePath);
        this.sessionId = sessionId;
    }

    public string DatabasePath => databasePath;

    public void Initialize()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);
        using var connection = Open();
        Execute(connection, "PRAGMA journal_mode=WAL");
        Execute(connection, "PRAGMA synchronous=FULL");
        Execute(connection, "PRAGMA busy_timeout=5000");
        Execute(connection, "PRAGMA foreign_keys=ON");
        Execute(connection, """
            CREATE TABLE IF NOT EXISTS archive_messages (
              session_id TEXT NOT NULL,
              agent TEXT NOT NULL DEFAULT 'main',
              seq INTEGER NOT NULL,
              timestamp INTEGER NOT NULL,
              role TEXT NOT NULL,
              message_json TEXT NOT NULL,
              PRIMARY KEY (session_id, seq)
            )
            """);
        ValidateSchema(connection);
        InitializeBlocks(connection);
        ValidateSupportedAncillaryState(connection);
    }

    public IReadOnlyList<ArchiveMessageRecord> WriteMessages(IReadOnlyList<ArchiveMessageRecord> records)
    {
        if (records.Count == 0) return [];
        if (records.Any(record => record.SessionId != sessionId))
            throw new InvalidOperationException("Archive message batches must contain the bound Session ID only.");
        using var connection = OpenConfigured();
        using var transaction = connection.BeginTransaction(deferred: false);
        using var select = connection.CreateCommand();
        select.Transaction = transaction;
        select.CommandText = "SELECT agent,timestamp,role,message_json FROM archive_messages WHERE session_id=$session AND seq=$seq";
        var selectSession = select.Parameters.Add("$session", SqliteType.Text);
        var selectSeq = select.Parameters.Add("$seq", SqliteType.Integer);
        using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = "INSERT INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES($session,$agent,$seq,$timestamp,$role,$json)";
        var insertSession = insert.Parameters.Add("$session", SqliteType.Text);
        var insertAgent = insert.Parameters.Add("$agent", SqliteType.Text);
        var insertSeq = insert.Parameters.Add("$seq", SqliteType.Integer);
        var insertTimestamp = insert.Parameters.Add("$timestamp", SqliteType.Real);
        var insertRole = insert.Parameters.Add("$role", SqliteType.Text);
        var insertJson = insert.Parameters.Add("$json", SqliteType.Text);
        var inserted = new List<ArchiveMessageRecord>();
        foreach (var record in records)
        {
            ValidateRecord(record);
            selectSession.Value = record.SessionId;
            selectSeq.Value = record.Seq;
            using var reader = select.ExecuteReader();
            if (reader.Read())
            {
                var identical = reader.GetString(0) == record.Agent
                    && reader.GetDouble(1) == record.Timestamp
                    && reader.GetString(2) == record.Role
                    && reader.GetString(3) == record.MessageJson;
                reader.Close();
                if (identical) continue;
                throw new InvalidDataException($"Immutable archive message conflict for {record.SessionId}#{record.Seq}.");
            }
            reader.Close();
            insertSession.Value = record.SessionId;
            insertAgent.Value = record.Agent;
            insertSeq.Value = record.Seq;
            insertTimestamp.Value = record.Timestamp;
            insertRole.Value = record.Role;
            insertJson.Value = record.MessageJson;
            if (insert.ExecuteNonQuery() != 1) throw new IOException("Archive message insert did not affect one row.");
            inserted.Add(record);
        }
        transaction.Commit();
        return inserted;
    }

    public void RollbackInsertedMessages(IReadOnlyList<ArchiveMessageRecord> records)
    {
        if (records.Count == 0) return;
        using var connection = OpenConfigured();
        using var transaction = connection.BeginTransaction(deferred: false);
        using var remove = connection.CreateCommand();
        remove.Transaction = transaction;
        remove.CommandText = """
            DELETE FROM archive_messages
            WHERE session_id=$session AND seq=$seq AND agent=$agent
              AND timestamp=$timestamp AND role=$role AND message_json=$json
            """;
        var session = remove.Parameters.Add("$session", SqliteType.Text);
        var seq = remove.Parameters.Add("$seq", SqliteType.Integer);
        var agent = remove.Parameters.Add("$agent", SqliteType.Text);
        var timestamp = remove.Parameters.Add("$timestamp", SqliteType.Real);
        var role = remove.Parameters.Add("$role", SqliteType.Text);
        var json = remove.Parameters.Add("$json", SqliteType.Text);
        foreach (var record in records)
        {
            ValidateRecord(record);
            session.Value = record.SessionId;
            seq.Value = record.Seq;
            agent.Value = record.Agent;
            timestamp.Value = record.Timestamp;
            role.Value = record.Role;
            json.Value = record.MessageJson;
            if (remove.ExecuteNonQuery() != 1)
                throw new InvalidDataException($"Unable to roll back uncommitted archive message {record.SessionId}#{record.Seq}.");
        }
        transaction.Commit();
    }

    public IReadOnlyList<ArchiveMessageRecord> ReadMessages()
    {
        using var connection = OpenExistingReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=$session ORDER BY seq";
        command.Parameters.AddWithValue("$session", sessionId);
        using var reader = command.ExecuteReader();
        var records = new List<ArchiveMessageRecord>();
        while (reader.Read())
            records.Add(ArchiveMessageRecord.FromStored(sessionId, reader.GetString(0), reader.GetInt64(1), reader.GetDouble(2), reader.GetString(3), reader.GetString(4)));
        return records;
    }

    public IReadOnlyList<ArchiveMessageRecord> ReadMessagesRange(long startSeq, long endSeq)
    {
        if (startSeq <= 0 || endSeq < startSeq || endSeq > 9007199254740991L)
            throw new ArgumentOutOfRangeException(nameof(startSeq), "Archive message range must be positive and ordered.");
        using var connection = OpenExistingReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=$session AND seq BETWEEN $first AND $last ORDER BY seq";
        command.Parameters.AddWithValue("$session", sessionId);
        command.Parameters.AddWithValue("$first", startSeq);
        command.Parameters.AddWithValue("$last", endSeq);
        using var reader = command.ExecuteReader();
        var records = new List<ArchiveMessageRecord>();
        while (reader.Read())
            records.Add(ArchiveMessageRecord.FromStored(sessionId, reader.GetString(0), reader.GetInt64(1), reader.GetDouble(2), reader.GetString(3), reader.GetString(4)));
        return records;
    }

    public ArchiveMessageRecord? ReadMessageBySeq(long seq)
    {
        if (seq is <= 0 or > 9007199254740991L)
            throw new ArgumentOutOfRangeException(nameof(seq), "Archive message sequence must be a positive safe integer.");
        if (!File.Exists(databasePath)) return null;
        using var connection = OpenExistingReadOnly();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=$session AND seq=$seq";
        command.Parameters.AddWithValue("$session", sessionId);
        command.Parameters.AddWithValue("$seq", seq);
        using var reader = command.ExecuteReader();
        return reader.Read() ? ArchiveMessageRecord.FromStored(sessionId, reader.GetString(0), reader.GetInt64(1),
            reader.GetDouble(2), reader.GetString(3), reader.GetString(4)) : null;
    }

    private SqliteConnection OpenConfigured()
    {
        var connection = Open();
        try
        {
            Execute(connection, "PRAGMA synchronous=FULL");
            Execute(connection, "PRAGMA busy_timeout=5000");
            Execute(connection, "PRAGMA foreign_keys=ON");
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private SqliteConnection OpenExistingReadOnly()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false, DefaultTimeout = 5
        }.ToString());
        connection.Open();
        return connection;
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
            DefaultTimeout = 5
        }.ToString());
        connection.Open();
        return connection;
    }

    private void ValidateRecord(ArchiveMessageRecord record)
    {
        if (record.SessionId != sessionId || record.Agent.Length == 0 || record.Seq <= 0 || !double.IsFinite(record.Timestamp)
            || record.Role is not ("user" or "model" or "tool"))
            throw new InvalidDataException("Archive message record is outside the supported current shape.");
        var parsed = ArchiveMessageRecord.FromStored(record.SessionId, record.Agent, record.Seq, record.Timestamp, record.Role, record.MessageJson);
        if (!JsonNode.DeepEquals(parsed.Message, record.Message))
            throw new InvalidDataException("Archive message object does not match its raw message_json.");
    }

    private static void ValidateSchema(SqliteConnection connection)
    {
        using var columns = connection.CreateCommand();
        columns.CommandText = "PRAGMA table_info(archive_messages)";
        using var reader = columns.ExecuteReader();
        var actual = new List<(string Name, string Type, bool NotNull, string? Default, long Pk)>();
        while (reader.Read()) actual.Add((reader.GetString(1), reader.GetString(2), reader.GetInt64(3) == 1, reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetInt64(5)));
        var expected = new[]
        {
            ("session_id", "TEXT", true, (string?)null, 1L),
            ("agent", "TEXT", true, (string?)"'main'", 0L),
            ("seq", "INTEGER", true, (string?)null, 2L),
            ("timestamp", "INTEGER", true, (string?)null, 0L),
            ("role", "TEXT", true, (string?)null, 0L),
            ("message_json", "TEXT", true, (string?)null, 0L),
        };
        if (!actual.SequenceEqual(expected)) throw new InvalidDataException("archive_messages schema does not match current TypeScript columns and primary key.");

        using var indexes = connection.CreateCommand();
        indexes.CommandText = "PRAGMA index_list(archive_messages)";
        using var indexReader = indexes.ExecuteReader();
        var foundPrimary = false;
        while (indexReader.Read())
        {
            var origin = indexReader.GetString(3);
            if (origin == "pk" && indexReader.GetInt64(2) == 1 && !foundPrimary) foundPrimary = true;
            else throw new InvalidDataException("archive_messages contains an unsupported explicit or additional index.");
        }
        if (!foundPrimary) throw new InvalidDataException("archive_messages primary-key index is missing.");
        using var foreignKeys = connection.CreateCommand();
        foreignKeys.CommandText = "PRAGMA foreign_key_list(archive_messages)";
        using var foreignReader = foreignKeys.ExecuteReader();
        if (foreignReader.Read()) throw new InvalidDataException("archive_messages must not contain foreign-key constraints.");
    }

    private void ValidateSupportedAncillaryState(SqliteConnection connection)
    {
        if (TableExists(connection, "archive_branches"))
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT parent_session_id,fork_message_seq,fork_block_id FROM archive_branches WHERE session_id=$session";
            command.Parameters.AddWithValue("$session", sessionId);
            using var reader = command.ExecuteReader();
            if (reader.Read() && (!reader.IsDBNull(0) || reader.GetInt64(1) != 0 || reader.GetInt64(2) != 0))
                throw new UnsupportedSessionAuthorityException("Archive fork/parent lineage is unsupported.");
        }
        RejectRows(connection, "archive_session_id_reservations", "session_id=$session OR canonical_session_id=$session", "Archive aliases/reservations are unsupported.");
    }

    private void RejectRows(SqliteConnection connection, string table, string predicate, string message)
    {
        if (!TableExists(connection, table)) return;
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT 1 FROM {table} WHERE {predicate} LIMIT 1";
        command.Parameters.AddWithValue("$session", sessionId);
        if (command.ExecuteScalar() is not null) throw new UnsupportedSessionAuthorityException(message);
    }

    private static bool TableExists(SqliteConnection connection, string table)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name";
        command.Parameters.AddWithValue("$name", table);
        return command.ExecuteScalar() is not null;
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
