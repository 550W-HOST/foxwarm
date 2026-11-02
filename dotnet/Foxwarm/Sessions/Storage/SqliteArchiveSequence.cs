using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record ArchiveSequenceRow(long Seq, double Timestamp, string Role, JsonObject Data);

internal sealed record ArchiveSequencePage(
    string SessionId,
    IReadOnlyList<ArchiveSequenceRow> Rows,
    long? MaxSeq,
    bool TruncatedStart,
    bool HasMore,
    ArchiveSequenceRow? Context = null
);

/// <summary>
/// Bounded read-only projection of one Session's own Archive rows for the sequence view.
/// Only small fields are extracted inside SQLite; tool outputs and large arguments never
/// leave the database. Fork lineage is not expanded, so a parent's pre-fork rows are not
/// repeated under the child.
/// </summary>
internal static class SqliteArchiveSequence
{
    internal const int PreviewLength = 240;

    internal static SqliteConnection? Open(string databasePath)
    {
        if (!File.Exists(databasePath))
            return null;
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = databasePath,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
                DefaultTimeout = 5,
            }.ToString()
        );
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

    /// <summary>
    /// Reads rows at or after <paramref name="since"/>. Without <paramref name="afterSeq"/> the
    /// newest <paramref name="limit"/> rows are kept; with it, rows after that cursor ascend.
    /// </summary>
    internal static ArchiveSequencePage Read(
        SqliteConnection connection,
        string sessionId,
        double since,
        long? afterSeq,
        int limit
    )
    {
        var canonical = SqliteArchiveMessageStore.ResolveReadOnly(connection, sessionId);
        long? min = null,
            max = null;
        using (var bounds = connection.CreateCommand())
        {
            bounds.CommandText =
                "SELECT MIN(seq),MAX(seq) FROM archive_messages WHERE session_id=$s";
            bounds.Parameters.AddWithValue("$s", canonical);
            using var reader = bounds.ExecuteReader();
            if (reader.Read() && !reader.IsDBNull(0))
            {
                min = reader.GetInt64(0);
                max = reader.GetInt64(1);
            }
        }
        if (min is null || max is null)
            return new(sessionId, [], null, false, false);
        var start = WindowStart(connection, canonical, since, min.Value, max.Value);
        if (afterSeq is long cursor && cursor + 1 > start)
            start = cursor + 1;
        if (start > max)
            return new(sessionId, [], max, false, false);
        var ascending = afterSeq is not null;
        using var command = connection.CreateCommand();
        command.CommandText =
            Select
            + " WHERE session_id=$s AND seq>=$start ORDER BY seq "
            + (ascending ? "ASC" : "DESC")
            + " LIMIT $limit";
        command.Parameters.AddWithValue("$s", canonical);
        command.Parameters.AddWithValue("$start", start);
        command.Parameters.AddWithValue("$limit", limit + 1);
        var rows = new List<ArchiveSequenceRow>();
        using (var reader = command.ExecuteReader())
            while (reader.Read())
                rows.Add(
                    new(
                        reader.GetInt64(0),
                        reader.GetDouble(1),
                        reader.GetString(2),
                        reader.IsDBNull(3)
                            ? new JsonObject()
                            : JsonNode.Parse(reader.GetString(3)) as JsonObject ?? new JsonObject()
                    )
                );
        var overflow = rows.Count > limit;
        if (overflow)
            rows.RemoveAt(rows.Count - 1);
        if (!ascending)
            rows.Reverse();
        // A leading tool row needs its calling model message to recover call positions.
        ArchiveSequenceRow? context = null;
        if (rows.Count > 0 && rows[0].Role == "tool")
        {
            using var previous = connection.CreateCommand();
            previous.CommandText =
                Select
                + " WHERE session_id=$s AND seq<$seq AND role='model' ORDER BY seq DESC LIMIT 1";
            previous.Parameters.AddWithValue("$s", canonical);
            previous.Parameters.AddWithValue("$seq", rows[0].Seq);
            using var reader = previous.ExecuteReader();
            if (reader.Read() && !reader.IsDBNull(3))
                context = new(
                    reader.GetInt64(0),
                    reader.GetDouble(1),
                    reader.GetString(2),
                    JsonNode.Parse(reader.GetString(3)) as JsonObject ?? new JsonObject()
                );
        }
        return new(sessionId, rows, max, !ascending && overflow, ascending && overflow, context);
    }

    // Archive timestamps are monotonic within one Session, so the window start is found on seq.
    private static long WindowStart(
        SqliteConnection connection,
        string canonical,
        double since,
        long min,
        long max
    )
    {
        using var probe = connection.CreateCommand();
        probe.CommandText =
            "SELECT seq,timestamp FROM archive_messages WHERE session_id=$s AND seq>=$x ORDER BY seq LIMIT 1";
        probe.Parameters.AddWithValue("$s", canonical);
        var at = probe.Parameters.Add("$x", SqliteType.Integer);
        long low = min,
            high = max + 1;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            at.Value = middle;
            using var reader = probe.ExecuteReader();
            if (!reader.Read())
            {
                high = middle;
                continue;
            }
            var seq = reader.GetInt64(0);
            if (reader.GetDouble(1) >= since)
                high = Math.Min(middle, seq);
            else
                low = seq + 1;
        }
        return low;
    }

    private static string Text(string json, string path, int length = PreviewLength) =>
        $"CASE json_type({json},{path}) WHEN 'text' THEN substr(json_extract({json},{path}),1,{length}) END";

    private static string Args(string prefix)
    {
        var fields = new (string Key, int Length)[]
        {
            ("sessionId", 512),
            ("message", PreviewLength),
            ("toolId", 256),
            ("name", 256),
            ("source", 32),
            ("suffix", 128),
            ("agentName", 128),
            ("taskId", 128),
            ("action", 64),
            ("title", 200),
            ("ownerSessionId", 512),
            ("command", 200),
            ("filePath", 300),
            ("code", 200),
        };
        var builder = new StringBuilder("json_object(");
        builder.AppendJoin(
            ',',
            fields.Select(field =>
                $"'{field.Key}',{Text("message_json", $"{prefix}||'.{field.Key}'", field.Length)}"
            )
        );
        return builder.Append(')').ToString();
    }

    private const string Part = "p.fullkey";

    private static readonly string Select = $"""
        SELECT seq,timestamp,role,CASE role
        WHEN 'model' THEN json_object(
          'timing',json_extract(message_json,'$.__meta.llmRequestTiming'),
          'visible',json_extract(message_json,'$.modelVisible'),
          'notice',json_extract(message_json,'$.__meta.noticeType'),
          'text',(SELECT substr(group_concat(json_extract(message_json,{Part}||'.text'),''),1,{PreviewLength})
            FROM json_each(message_json,'$.parts') p
            WHERE json_type(message_json,{Part}||'.text')='text' AND json_type(message_json,{Part}||'.thinking') IS NULL),
          'calls',(SELECT json_group_array(json_object(
              'id',json_extract(message_json,{Part}||'.functionCall.id'),
              'name',json_extract(message_json,{Part}||'.functionCall.name'),
              'args',{Args($"{Part}||'.functionCall.args'")},
              'inner',{Args($"{Part}||'.functionCall.args.args'")}))
            FROM json_each(message_json,'$.parts') p
            WHERE json_type(message_json,{Part}||'.functionCall')='object'))
        WHEN 'tool' THEN json_object(
          'responses',(SELECT json_group_array(json_object(
              'id',json_extract(message_json,{Part}||'.functionResponse.tool_use_id'),
              'name',json_extract(message_json,{Part}||'.functionResponse.name'),
              'timing',json_extract(message_json,{Part}||'.functionResponse.executionTiming'),
              'error',json_extract(message_json,{Part}||'.functionResponse.response.error.type'),
              'failed',json_type(message_json,{Part}||'.functionResponse.response.error') IS NOT NULL,
              'canceled',json_extract(message_json,{Part}||'.functionResponse.response.canceled'),
              'deliveries',(SELECT json_group_array(json_object(
                  'target',json_extract(d.value,'$.targetSessionId'),
                  'deliverySeq',json_extract(d.value,'$.deliverySeq'),
                  'message',{Text("d.value", "'$.message'")}))
                FROM json_each(message_json,{Part}||'.functionResponse.__meta.sessionMessages') d),
              'subCalls',(SELECT json_group_array(json_object(
                  'name',json_extract(s.value,'$.name'),
                  'status',json_extract(s.value,'$.status'),
                  'startedAt',json_extract(s.value,'$.startedAt'),
                  'durationMs',json_extract(s.value,'$.durationMs'),
                  'target',json_extract(s.value,'$.sessionMessage.targetSessionId'),
                  'deliverySeq',json_extract(s.value,'$.sessionMessage.deliverySeq'),
                  'message',{Text("s.value", "'$.sessionMessage.message'")}))
                FROM json_each(message_json,{Part}||'.functionResponse.__meta.toolScriptSubCalls') s)))
            FROM json_each(message_json,'$.parts') p
            WHERE json_type(message_json,{Part}||'.functionResponse')='object'))
        ELSE json_object(
          'system',(SELECT json_group_array({Text("message_json", $"{Part}||'.system'", 1600)})
            FROM json_each(message_json,'$.parts') p
            WHERE json_type(message_json,{Part}||'.system')='text'),
          'text',(SELECT substr(group_concat(json_extract(message_json,{Part}||'.text'),' '),1,{PreviewLength})
            FROM json_each(message_json,'$.parts') p
            WHERE json_type(message_json,{Part}||'.text')='text'),
          'visible',json_extract(message_json,'$.modelVisible'))
        END FROM archive_messages
        """;
}
