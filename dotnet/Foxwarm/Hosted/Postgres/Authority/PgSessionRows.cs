using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Hosted.Postgres.Authority;

/// <summary>A stored head: what a commit replaces and what a load assembles from.</summary>
internal sealed record PgSessionHead(
    Guid Lifetime,
    long Version,
    byte[] Envelope,
    IReadOnlyDictionary<string, string> Parts,
    IReadOnlyList<SessionSegment> Layout
)
{
    /// <summary>The next segment ID: above every segment the head references.</summary>
    internal long NextSegment => Layout.Count == 0 ? 1 : Layout.Max(segment => segment.Id) + 1;

    internal int RecordCount => Layout.Sum(segment => segment.Count);
}

/// <summary>What one commit wrote, for the measurement and the rewrite-count tests.</summary>
internal sealed record PgSessionCommitStats(
    string SessionId,
    int SegmentsWritten,
    int RecordsWritten,
    long SegmentBytesWritten,
    int SegmentsDeleted,
    int PartsWritten,
    int EnvelopeBytes
);

/// <summary>The head a commit produced.</summary>
internal sealed record PgSessionCommitted(
    Guid Lifetime,
    long Version,
    IReadOnlyList<SessionSegment> Layout,
    IReadOnlyDictionary<string, string> Parts,
    PgSessionCommitStats Stats
);

/// <summary>
/// Row access of the Session authority tables inside a <see cref="TenantDb"/> transaction.
/// Segments and parts are immutable: a commit inserts the new ones, deletes the replaced ones
/// and moves the head with a compare-and-set on <c>doc_version</c>, all in the caller's
/// transaction.
/// </summary>
internal static class PgSessionRows
{
    // Segments are sent in batches of about this many bytes, so a large rewrite holds a bounded
    // amount of bound segment data at a time.
    private const int BatchBytes = 1024 * 1024;

    internal static async ValueTask<PgSessionHead?> ReadHeadAsync(
        PgTx tx,
        string sessionId,
        bool forUpdate,
        bool async,
        CancellationToken token
    )
    {
        await using var command = tx.Command(
            "SELECT lifetime_id, doc_version, envelope, parts::text, segment_ids, segment_counts"
                + " FROM session_heads WHERE session_id = $1"
                + (forUpdate ? " FOR UPDATE" : ""),
            sessionId
        );
        await using var reader = async
            ? await command.ExecuteReaderAsync(token).ConfigureAwait(false)
            : command.ExecuteReader();
        if (!(async ? await reader.ReadAsync(token).ConfigureAwait(false) : reader.Read()))
            return null;
        var ids = reader.GetFieldValue<long[]>(4);
        var counts = reader.GetFieldValue<int[]>(5);
        if (ids.Length != counts.Length)
            throw new InvalidDataException("Session authority head segment lists differ in length.");
        return new(
            reader.GetGuid(0),
            reader.GetInt64(1),
            reader.GetFieldValue<byte[]>(2),
            PgSessionEnvelope.ParseParts(reader.GetString(3)),
            ids.Select((id, index) => new SessionSegment(id, counts[index], 0)).ToArray()
        );
    }

    /// <summary>The part values of <paramref name="head"/> by hex SHA-256.</summary>
    internal static async ValueTask<Dictionary<string, byte[]>> ReadPartsAsync(
        PgTx tx,
        PgSessionHead head,
        bool async,
        CancellationToken token
    )
    {
        var values = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        if (head.Parts.Count == 0)
            return values;
        await using var command = tx.Command(
            "SELECT sha256, value FROM session_envelope_parts WHERE lifetime_id = $1 AND sha256 = ANY($2)",
            head.Lifetime,
            Hashes(head.Parts.Values)
        );
        await using var reader = async
            ? await command.ExecuteReaderAsync(token).ConfigureAwait(false)
            : command.ExecuteReader();
        while (async ? await reader.ReadAsync(token).ConfigureAwait(false) : reader.Read())
            values[Convert.ToHexStringLower(reader.GetFieldValue<byte[]>(0))] =
                reader.GetFieldValue<byte[]>(1);
        return values;
    }

