using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

public sealed partial class SqliteArchiveMessageStore
{
    private static IReadOnlyList<LegacyArchiveCandidate> LegacyCandidates(string root)
    {
        var result = new Dictionary<string, LegacyArchiveCandidate>(StringComparer.Ordinal);
        void Add(string id, JsonObject? metadata)
        {
            if (id.Length == 0)
                return;
            result[id] = new(
                id,
                SessionWait.Text(metadata?["parentSessionId"]) is { Length: > 0 } parent
                    ? parent
                    : null,
                (metadata?["aliases"] as JsonArray)
                    ?.Select(SessionWait.Text)
                    .OfType<string>()
                    .Where(alias => alias.Length > 0)
                    .ToArray()
                    ?? []
            );
        }
        // A catalog is not a legacy candidate inventory or alias authority.
        // It can retain Source lineage after accepted catalog migration has
        // retired sessions.json but has not imported the physical Archive logs.
        using var catalog = File.Exists(Path.Combine(root, "state", "catalog.sqlite"))
            ? new SessionCatalog(root)
            : null;
        var loaded = catalog is not null;
        var primary = Path.Combine(root, "state", "sessions.json");
        foreach (
            var candidate in new[] { primary }
                .Concat(Enumerable.Range(1, 5).Select(index => primary + "." + index + ".bak"))
                .Append(primary + ".bak")
        )
        {
            if (loaded)
                break;
            if (!File.Exists(candidate))
                continue;
            try
            {
                if (JsonNode.Parse(File.ReadAllText(candidate)) is not JsonObject data)
                    continue;
                var sessions = data["sessions"] as JsonObject ?? data;
                foreach (var (id, node) in sessions)
                    Add(id, node as JsonObject);
                loaded = true;
                break;
            }
            catch (Exception error)
                when (error is JsonException or IOException or UnauthorizedAccessException) { }
        }
        var histories = Path.Combine(root, "state", "sessions");
        if (!loaded && Directory.Exists(histories))
            foreach (
                var file in Directory
                    .EnumerateFiles(
                        histories,
                        "*.json",
                        new EnumerationOptions
                        {
                            RecurseSubdirectories = true,
                            AttributesToSkip = FileAttributes.ReparsePoint,
                        }
                    )
                    .Where(file => !file.EndsWith(".frontier.json", StringComparison.Ordinal))
            )
                try
                {
                    if (JsonNode.Parse(File.ReadAllText(file)) is JsonObject metadata)
                        Add(
                            Path.GetRelativePath(histories, file)[..^5].Replace('\\', '/'),
                            metadata
                        );
                }
                catch (Exception error)
                    when (error is JsonException or IOException or UnauthorizedAccessException) { }
        var logs = Path.Combine(root, "state", "logs", "sessions");
        if (Directory.Exists(logs))
            foreach (
                var file in Directory.EnumerateFiles(
                    logs,
                    "*.jsonl",
                    new EnumerationOptions
                    {
                        RecurseSubdirectories = true,
                        AttributesToSkip = FileAttributes.ReparsePoint,
                    }
                )
            )
            {
                var relative = Path.GetRelativePath(logs, file).Replace('\\', '/');
                var id = relative[
                    ..^(relative.EndsWith(".blocks.jsonl", StringComparison.Ordinal) ? 13 : 6)
                ];
                if (!result.ContainsKey(id))
                {
                    Add(id, catalog?.Get(id));
                    // Catalog presentation aliases are reconciled only by the
                    // identity owner, after pending directional recovery.
                    if (catalog is not null)
                        result[id] = result[id] with { Aliases = [] };
                }
            }
        return result.Values.OrderBy(candidate => candidate.Id, StringComparer.Ordinal).ToArray();
    }

