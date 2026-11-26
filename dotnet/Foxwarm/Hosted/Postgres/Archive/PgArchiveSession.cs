using Foxwarm.Persistence;
using Foxwarm.Sessions;
using static Foxwarm.Hosted.Postgres.Archive.PgArchiveReads;

namespace Foxwarm.Hosted.Postgres.Archive;

/// <summary>
/// One Session's view of the PostgreSQL Archive, with the semantics of
/// <see cref="SqliteArchiveMessageStore"/>. Every write is one fenced transaction; every read is
/// one read transaction, so an effective read sees its whole lineage in one snapshot.
/// </summary>
internal sealed class PgArchiveSession(TenantDb database, string sessionId) : IArchiveSession
{
    public string SessionId => sessionId;

    public string CanonicalSessionId => database.Read(tx => PgArchiveRows.Resolve(tx, sessionId));

    public bool HasReadOnlyIdentity() =>
        database.Read(tx =>
        {
            var canonical = PgArchiveRows.Resolve(tx, sessionId);
            return tx.Scalar(
                    "SELECT 1 WHERE EXISTS (SELECT 1 FROM session_id_reservations WHERE session_id = $1 OR canonical_session_id = $1)"
                        + " OR EXISTS (SELECT 1 FROM archive_branches WHERE session_id = $2)"
                        + " OR EXISTS (SELECT 1 FROM archive_messages WHERE session_id = $2)"
                        + " OR EXISTS (SELECT 1 FROM archive_blocks WHERE session_id = $2)",
                    sessionId,
                    canonical
                )
                is not null;
        });

    public ValueTask<WriteReceipt<IReadOnlyList<ArchiveMessageRecord>>> EnqueueMessagesAsync(
        IReadOnlyList<ArchiveMessageRecord> records
    )
    {
        var batch = PgArchiveBatch.Prepare(sessionId, [], records);
        if (batch.IsEmpty)
            return ValueTask.FromResult(
                new WriteReceipt<IReadOnlyList<ArchiveMessageRecord>>(Task.FromResult<IReadOnlyList<ArchiveMessageRecord>>([]))
            );
        return ValueTask.FromResult(
            new WriteReceipt<IReadOnlyList<ArchiveMessageRecord>>(InsertAsync(batch, inserted => inserted.Messages))
        );
    }

    public ValueTask<
        WriteReceipt<(IReadOnlyList<ArchiveBlockRecord> Blocks, IReadOnlyList<ArchiveMessageRecord> Messages)>
    > EnqueueCompactionAsync(IReadOnlyList<ArchiveBlockRecord> blocks, IReadOnlyList<ArchiveMessageRecord> messages)
    {
        var batch = PgArchiveBatch.Prepare(sessionId, blocks, messages);
        return ValueTask.FromResult(
            new WriteReceipt<(IReadOnlyList<ArchiveBlockRecord>, IReadOnlyList<ArchiveMessageRecord>)>(
                InsertAsync(batch, inserted => (inserted.Blocks, inserted.Messages))
            )
        );
    }

    private async Task<T> InsertAsync<T>(PgArchiveBatch batch, Func<PgArchiveInserted, T> select)
    {
        var inserted = PgArchiveInserted.None;
        await database
            .WriteAsync(
                async (tx, token) => inserted = await PgArchiveRows.InsertAsync(tx, batch, token).ConfigureAwait(false),
                new PgWriteOptions(Verify: tx => PgArchiveRows.Stored(tx, sessionId, inserted))
            )
            .ConfigureAwait(false);
        return select(inserted);
    }

    public IReadOnlyList<ArchiveMessageRecord> WriteMessages(IReadOnlyList<ArchiveMessageRecord> records)
    {
        if (records.Count == 0)
            return [];
        var inserted = Insert(PgArchiveBatch.Prepare(sessionId, [], records)).Messages;
        var sequences = inserted.Select(row => row.Seq).ToHashSet();
        return records.Where(record => sequences.Remove(record.Seq)).ToArray();
    }

    public IReadOnlyList<ArchiveBlockRecord> WriteBlocks(IReadOnlyList<ArchiveBlockRecord> records)
    {
        if (records.Count == 0)
            return [];
        var inserted = Insert(PgArchiveBatch.Prepare(sessionId, records, [])).Blocks;
        var ids = inserted.Select(block => block.Id).ToHashSet();
        return records.Where(block => ids.Remove(block.Id)).ToArray();
    }

    private PgArchiveInserted Insert(PgArchiveBatch batch)
    {
        var inserted = PgArchiveInserted.None;
        return database.Write(
            tx => inserted = PgArchiveRows.Insert(tx, batch),
            new PgWriteOptions(Verify: tx => PgArchiveRows.Stored(tx, sessionId, inserted))
        );
    }

