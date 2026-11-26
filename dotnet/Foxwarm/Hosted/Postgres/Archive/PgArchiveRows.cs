using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Hosted.Postgres.Archive;

/// <summary>A message row admitted for insert, with the columns extracted from its JSON.</summary>
internal sealed record PgArchiveMessage(ArchiveMessageRecord Record, bool? ModelVisible, string SequenceData);

/// <summary>
/// One Session's Archive rows, admitted and prepared outside any transaction so that
/// <see cref="PgArchiveRows.Insert"/> does only database work. <see cref="Prepare"/> applies
/// the current-write admission of every Archive implementation and requires the exact current
/// identity at insert; <see cref="Import"/> applies the historical read rules and keeps the
/// rows' recorded Session IDs, for copying an existing Archive.
/// </summary>
internal sealed class PgArchiveBatch
{
    private PgArchiveBatch(
        string sessionId,
        IReadOnlyList<PreparedArchiveBlock> blocks,
        IReadOnlyList<PgArchiveMessage> messages,
        bool current
    )
    {
        SessionId = sessionId;
        Blocks = blocks;
        Messages = messages;
        Current = current;
    }

    internal string SessionId { get; }

    internal IReadOnlyList<PreparedArchiveBlock> Blocks { get; }

    internal IReadOnlyList<PgArchiveMessage> Messages { get; }

    /// <summary>Whether insert requires <see cref="SessionId"/> to be its own current identity.</summary>
    internal bool Current { get; }

    internal bool IsEmpty => Blocks.Count == 0 && Messages.Count == 0;

    internal static PgArchiveBatch Prepare(
        string sessionId,
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<ArchiveMessageRecord> messages
    ) =>
        new(
            sessionId,
            blocks.Select(block => ArchiveRowAdmission.PrepareBlock(block, sessionId)).ToArray(),
            messages.Select(record => Extract(ArchiveRowAdmission.Message(record, sessionId))).ToArray(),
            current: true
        );

    internal static PgArchiveBatch Import(
        string sessionId,
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<ArchiveMessageRecord> messages
    )
    {
        var prepared = blocks
            .Select(block =>
            {
                ArchiveRowAdmission.Block(block, sessionId);
                return new PreparedArchiveBlock(block, block.SourceBlockIdsJson, block.MemoryFactsJson);
            })
            .ToArray();
        var rows = messages
            .Select(record =>
            {
                if (record.SessionId != sessionId)
                    throw new InvalidDataException("Archive message record belongs to another Session.");
                return Extract(
                    ArchiveMessageRecord.FromStored(
                        record.SessionId,
                        record.Agent,
                        record.Seq,
                        record.Timestamp,
                        record.Role,
                        record.MessageJson
                    )
                );
            })
            .ToArray();
        return new(sessionId, prepared, rows, current: false);
    }

    private static PgArchiveMessage Extract(ArchiveMessageRecord record)
    {
        bool? visible =
            record.Message["modelVisible"] is System.Text.Json.Nodes.JsonValue flag
            && flag.TryGetValue<bool>(out var value)
                ? value
                : null;
        return new(record, visible, Foxwarm.Sessions.EcmaJson.Stringify(ArchiveSequenceProjection.Build(record.Role, record.Message)));
    }
}

/// <summary>The rows one insert added, in input order; replayed rows are not included.</summary>
internal sealed record PgArchiveInserted(
    IReadOnlyList<ArchiveBlockRecord> Blocks,
    IReadOnlyList<ArchiveMessageRecord> Messages
)
{
    internal static readonly PgArchiveInserted None = new([], []);
}

