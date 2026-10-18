using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

public sealed partial class SqliteArchiveMessageStore
{
    internal sealed record ExportCounts(long Files, long Records);

    internal static async Task<ExportCounts> ExportJsonlAsync(string databasePath, string outputRoot)
    {
        InitializeDatabase(databasePath);
        outputRoot = Path.GetFullPath(outputRoot);
        if (outputRoot == Path.GetPathRoot(outputRoot))
            throw new InvalidDataException("Archive export output cannot be a filesystem root");
        var temporary = outputRoot + ".tmp-" + Guid.NewGuid().ToString("N");
        var previous = outputRoot + ".previous-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(temporary);
        long files = 0;
        long records = 0;
        try
        {
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false,
            }.ToString());
            connection.Open();
            using var snapshot = connection.BeginTransaction(deferred: true);
            using var branches = connection.CreateCommand();
            branches.Transaction = snapshot;
            branches.CommandText = "SELECT session_id FROM archive_branches ORDER BY session_id";
            using var sessions = branches.ExecuteReader();
            while (sessions.Read())
            {
                var id = sessions.GetString(0);
                foreach (var blocks in new[] { false, true })
                {
                    var relative = id + (blocks ? ".blocks.jsonl" : ".jsonl");
                    var path = Path.GetFullPath(relative, temporary);
                    if (!path.StartsWith(temporary + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                        throw new InvalidDataException("Unsafe session ID in archive export path: " + relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    if (!OperatingSystem.IsWindows())
                        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                    using var writer = new StreamWriter(stream, new UTF8Encoding(false));
                    using var command = connection.CreateCommand();
                    command.Transaction = snapshot;
                    command.CommandText = blocks
                        ? "SELECT agent,id,level,source_kind,source_start,source_end,source_block_ids_json,raw_start_seq,raw_end_seq,raw_start_timestamp,raw_end_timestamp,summary,memory_facts_json,friction_score,created_at FROM archive_blocks WHERE session_id=$s ORDER BY id"
                        : "SELECT agent,seq,timestamp,role,message_json FROM archive_messages WHERE session_id=$s ORDER BY seq";
                    command.Parameters.AddWithValue("$s", id);
                    using var rows = command.ExecuteReader();
                    long count = 0;
                    while (rows.Read())
                    {
                        var record = blocks ? ExportBlock(id, rows) : new JsonObject
                        {
                            ["v"] = 1, ["kind"] = "message", ["sessionId"] = id,
                            ["agent"] = rows.GetString(0) is { Length: > 0 } agent ? agent : "main",
                            ["seq"] = rows.GetInt64(1), ["timestamp"] = rows.GetDouble(2),
                            ["role"] = rows.GetString(3), ["message"] = JsonNode.Parse(rows.GetString(4)),
                        };
                        await writer.WriteLineAsync(EcmaJson.Stringify(record));
                        count++;
                    }
                    await writer.FlushAsync();
                    stream.Flush(true);
                    writer.Dispose();
                    if (count == 0)
                        File.Delete(path);
                    else
                    {
                        files++;
                        records += count;
                    }
                }
            }
            snapshot.Commit();
            if (Directory.Exists(outputRoot))
                Directory.Move(outputRoot, previous);
            try
            {
                Directory.Move(temporary, outputRoot);
                if (Directory.Exists(previous))
                    Directory.Delete(previous, true);
            }
            catch
            {
                if (Directory.Exists(outputRoot))
                    Directory.Delete(outputRoot, true);
                if (Directory.Exists(previous))
                    Directory.Move(previous, outputRoot);
                throw;
            }
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(outputRoot)!);
            return new(files, records);
        }
        finally
        {
            if (Directory.Exists(temporary))
                Directory.Delete(temporary, true);
        }
    }

    private static JsonObject ExportBlock(string id, SqliteDataReader row)
    {
        var result = new JsonObject
        {
            ["v"] = 1, ["kind"] = "block", ["sessionId"] = id,
            ["agent"] = row.GetString(0) is { Length: > 0 } agent ? agent : "main",
            ["id"] = row.GetInt64(1), ["level"] = row.GetInt64(2), ["sourceKind"] = row.GetString(3),
            ["sourceStart"] = row.GetInt64(4), ["sourceEnd"] = row.GetInt64(5),
        };
        if (LegacyArchiveRecords.SourceBlockIds(row.IsDBNull(6) ? null : row.GetString(6)) is { } ids)
            result["sourceBlockIds"] = ids;
        result["rawStartSeq"] = row.GetInt64(7);
        result["rawEndSeq"] = row.GetInt64(8);
        if (!row.IsDBNull(9)) result["rawStartTimestamp"] = row.GetDouble(9);
        if (!row.IsDBNull(10)) result["rawEndTimestamp"] = row.GetDouble(10);
        result["summary"] = row.GetString(11);
        if (LegacyArchiveRecords.MemoryFacts(row.IsDBNull(12) ? null : row.GetString(12)) is { } facts)
            result["memoryFacts"] = facts;
        if (!row.IsDBNull(13) && LegacyArchiveRecords.Friction(JsonValue.Create(row.GetDouble(13))) is { } score)
            result["frictionScore"] = score;
        result["createdAt"] = row.GetDouble(14);
        return result;
    }
}