    public void RollbackInsertedMessages(IReadOnlyList<ArchiveMessageRecord> records)
    {
        if (records.Count == 0)
            return;
        var prepared = records.Select(record => ArchiveRowAdmission.Message(record, sessionId)).ToArray();
        database.Write(
            tx =>
            {
                PgArchiveRows.RequireWriteIdentityAsync(tx, sessionId, false, default).GetAwaiter().GetResult();
                PgArchiveRows.DeleteMessagesAsync(tx, sessionId, prepared, false, default).GetAwaiter().GetResult();
                return true;
            },
            new PgWriteOptions(Verify: tx => PgArchiveRows.Absent(tx, sessionId, prepared, []))
        );
    }

    public void RollbackInsertedBlocks(IReadOnlyList<ArchiveBlockRecord> blocks)
    {
        if (blocks.Count == 0)
            return;
        var prepared = blocks.Select(block => ArchiveRowAdmission.PrepareBlock(block, sessionId)).ToArray();
        database.Write(
            tx =>
            {
                PgArchiveRows.RequireWriteIdentityAsync(tx, sessionId, false, default).GetAwaiter().GetResult();
                PgArchiveRows.DeleteBlocksAsync(tx, sessionId, prepared, false, default).GetAwaiter().GetResult();
                return true;
            },
            new PgWriteOptions(Verify: tx => PgArchiveRows.Absent(tx, sessionId, [], prepared))
        );
    }

    public IReadOnlyList<ArchiveMessageRecord> ReadMessages() =>
        database.Read(tx => Messages(tx, PgArchiveRows.Resolve(tx, sessionId), "", "seq"));

    public IReadOnlyList<ArchiveMessageRecord> ReadMessagesRange(long startSeq, long endSeq)
    {
        if (startSeq <= 0 || endSeq < startSeq || endSeq > MaxSeq)
            throw new ArgumentOutOfRangeException(nameof(startSeq), "Archive message range must be positive and ordered.");
        return database.Read(tx => OwnRange(tx, PgArchiveRows.Resolve(tx, sessionId), startSeq, endSeq));
    }

    private static List<ArchiveMessageRecord> OwnRange(PgTx tx, string canonical, long first, long last) =>
        Messages(tx, canonical, " AND seq BETWEEN $2 AND $3", "seq", first, last);

    public IReadOnlyList<ArchiveMessageRecord> ReadMessagesNumericRange(
        double? startSeq,
        double? endSeq,
        int? limit = null,
        bool descending = false,
        bool substantiveWindow = false,
        long? startTime = null,
        long? endTime = null
    ) =>
        database.Read(tx =>
            MessagesNumeric(
                tx,
                PgArchiveRows.Resolve(tx, sessionId),
                startSeq,
                endSeq,
                limit,
                descending,
                substantiveWindow,
                startTime,
                endTime
            )
        );

    public ArchiveMessageRecord? ReadMessageBySeq(long seq)
    {
        if (seq is <= 0 or > MaxSeq)
            throw new ArgumentOutOfRangeException(nameof(seq), "Archive message sequence must be a positive safe integer.");
        return database.Read(tx =>
            Messages(tx, PgArchiveRows.Resolve(tx, sessionId), " AND seq = $2", "seq", seq).FirstOrDefault()
        );
    }

    public ArchiveStats MessageStats(long first = 1, long last = MaxSeq) =>
        database.Read(tx => PgArchiveReads.MessageStats(tx, PgArchiveRows.Resolve(tx, sessionId), first, last));

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocks() => ReadBlocksRange(1, MaxSeq);

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocksRange(long first, long last)
    {
        if (first <= 0 || last < first || last > MaxSeq)
            throw new ArgumentOutOfRangeException(nameof(first));
        return database.Read(tx => OwnBlocks(tx, PgArchiveRows.Resolve(tx, sessionId), first, last));
    }

    private static List<ArchiveBlockRecord> OwnBlocks(PgTx tx, string canonical, long first, long last) =>
        Blocks(tx, canonical, " AND id BETWEEN $2 AND $3", "id", first, last);

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocksNumericRange(
        double? first,
        double? last,
        int? limit = null,
        bool descending = false,
        long? startTime = null,
        long? endTime = null
    ) =>
        database.Read(tx =>
            BlocksNumeric(tx, PgArchiveRows.Resolve(tx, sessionId), sessionId, first, last, limit, descending, startTime, endTime)
        );