/// <summary>
/// Archive row writes inside a caller's <see cref="TenantDb"/> transaction. Rows are immutable:
/// an insert adds new keys with <c>ON CONFLICT DO NOTHING … RETURNING</c>, then compares every
/// conflicting key with the stored row. An exact replay is a no-op; any difference throws
/// <see cref="InvalidDataException"/>, which fails the caller's transaction, so nothing of it
/// commits. Blocks are written before messages, as in a file-mode compaction.
/// </summary>
internal static partial class PgArchiveRows
{
    internal static PgArchiveInserted Insert(PgTx tx, PgArchiveBatch batch) =>
        InsertCore(tx, batch, async: false, CancellationToken.None).GetAwaiter().GetResult();

    internal static Task<PgArchiveInserted> InsertAsync(
        PgTx tx,
        PgArchiveBatch batch,
        CancellationToken token = default
    ) => InsertCore(tx, batch, async: true, token).AsTask();

    /// <summary>
    /// Whether every row of <paramref name="inserted"/> is stored exactly; the
    /// <see cref="PgWriteOptions.Verify"/> check after a lost <c>COMMIT</c>.
    /// </summary>
    internal static bool Stored(PgTx tx, string sessionId, PgArchiveInserted inserted)
    {
        if (inserted.Messages.Count > 0)
        {
            using var command = tx.Command(
                "SELECT count(*) FROM archive_messages m JOIN unnest($2::bigint[], $3::text[], $4::float8[], $5::text[], $6::text[])"
                    + " AS r(seq, agent, ts, role, json) ON m.session_id = $1 AND m.seq = r.seq AND m.agent = r.agent"
                    + " AND m.timestamp = r.ts AND m.role = r.role AND m.message_json = r.json",
                [sessionId, .. MessageKeys(inserted.Messages)]
            );
            if ((long)command.ExecuteScalar()! != inserted.Messages.Count)
                return false;
        }
        foreach (var block in inserted.Blocks)
        {
            using var command = tx.Command(
                "SELECT 1 FROM archive_blocks WHERE session_id = $1 AND " + BlockMatch,
                [sessionId, .. BlockValues(block)]
            );
            if (command.ExecuteScalar() is null)
                return false;
        }
        return true;
    }

    /// <summary>Whether none of the given rows is stored exactly; the Verify check of a rollback.</summary>
    internal static bool Absent(
        PgTx tx,
        string sessionId,
        IReadOnlyList<ArchiveMessageRecord> messages,
        IReadOnlyList<PreparedArchiveBlock> blocks
    )
    {
        if (messages.Count > 0)
        {
            using var command = tx.Command(
                "SELECT count(*) FROM archive_messages m JOIN unnest($2::bigint[], $3::text[], $4::float8[], $5::text[], $6::text[])"
                    + " AS r(seq, agent, ts, role, json) ON m.session_id = $1 AND m.seq = r.seq AND m.agent = r.agent"
                    + " AND m.timestamp = r.ts AND m.role = r.role AND m.message_json = r.json",
                [sessionId, .. MessageKeys(messages)]
            );
            if ((long)command.ExecuteScalar()! != 0)
                return false;
        }
        foreach (var block in blocks)
        {
            using var command = tx.Command(
                "SELECT 1 FROM archive_blocks WHERE session_id = $1 AND " + BlockMatch,
                [sessionId, .. BlockValues(block)]
            );
            if (command.ExecuteScalar() is not null)
                return false;
        }
        return true;
    }

    /// <summary>
    /// Removes exactly the rows of <paramref name="messages"/>; any row that isn't stored
    /// exactly as given throws <see cref="InvalidDataException"/> and removes nothing.
    /// </summary>
    internal static ValueTask DeleteMessagesAsync(
        PgTx tx,
        string sessionId,
        IReadOnlyList<ArchiveMessageRecord> messages,
        bool async,
        CancellationToken token
    ) => DeleteMessagesCore(tx, sessionId, messages, async, token);