    /// <summary>
    /// The history records of <paramref name="head"/> in order, and its layout with each
    /// segment's stored size.
    /// </summary>
    internal static async ValueTask<(JsonArray History, SessionSegment[] Layout)> ReadHistoryAsync(
        PgTx tx,
        PgSessionHead head,
        bool async,
        CancellationToken token
    )
    {
        var stored = new Dictionary<long, (int Count, int Bytes, byte[] Records)>();
        if (head.Layout.Count > 0)
        {
            await using var command = tx.Command(
                "SELECT segment_id, record_count, byte_length, codec, records FROM session_segments"
                    + " WHERE lifetime_id = $1 AND segment_id = ANY($2)",
                head.Lifetime,
                head.Layout.Select(segment => segment.Id).ToArray()
            );
            await using var reader = async
                ? await command.ExecuteReaderAsync(token).ConfigureAwait(false)
                : command.ExecuteReader();
            while (async ? await reader.ReadAsync(token).ConfigureAwait(false) : reader.Read())
            {
                if (reader.GetInt16(3) != 0)
                    throw new UnsupportedSessionAuthorityException(
                        "Session authority segment codec is unsupported."
                    );
                stored[reader.GetInt64(0)] = (
                    reader.GetInt32(1),
                    reader.GetInt32(2),
                    reader.GetFieldValue<byte[]>(4)
                );
            }
        }
        var history = new JsonArray();
        var layout = new SessionSegment[head.Layout.Count];
        for (var index = 0; index < head.Layout.Count; index++)
        {
            var expected = head.Layout[index];
            if (!stored.Remove(expected.Id, out var segment) || segment.Count != expected.Count)
                throw new InvalidDataException("Session authority segment is missing or differs from its head.");
            var records =
                JsonNode.Parse(segment.Records) as JsonArray
                ?? throw new InvalidDataException("Session authority segment must be a JSON array.");
            if (records.Count != segment.Count)
                throw new InvalidDataException("Session authority segment record count differs.");
            var items = records.ToArray();
            records.Clear();
            foreach (var item in items)
                history.Add(item);
            layout[index] = new(expected.Id, segment.Count, segment.Bytes);
        }
        return (history, layout);
    }

    /// <summary>
    /// The assembled stored document: the envelope with its parts, and the history records in
    /// the position the envelope keeps for them.
    /// </summary>
    internal static async ValueTask<(JsonObject Document, SessionSegment[] Layout)> AssembleAsync(
        PgTx tx,
        PgSessionHead head,
        bool async,
        CancellationToken token
    )
    {
        var values = await ReadPartsAsync(tx, head, async, token).ConfigureAwait(false);
        var document = PgSessionEnvelope.Decode(head.Envelope, head.Parts, values);
        var (history, layout) = await ReadHistoryAsync(tx, head, async, token).ConfigureAwait(false);
        if (document.ContainsKey("history") && document["history"] is null)
            document["history"] = history;
        else if (history.Count > 0)
            throw new InvalidDataException("Session authority segments have no history position.");
        return (document, layout);
    }