    private static List<ArchiveBlockRecord> BlocksNumeric(
        PgTx tx,
        string canonical,
        string sessionId,
        double? first,
        double? last,
        int? limit = null,
        bool descending = false,
        long? startTime = null,
        long? endTime = null
    )
    {
        // Placeholder of the next parameter: $1 is the canonical identity, then this list.
        var parameters = new List<object?> { Number(first), Number(last) };
        string Add(object? value)
        {
            parameters.Add(value);
            return "$" + (parameters.Count + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        var timeFilter = "";
        if (startTime is not null || endTime is not null)
        {
            // Legacy blocks may omit their source timestamps. Resolve endpoints within the same
            // effective lineage as Archive reads, before the block row limit.
            var scopes = new List<string>();
            foreach (var part in VectorScopes(tx, sessionId))
            {
                var session = Add(part.SessionId);
                var cap = Add(Number(part.MaxMessageSeq));
                scopes.Add($"(m.session_id = {session} AND ({cap}::bigint IS NULL OR m.seq <= {cap}))");
            }
            string Endpoint(string column, string sequence) =>
                $"coalesce({column}, (SELECT m.timestamp FROM archive_messages m WHERE m.seq = b.{sequence} AND ({string.Join(" OR ", scopes)}) LIMIT 1))";
            var start = Add(Number(startTime));
            var end = Add(Number(endTime));
            timeFilter =
                $" AND ({start}::bigint IS NULL OR {Endpoint("raw_end_timestamp", "raw_end_seq")} >= {start})"
                + $" AND ({end}::bigint IS NULL OR {Endpoint("raw_start_timestamp", "raw_start_seq")} < {end})";
        }
        return Blocks(
            tx,
            canonical,
            " AND ($2::float8 IS NULL OR id >= $2) AND ($3::float8 IS NULL OR id <= $3)" + timeFilter,
            "id " + (descending ? "DESC" : "ASC") + (limit is int bound ? " LIMIT " + bound.ToString(System.Globalization.CultureInfo.InvariantCulture) : ""),
            [.. parameters]
        );
    }

    public IReadOnlyList<ArchiveBlockTopology> BlockTopology() =>
        database.Read(tx => Topology(tx, PgArchiveRows.Resolve(tx, sessionId)));

    public ArchiveBranch? ReadBranch() => database.Read(tx => Branch(tx, sessionId));

    public ArchiveBranch? EnsureBranch(string? parent = null, long messageCap = 0, long blockCap = 0)
    {
        ArchiveBranch? created = null;
        return database.Write(
            tx =>
            {
                PgArchiveRows.RequireWriteIdentityAsync(tx, sessionId, false, default).GetAwaiter().GetResult();
                if (Branch(tx, sessionId) is { } existing)
                {
                    if (existing.ParentSessionId != parent || existing.MessageCap != messageCap || existing.BlockCap != blockCap)
                        throw new InvalidDataException("Archive branch lineage is immutable.");
                    return null;
                }
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                tx.Execute(
                    "INSERT INTO archive_branches (session_id, parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at)"
                        + " VALUES ($1, $2, $3, $4, $5, $5)",
                    sessionId,
                    parent,
                    messageCap,
                    blockCap,
                    now
                );
                return created = new ArchiveBranch(sessionId, parent, messageCap, blockCap, now, now);
            },
            new PgWriteOptions(Verify: tx => created is null || BranchStored(tx, created))
        );
    }

    public void RollbackInsertedBranch(ArchiveBranch? branch)
    {
        if (branch is null)
            return;
        database.Write(
            tx =>
            {
                PgArchiveRows.RequireWriteIdentityAsync(tx, sessionId, false, default).GetAwaiter().GetResult();
                // A committed parent move rewrites the branch edge, not this creation's ownership.
                var parent = branch.ParentSessionId is null ? null : PgArchiveRows.Resolve(tx, branch.ParentSessionId);
                var removed = tx.Execute(
                    "DELETE FROM archive_branches WHERE session_id = $1 AND parent_session_id IS NOT DISTINCT FROM $2"
                        + " AND fork_message_seq = $3 AND fork_block_id = $4 AND created_at = $5 AND updated_at = $6",
                    branch.SessionId,
                    parent,
                    branch.MessageCap,
                    branch.BlockCap,
                    branch.CreatedAt,
                    branch.UpdatedAt
                );
                if (removed != 1)
                    throw new IOException("Owned Archive branch rollback conflict.");
                return true;
            },
            new PgWriteOptions(Verify: tx =>
                tx.Scalar("SELECT 1 FROM archive_branches WHERE session_id = $1 AND created_at = $2", branch.SessionId, branch.CreatedAt) is null
            )
        );
    }

    private static bool BranchStored(PgTx tx, ArchiveBranch branch) =>
        tx.Scalar(
            "SELECT 1 FROM archive_branches WHERE session_id = $1 AND created_at = $2 AND fork_message_seq = $3 AND fork_block_id = $4",
            branch.SessionId,
            branch.CreatedAt,
            branch.MessageCap,
            branch.BlockCap
        )
            is not null;

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesRange(long first, long last) =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .Where(part => part.Messages >= first)
                    .SelectMany(part => OwnRange(tx, part.SessionId, first, Math.Min(last, part.Messages)))
                    .OrderBy(row => row.Seq)
                    .ThenBy(row => row.Timestamp)
                    .ToArray(),
            snapshot: true
        );

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesNumericRange(double? first, double? last) =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .SelectMany(part => MessagesNumeric(tx, part.SessionId, first, MinCap(last, part.Messages)))
                    .OrderBy(row => row.Seq)
                    .ThenBy(row => row.Timestamp)
                    .ToArray(),
            snapshot: true
        );

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesBetween(long startTime, long endTime) =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .SelectMany(part =>
                        MessagesNumeric(tx, part.SessionId, null, MinCap(null, part.Messages), startTime: startTime, endTime: endTime)
                    )
                    .OrderBy(row => row.Seq)
                    .ThenBy(row => row.Timestamp)
                    .ToArray(),
            snapshot: true
        );

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesPage(
        double? first,
        double? last,
        int limit,
        bool descending = false
    )
    {
        if (limit is <= 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(limit));
        return database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .SelectMany(part => MessagesNumeric(tx, part.SessionId, first, MinCap(last, part.Messages), limit, descending))
                    .OrderBy(row => row.Seq, descending ? Comparer<long>.Create((a, b) => b.CompareTo(a)) : null)
                    .ThenBy(row => row.Timestamp)
                    .Take(limit)
                    .ToArray(),
            snapshot: true
        );
    }

    public IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksRange(long first, long last) =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .Where(part => part.Blocks >= first)
                    .SelectMany(part => OwnBlocks(tx, part.SessionId, first, Math.Min(last, part.Blocks)))
                    .OrderBy(row => row.Id)
                    .ThenBy(row => row.CreatedAt)
                    .ToArray(),
            snapshot: true
        );

    public IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksNumericRange(double? first, double? last) =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .SelectMany(part => BlocksNumeric(tx, part.SessionId, part.SessionId, first, MinCap(last, part.Blocks)))
                    .OrderBy(row => row.Id)
                    .ThenBy(row => row.CreatedAt)
                    .ToArray(),
            snapshot: true
        );

    private static double? MinCap(double? requested, long cap) =>
        requested is null ? cap : Math.Min(requested.Value, cap);

    public ArchiveStats EffectiveMessageStats(long first = 1, long last = MaxSeq) =>
        database.Read(
            tx =>
            {
                var parts = Lineage(tx, sessionId)
                    .Where(part => part.Messages >= first)
                    .Select(part => PgArchiveReads.MessageStats(tx, part.SessionId, first, Math.Min(last, part.Messages)))
                    .ToArray();
                var populated = parts.Where(part => part.Count > 0).ToArray();
                return new ArchiveStats(
                    parts.Sum(part => part.Count),
                    populated.Length == 0 ? null : populated.Min(part => part.First),
                    populated.Length == 0 ? null : populated.Max(part => part.Last)
                );
            },
            snapshot: true
        );

    public IReadOnlyList<ArchiveBlockTopology> EffectiveBlockTopology() =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .SelectMany(part =>
                        Topology(tx, part.SessionId)
                            .Where(row => row.Id <= part.Blocks)
                            .Select(row => row with { SourceSessionId = part.SessionId })
                    )
                    .OrderBy(row => row.RawFirst)
                    .ThenBy(row => row.RawLast)
                    .ThenBy(row => row.StartTime ?? 0)
                    .ThenBy(row => row.Id)
                    .ToArray(),
            snapshot: true
        );

    public long EffectiveBlockHighWater() =>
        database.Read(
            tx =>
                Lineage(tx, sessionId)
                    .Max(part =>
                        part.Blocks == 0
                            ? 0L
                            : (long)tx.Scalar(
                                "SELECT coalesce(max(id), 0) FROM archive_blocks WHERE session_id = $1 AND id <= $2",
                                part.SessionId,
                                part.Blocks
                            )!
                    ),
            snapshot: true
        );

    public IReadOnlyList<ArchiveVectorScope> VectorLineage() =>
        database.Read(tx => VectorScopes(tx, sessionId), snapshot: true);

    private static List<ArchiveVectorScope> VectorScopes(PgTx tx, string sessionId) =>
        Lineage(tx, sessionId)
            .Select(part => new ArchiveVectorScope(
                part.SessionId,
                part.Messages == MaxSeq ? null : part.Messages,
                part.Blocks == MaxSeq ? null : part.Blocks
            ))
            .ToList();
}