    /// <summary>
    /// Removes exactly the rows of <paramref name="blocks"/>; any row that isn't stored exactly
    /// as given throws <see cref="IOException"/> and removes nothing.
    /// </summary>
    internal static ValueTask DeleteBlocksAsync(
        PgTx tx,
        string sessionId,
        IReadOnlyList<PreparedArchiveBlock> blocks,
        bool async,
        CancellationToken token
    ) => DeleteBlocksCore(tx, sessionId, blocks, async, token);

    private static async ValueTask<PgArchiveInserted> InsertCore(
        PgTx tx,
        PgArchiveBatch batch,
        bool async,
        CancellationToken token
    )
    {
        if (batch.Current)
            await RequireWriteIdentityAsync(tx, batch.SessionId, async, token).ConfigureAwait(false);
        var blocks = batch.Blocks.Count == 0
            ? []
            : await InsertBlocksAsync(tx, batch.SessionId, batch.Blocks, async, token).ConfigureAwait(false);
        var messages = batch.Messages.Count == 0
            ? []
            : await InsertMessagesAsync(tx, batch.SessionId, batch.Messages, async, token).ConfigureAwait(false);
        return new(blocks, messages);
    }

    private static async ValueTask<IReadOnlyList<ArchiveMessageRecord>> InsertMessagesAsync(
        PgTx tx,
        string sessionId,
        IReadOnlyList<PgArchiveMessage> rows,
        bool async,
        CancellationToken token
    )
    {
        var records = rows.Select(row => row.Record).ToArray();
        var added = new HashSet<long>();
        await using (
            var insert = tx.Command(
                "INSERT INTO archive_messages (session_id, seq, agent, timestamp, role, message_json, model_visible, sequence_data)"
                    + " SELECT $1, r.* FROM unnest($2::bigint[], $3::text[], $4::float8[], $5::text[], $6::text[], $7::boolean[], $8::text[])"
                    + " AS r ON CONFLICT DO NOTHING RETURNING seq",
                [
                    sessionId,
                    .. MessageKeys(records),
                    new NpgsqlParameter<bool?[]> { TypedValue = rows.Select(row => row.ModelVisible).ToArray() },
                    new NpgsqlParameter<string[]> { TypedValue = rows.Select(row => row.SequenceData).ToArray() },
                ]
            )
        )
            foreach (var seq in await LongsAsync(insert, async, token).ConfigureAwait(false))
                added.Add(seq);
        var inserted = new List<ArchiveMessageRecord>();
        var replayed = new List<ArchiveMessageRecord>();
        foreach (var record in records)
        {
            if (added.Remove(record.Seq))
                inserted.Add(record);
            else
                replayed.Add(record);
        }
        if (replayed.Count == 0)
            return inserted;
        var stored = new Dictionary<long, (string Agent, double Timestamp, string Role, string Json)>();
        await using (
            var select = tx.Command(
                "SELECT seq, agent, timestamp, role, message_json FROM archive_messages WHERE session_id = $1 AND seq = ANY($2)",
                sessionId,
                replayed.Select(record => record.Seq).Distinct().ToArray()
            )
        )
        await using (var reader = await ReadAsync(select, async, token).ConfigureAwait(false))
            while (async ? await reader.ReadAsync(token).ConfigureAwait(false) : reader.Read())
                stored[reader.GetInt64(0)] = (reader.GetString(1), reader.GetDouble(2), reader.GetString(3), reader.GetString(4));
        foreach (var record in replayed)
            if (
                !stored.TryGetValue(record.Seq, out var row)
                || row.Agent != record.Agent
                || row.Timestamp != record.Timestamp
                || row.Role != record.Role
                || row.Json != record.MessageJson
            )
                throw new InvalidDataException(
                    $"Immutable archive message conflict for {record.SessionId}#{record.Seq}."
                );
        return inserted;
    }