    private static HashSet<string> LegacyKeys(
        SqliteConnection connection,
        string table,
        string column
    )
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT session_id,{column} FROM {table}";
        using var rows = command.ExecuteReader();
        var result = new HashSet<string>(StringComparer.Ordinal);
        while (rows.Read())
            result.Add(rows.GetString(0) + "\0" + rows.GetInt64(1));
        return result;
    }

    private static string[] LegacyBranchIds(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT session_id FROM archive_branches";
        using var rows = command.ExecuteReader();
        var result = new List<string>();
        while (rows.Read())
            result.Add(rows.GetString(0));
        return result.ToArray();
    }

    private static bool LegacyBranchExists(SqliteConnection connection, string id)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM archive_branches WHERE session_id=$s";
        command.Parameters.AddWithValue("$s", id);
        return command.ExecuteScalar() is not null;
    }

    private static void LegacyEnsureBranch(
        SqliteConnection connection,
        string id,
        string? parent = null,
        double messageCap = 0,
        double blockCap = 0
    )
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "INSERT OR IGNORE INTO archive_branches(session_id,parent_session_id,fork_message_seq,fork_block_id,created_at,updated_at) VALUES($s,$p,$m,$b,$at,$at)";
        command.Parameters.AddWithValue("$s", id);
        command.Parameters.AddWithValue("$p", (object?)parent ?? DBNull.Value);
        command.Parameters.AddWithValue("$m", messageCap);
        command.Parameters.AddWithValue("$b", blockCap);
        command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        command.ExecuteNonQuery();
        if (parent is not null)
        {
            command.Parameters.Clear();
            command.CommandText =
                "INSERT OR IGNORE INTO archive_checkpoints(session_id,raw_last_indexed_seq,raw_tail_start_seq,last_indexed_block_id,updated_at) VALUES($s,$m,$t,$b,$at)";
            command.Parameters.AddWithValue("$s", id);
            command.Parameters.AddWithValue("$m", messageCap);
            command.Parameters.AddWithValue("$t", messageCap > 0 ? messageCap + 1 : 0);
            command.Parameters.AddWithValue("$b", blockCap);
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            command.ExecuteNonQuery();
        }
    }

    private static async Task<double> LegacyForkCap(
        IEnumerable<LegacyArchiveSource> sources,
        string id,
        string parent,
        bool blocks,
        Func<string, string> resolve
    )
    {
        var source = sources.FirstOrDefault(source =>
            source.SessionId == id && source.Blocks == blocks
        );
        if (source is null)
            return 0;
        double max = 0;
        double min = double.PositiveInfinity;
        await foreach (var line in LegacyArchiveRecords.Lines(source.FilePath))
        {
            var record = LegacyArchiveRecords.Parse(line, blocks).Record;
            var owner = resolve(LegacyArchiveRecords.Text(record, "sessionId")!);
            var seq = LegacyArchiveRecords.Number(record[blocks ? "id" : "seq"])!.Value;
            if (owner == parent)
                max = Math.Max(max, seq);
            if (owner == id)
                min = Math.Min(min, seq);
        }
        return max <= 0 && double.IsFinite(min) ? Math.Max(0, min - 1) : max;
    }

    private static bool LegacyImportCurrent(SqliteConnection connection, LegacyArchiveSource source)
    {
        using var command = connection.CreateCommand();
        command.CommandText = source.Blocks
            ? "SELECT blocks_file_size,blocks_file_mtime_ms FROM archive_import_state WHERE session_id=$s"
            : "SELECT messages_file_size,messages_file_mtime_ms FROM archive_import_state WHERE session_id=$s";
        command.Parameters.AddWithValue("$s", source.SessionId);
        using var row = command.ExecuteReader();
        var info = new FileInfo(source.FilePath);
        return row.Read()
            && row.GetInt64(0) == info.Length
            && row.GetInt64(1)
                == new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
    }

    private static void LegacyRecordImport(SqliteConnection connection, LegacyArchiveSource source)
    {
        using var command = connection.CreateCommand();
        var prefix = source.Blocks ? "blocks" : "messages";
        command.CommandText =
            $"INSERT INTO archive_import_state(session_id,{prefix}_file_size,{prefix}_file_mtime_ms,updated_at) VALUES($s,$size,$mtime,$at) ON CONFLICT(session_id) DO UPDATE SET {prefix}_file_size=excluded.{prefix}_file_size,{prefix}_file_mtime_ms=excluded.{prefix}_file_mtime_ms,updated_at=excluded.updated_at";
        var info = new FileInfo(source.FilePath);
        command.Parameters.AddWithValue("$s", source.SessionId);
        command.Parameters.AddWithValue("$size", info.Length);
        command.Parameters.AddWithValue(
            "$mtime",
            new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        );
        command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        command.ExecuteNonQuery();
    }

    private static void LegacyInsert(
        SqliteConnection connection,
        SqliteTransaction tx,
        JsonObject record,
        string id,
        bool blocks
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = blocks
            ? "INSERT OR IGNORE INTO archive_blocks(session_id,agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,friction_score,created_at) VALUES($s,$agent,$id,$level,$kind,$first,$last,$ids,$rawFirst,$rawLast,$start,$end,$summary,$facts,$friction,$at)"
            : "INSERT OR IGNORE INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES($s,$agent,$seq,$at,$role,$json)";
        void Add(string key, object? value) =>
            command.Parameters.AddWithValue(key, value ?? DBNull.Value);
        Add("$s", id);
        Add("$agent", LegacyArchiveRecords.Text(record, "agent"));
        if (!blocks)
        {
            Add("$seq", LegacyArchiveRecords.Number(record["seq"]));
            Add("$at", LegacyArchiveRecords.Number(record["timestamp"]));
            Add("$role", LegacyArchiveRecords.Text(record, "role"));
            Add("$json", EcmaJson.Stringify(record["message"]!));
        }
        else
        {
            Add("$id", LegacyArchiveRecords.Number(record["id"]));
            Add("$level", LegacyArchiveRecords.Number(record["level"]));
            Add("$kind", LegacyArchiveRecords.Text(record, "sourceKind"));
            Add("$first", LegacyArchiveRecords.Number(record["sourceStart"]));
            Add("$last", LegacyArchiveRecords.Number(record["sourceEnd"]));
            Add(
                "$ids",
                LegacyArchiveRecords.Text(record, "sourceKind") == "block"
                && record["sourceBlockIds"] is JsonArray { Count: > 0 } ids
                    ? EcmaJson.Stringify(ids)
                    : null
            );
            Add("$rawFirst", LegacyArchiveRecords.Number(record["rawStartSeq"]));
            Add("$rawLast", LegacyArchiveRecords.Number(record["rawEndSeq"]));
            Add("$start", LegacyArchiveRecords.Number(record["rawStartTimestamp"]));
            Add("$end", LegacyArchiveRecords.Number(record["rawEndTimestamp"]));
            Add("$summary", LegacyArchiveRecords.Text(record, "summary"));
            Add(
                "$facts",
                record["memoryFacts"] is JsonArray { Count: > 0 } facts
                    ? EcmaJson.Stringify(facts)
                    : null
            );
            Add("$friction", LegacyArchiveRecords.Friction(record["frictionScore"]));
            Add("$at", LegacyArchiveRecords.Number(record["createdAt"]));
        }
        command.ExecuteNonQuery();
    }

    private static JsonObject? LegacyReadRecord(
        SqliteConnection connection,
        SqliteTransaction? tx,
        JsonObject expected,
        string id,
        bool blocks
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = blocks
            ? "SELECT agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,friction_score,created_at FROM archive_blocks WHERE session_id=$s AND id=$id"
            : "SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=$s AND seq=$id";
        command.Parameters.AddWithValue("$s", id);
        command.Parameters.AddWithValue(
            "$id",
            LegacyArchiveRecords.Number(expected[blocks ? "id" : "seq"])!.Value
        );
        using var row = command.ExecuteReader();
        if (!row.Read())
            return null;
        return blocks
            ? ExportBlock(id, row)
            : new JsonObject
            {
                ["agent"] = row.GetString(0),
                ["seq"] = row.GetDouble(1),
                ["timestamp"] = row.GetDouble(2),
                ["role"] = row.GetString(3),
                ["message"] = JsonNode.Parse(row.GetString(4)),
            };
    }

    private static string LegacyComparable(JsonObject record, bool blocks)
    {
        var result = new JsonObject();
        foreach (
            var key in blocks
                ? new[]
                {
                    "agent",
                    "id",
                    "level",
                    "sourceKind",
                    "sourceStart",
                    "sourceEnd",
                    "rawStartSeq",
                    "rawEndSeq",
                    "rawStartTimestamp",
                    "rawEndTimestamp",
                    "summary",
                    "memoryFacts",
                    "createdAt",
                }
                : new[] { "agent", "seq", "timestamp", "role", "message" }
        )
            if (record.ContainsKey(key))
                result[key] = record[key]?.DeepClone();
        if (blocks)
        {
            if (
                LegacyArchiveRecords.Text(record, "sourceKind") == "block"
                && record.ContainsKey("sourceBlockIds")
            )
                result["sourceBlockIds"] = record["sourceBlockIds"]?.DeepClone();
            if (LegacyArchiveRecords.Friction(record["frictionScore"]) is { } score)
                result["frictionScore"] = score;
        }
        return LegacyArchiveRecords.Canonical(result);
    }

    internal static string? LegacyMetadata(
        SqliteConnection connection,
        string key,
        SqliteTransaction? tx = null
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = "SELECT value FROM archive_store_metadata WHERE key=$k";
        command.Parameters.AddWithValue("$k", key);
        return command.ExecuteScalar() as string;
    }

    internal static void LegacySetMetadata(
        SqliteConnection connection,
        SqliteTransaction? tx,
        string key,
        string value
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText =
            "INSERT OR REPLACE INTO archive_store_metadata(key,value) VALUES($k,$v)";
        command.Parameters.AddWithValue("$k", key);
        command.Parameters.AddWithValue("$v", value);
        command.ExecuteNonQuery();
    }

    private static void ValidateLegacyLineage(SqliteConnection connection)
    {
        var parents = new Dictionary<string, string?>();
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT session_id,parent_session_id,fork_message_seq,fork_block_id FROM archive_branches";
        using var rows = command.ExecuteReader();
        while (rows.Read())
        {
            for (var index = 2; index <= 3; index++)
                if (
                    rows.GetDouble(index) < 0
                    || Math.Floor(rows.GetDouble(index)) != rows.GetDouble(index)
                )
                    throw new InvalidDataException("Invalid archive lineage caps.");
            parents[rows.GetString(0)] = rows.IsDBNull(1) ? null : rows.GetString(1);
        }
        foreach (var start in parents.Keys)
        {
            string? id = start;
            var seen = new HashSet<string>();
            while (id is not null)
            {
                if (!seen.Add(id))
                    throw new InvalidDataException("Archive lineage cycle involving " + id);
                id = parents.GetValueOrDefault(id);
            }
        }
    }
}