    /// <summary>
    /// Writes one commit over <paramref name="current"/> (null: no head yet): keeps its first
    /// <paramref name="kept"/> segments, inserts <paramref name="pieces"/> after them, deletes
    /// the replaced segments and parts, and moves the head to <paramref name="commitId"/>.
    /// A head that changed since <paramref name="current"/> was read fails the transaction.
    /// </summary>
    internal static async ValueTask<PgSessionCommitted> CommitAsync(
        PgTx tx,
        string sessionId,
        PgSessionHead? current,
        int kept,
        IEnumerable<SessionSegmentPiece> pieces,
        PgSessionEnvelope envelope,
        Guid commitId,
        bool async,
        CancellationToken token
    )
    {
        var lifetime = current?.Lifetime ?? Guid.NewGuid();
        var next = current?.NextSegment ?? 1;
        var layout = (current?.Layout ?? []).Take(kept).ToList();
        var batch = tx.Batch();
        try
        {
            var pending = 0L;
            var written = 0;
            var records = 0;
            var bytes = 0L;
            foreach (var piece in pieces)
            {
                var id = next++;
                Add(
                    batch,
                    "INSERT INTO session_segments (lifetime_id, segment_id, record_count, byte_length, codec, records)"
                        + " VALUES ($1, $2, $3, $4, 0, $5)",
                    lifetime,
                    id,
                    piece.Count,
                    piece.Records.Length,
                    piece.Records
                );
                layout.Add(new(id, piece.Count, piece.Records.Length));
                written++;
                records += piece.Count;
                bytes += piece.Records.Length;
                pending += piece.Records.Length;
                if (pending >= BatchBytes)
                {
                    await ExecuteAsync(tx, batch, async, token).ConfigureAwait(false);
                    await batch.DisposeAsync().ConfigureAwait(false);
                    batch = tx.Batch();
                    pending = 0;
                }
            }
            var replaced = (current?.Layout ?? []).Skip(kept).Select(segment => segment.Id).ToArray();
            if (replaced.Length > 0)
                Add(
                    batch,
                    "DELETE FROM session_segments WHERE lifetime_id = $1 AND segment_id = ANY($2)",
                    lifetime,
                    replaced
                );
            var previous = new HashSet<string>(current?.Parts.Values ?? [], StringComparer.Ordinal);
            var referenced = new HashSet<string>(envelope.Parts.Values, StringComparer.Ordinal);
            var added = referenced.Where(hash => !previous.Contains(hash)).ToArray();
            foreach (var hash in added)
                Add(
                    batch,
                    "INSERT INTO session_envelope_parts (lifetime_id, sha256, value) VALUES ($1, $2, $3)"
                        + " ON CONFLICT DO NOTHING",
                    lifetime,
                    Convert.FromHexString(hash),
                    envelope.Values[hash]
                );
            var dropped = previous.Where(hash => !referenced.Contains(hash)).ToArray();
            if (dropped.Length > 0)
                Add(
                    batch,
                    "DELETE FROM session_envelope_parts WHERE lifetime_id = $1 AND sha256 = ANY($2)",
                    lifetime,
                    Hashes(dropped)
                );
            var ids = layout.Select(segment => segment.Id).ToArray();
            var counts = layout.Select(segment => segment.Count).ToArray();
            _ = current is null
                ? Add(
                    batch,
                    "INSERT INTO session_heads (session_id, lifetime_id, doc_version, commit_id, envelope, parts,"
                        + " segment_ids, segment_counts) VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7)",
                    sessionId,
                    lifetime,
                    commitId,
                    envelope.Bytes,
                    envelope.PartsJson,
                    ids,
                    counts
                )
                : Add(
                    batch,
                    "UPDATE session_heads SET doc_version = doc_version + 1, commit_id = $4, envelope = $5,"
                        + " parts = $6::jsonb, segment_ids = $7, segment_counts = $8, updated_at = now()"
                        + " WHERE session_id = $1 AND lifetime_id = $2 AND doc_version = $3",
                    sessionId,
                    lifetime,
                    current.Version,
                    commitId,
                    envelope.Bytes,
                    envelope.PartsJson,
                    ids,
                    counts
                );
            // The head is the batch's last command.
            if (await ExecuteAsync(tx, batch, async, token).ConfigureAwait(false) != 1)
                throw new SessionHeadChangedException();
            return new(
                lifetime,
                (current?.Version ?? 0) + 1,
                layout,
                new SortedDictionary<string, string>(envelope.Parts, StringComparer.Ordinal),
                new(sessionId, written, records, bytes, replaced.Length, added.Length, envelope.Bytes.Length)
            );
        }
        finally
        {
            await batch.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>Removes a head with its segments and parts; returns whether one existed.</summary>
    internal static async ValueTask<Guid?> DeleteAsync(
        PgTx tx,
        string sessionId,
        bool async,
        CancellationToken token
    )
    {
        await using var command = tx.Command(
            "DELETE FROM session_heads WHERE session_id = $1 RETURNING lifetime_id",
            sessionId
        );
        var value = async
            ? await command.ExecuteScalarAsync(token).ConfigureAwait(false)
            : command.ExecuteScalar();
        if (value is not Guid lifetime)
            return null;
        await using var batch = tx.Batch();
        Add(batch, "DELETE FROM session_segments WHERE lifetime_id = $1", lifetime);
        Add(batch, "DELETE FROM session_envelope_parts WHERE lifetime_id = $1", lifetime);
        await ExecuteAsync(tx, batch, async, token).ConfigureAwait(false);
        return lifetime;
    }

    /// <summary>Whether the commit <paramref name="commitId"/> is the stored head.</summary>
    internal static bool Committed(PgTx tx, Guid commitId) =>
        tx.Scalar("SELECT 1 FROM session_heads WHERE commit_id = $1", commitId) is not null;

    private static NpgsqlBatchCommand Add(NpgsqlBatch batch, string sql, params object?[] values)
    {
        var command = new NpgsqlBatchCommand(sql);
        foreach (var value in values)
            command.Parameters.Add(PgTx.Parameter(value));
        batch.BatchCommands.Add(command);
        return command;
    }

    // Returns the affected-row count of the batch's last command.
    private static async ValueTask<int> ExecuteAsync(PgTx tx, NpgsqlBatch batch, bool async, CancellationToken token)
    {
        if (batch.BatchCommands.Count == 0)
            return 0;
        if (!async)
            // A synchronous batch would be sent from a thread-pool task (PgTx.ExecuteInline).
            return tx.ExecuteInline(batch).RecordsAffected;
        await batch.ExecuteNonQueryAsync(token).ConfigureAwait(false);
        return batch.BatchCommands[^1].RecordsAffected;
    }

    private static NpgsqlParameter Hashes(IEnumerable<string> hashes) =>
        new NpgsqlParameter<byte[][]> { TypedValue = hashes.Select(Convert.FromHexString).ToArray() };
}

/// <summary>
/// The Session head changed since this store last committed or read it, so the commit was
/// refused before it took effect. The next commit rereads the head and writes all records.
/// </summary>
internal sealed class SessionHeadChangedException()
    : IOException("Session authority head changed concurrently; the commit was not applied.");