    private static async ValueTask<IReadOnlyList<ArchiveBlockRecord>> InsertBlocksAsync(
        PgTx tx,
        string sessionId,
        IReadOnlyList<PreparedArchiveBlock> blocks,
        bool async,
        CancellationToken token
    )
    {
        var added = new HashSet<long>();
        await using (
            var insert = tx.Command(
                "INSERT INTO archive_blocks (session_id, id, agent, level, source_kind, source_start, source_end, source_block_ids_json,"
                    + " raw_start_seq, raw_end_seq, raw_start_timestamp, raw_end_timestamp, summary, memory_facts_json, created_at, friction_score)"
                    + " SELECT $1, r.* FROM unnest($2::bigint[], $3::text[], $4::integer[], $5::text[], $6::bigint[], $7::bigint[], $8::text[],"
                    + " $9::bigint[], $10::bigint[], $11::float8[], $12::float8[], $13::text[], $14::text[], $15::bigint[], $16::integer[])"
                    + " AS r ON CONFLICT DO NOTHING RETURNING id",
                [sessionId, .. BlockColumns(blocks)]
            )
        )
            foreach (var id in await LongsAsync(insert, async, token).ConfigureAwait(false))
                added.Add(id);
        var inserted = new List<ArchiveBlockRecord>();
        foreach (var prepared in blocks)
        {
            if (added.Remove(prepared.Record.Id))
            {
                inserted.Add(prepared.Record);
                continue;
            }
            await using var lookup = tx.Command(
                "SELECT 1 FROM archive_blocks WHERE session_id = $1 AND " + BlockMatch,
                [sessionId, .. BlockValues(prepared)]
            );
            var same = async
                ? await lookup.ExecuteScalarAsync(token).ConfigureAwait(false)
                : lookup.ExecuteScalar();
            if (same is null)
                throw new InvalidDataException(
                    $"Immutable archive block conflict for {sessionId} B#{prepared.Record.Id}."
                );
        }
        return inserted;
    }

    private static async ValueTask DeleteMessagesCore(
        PgTx tx,
        string sessionId,
        IReadOnlyList<ArchiveMessageRecord> messages,
        bool async,
        CancellationToken token
    )
    {
        await using var delete = tx.Command(
            "DELETE FROM archive_messages m USING unnest($2::bigint[], $3::text[], $4::float8[], $5::text[], $6::text[])"
                + " AS r(seq, agent, ts, role, json) WHERE m.session_id = $1 AND m.seq = r.seq AND m.agent = r.agent"
                + " AND m.timestamp = r.ts AND m.role = r.role AND m.message_json = r.json RETURNING m.seq",
            [sessionId, .. MessageKeys(messages)]
        );
        var removed = (await LongsAsync(delete, async, token).ConfigureAwait(false)).ToHashSet();
        foreach (var record in messages)
            if (!removed.Remove(record.Seq))
                throw new InvalidDataException(
                    $"Unable to roll back uncommitted archive message {record.SessionId}#{record.Seq}."
                );
    }

    private static async ValueTask DeleteBlocksCore(
        PgTx tx,
        string sessionId,
        IReadOnlyList<PreparedArchiveBlock> blocks,
        bool async,
        CancellationToken token
    )
    {
        foreach (var block in blocks)
        {
            await using var delete = tx.Command(
                "DELETE FROM archive_blocks WHERE session_id = $1 AND " + BlockMatch,
                [sessionId, .. BlockValues(block)]
            );
            var count = async
                ? await delete.ExecuteNonQueryAsync(token).ConfigureAwait(false)
                : delete.ExecuteNonQuery();
            if (count != 1)
                throw new IOException(
                    $"Archive block rollback conflict for {sessionId} B#{block.Record.Id}."
                );
        }
    }

    // Columns of one block compared exactly; $2… follow BlockValues.
    private const string BlockMatch =
        "id = $2 AND agent = $3 AND level = $4 AND source_kind = $5 AND source_start = $6 AND source_end = $7"
        + " AND source_block_ids_json IS NOT DISTINCT FROM $8 AND raw_start_seq = $9 AND raw_end_seq = $10"
        + " AND raw_start_timestamp IS NOT DISTINCT FROM $11::float8 AND raw_end_timestamp IS NOT DISTINCT FROM $12::float8"
        + " AND summary = $13 AND memory_facts_json IS NOT DISTINCT FROM $14 AND created_at = $15"
        + " AND friction_score IS NOT DISTINCT FROM $16::integer";

    private static object?[] BlockValues(ArchiveBlockRecord block) =>
        BlockValues(new PreparedArchiveBlock(block, block.SourceBlockIdsJson, block.MemoryFactsJson));

    private static object?[] BlockValues(PreparedArchiveBlock prepared)
    {
        var block = prepared.Record;
        return
        [
            block.Id,
            block.Agent,
            block.Level,
            block.SourceKind,
            block.SourceStart,
            block.SourceEnd,
            Text(prepared.SourceIds),
            block.RawStartSeq,
            block.RawEndSeq,
            new NpgsqlParameter<double?> { TypedValue = block.RawStartTimestamp },
            new NpgsqlParameter<double?> { TypedValue = block.RawEndTimestamp },
            block.Summary,
            Text(prepared.Facts),
            block.CreatedAt,
            new NpgsqlParameter<int?> { TypedValue = block.FrictionScore },
        ];
    }

    private static object?[] BlockColumns(IReadOnlyList<PreparedArchiveBlock> blocks)
    {
        var rows = blocks.Select(block => block.Record).ToArray();
        return
        [
            rows.Select(row => row.Id).ToArray(),
            rows.Select(row => row.Agent).ToArray(),
            rows.Select(row => row.Level).ToArray(),
            rows.Select(row => row.SourceKind).ToArray(),
            rows.Select(row => row.SourceStart).ToArray(),
            rows.Select(row => row.SourceEnd).ToArray(),
            new NpgsqlParameter<string?[]> { TypedValue = blocks.Select(block => block.SourceIds).ToArray() },
            rows.Select(row => row.RawStartSeq).ToArray(),
            rows.Select(row => row.RawEndSeq).ToArray(),
            new NpgsqlParameter<double?[]> { TypedValue = rows.Select(row => row.RawStartTimestamp).ToArray() },
            new NpgsqlParameter<double?[]> { TypedValue = rows.Select(row => row.RawEndTimestamp).ToArray() },
            rows.Select(row => row.Summary).ToArray(),
            new NpgsqlParameter<string?[]> { TypedValue = blocks.Select(block => block.Facts).ToArray() },
            rows.Select(row => row.CreatedAt).ToArray(),
            new NpgsqlParameter<int?[]> { TypedValue = rows.Select(row => row.FrictionScore).ToArray() },
        ];
    }

    private static object?[] MessageKeys(IReadOnlyList<ArchiveMessageRecord> records) =>
    [
        records.Select(record => record.Seq).ToArray(),
        records.Select(record => record.Agent).ToArray(),
        new NpgsqlParameter<double[]> { TypedValue = records.Select(record => record.Timestamp).ToArray() },
        records.Select(record => record.Role).ToArray(),
        records.Select(record => record.MessageJson).ToArray(),
    ];

    private static NpgsqlParameter Text(string? value) => new NpgsqlParameter<string?> { TypedValue = value };

    private static async ValueTask<List<long>> LongsAsync(
        NpgsqlCommand command,
        bool async,
        CancellationToken token
    )
    {
        var values = new List<long>();
        await using var reader = await ReadAsync(command, async, token).ConfigureAwait(false);
        while (async ? await reader.ReadAsync(token).ConfigureAwait(false) : reader.Read())
            values.Add(reader.GetInt64(0));
        return values;
    }

    private static async ValueTask<NpgsqlDataReader> ReadAsync(
        NpgsqlCommand command,
        bool async,
        CancellationToken token
    ) => async ? await command.ExecuteReaderAsync(token).ConfigureAwait(false) : command.ExecuteReader();
}
