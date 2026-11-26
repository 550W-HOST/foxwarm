using Foxwarm.Persistence;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Interim test-only view of one Session's PostgreSQL Archive rows, giving the authority
/// contract suite the reads it observes until the Archive track's <see cref="IArchiveSession"/>
/// is integrated; it is removed then. Everything else is unsupported.
/// </summary>
internal sealed class PgArchiveTestReader(TenantDb database, string sessionId) : IArchiveSession
{
    public string SessionId => sessionId;

    public string CanonicalSessionId => throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadMessages() =>
        database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT agent, seq, timestamp, role, message_json FROM archive_messages WHERE session_id = $1 ORDER BY seq",
                sessionId
            );
            using var reader = command.ExecuteReader();
            var rows = new List<ArchiveMessageRecord>();
            while (reader.Read())
                rows.Add(
                    ArchiveMessageRecord.FromStored(
                        sessionId,
                        reader.GetString(0),
                        reader.GetInt64(1),
                        reader.GetDouble(2),
                        reader.GetString(3),
                        reader.GetString(4)
                    )
                );
            return rows;
        });

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocks() =>
        database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT agent, id, level, source_kind, source_start, source_end, raw_start_seq, raw_end_seq,"
                    + " raw_start_timestamp, raw_end_timestamp, summary, created_at, friction_score"
                    + " FROM archive_blocks WHERE session_id = $1 ORDER BY id",
                sessionId
            );
            using var reader = command.ExecuteReader();
            var rows = new List<ArchiveBlockRecord>();
            while (reader.Read())
                rows.Add(
                    new(
                        sessionId,
                        reader.GetString(0),
                        reader.GetInt64(1),
                        reader.GetInt32(2),
                        reader.GetString(3),
                        reader.GetInt64(4),
                        reader.GetInt64(5),
                        null,
                        reader.GetInt64(6),
                        reader.GetInt64(7),
                        reader.IsDBNull(8) ? null : reader.GetDouble(8),
                        reader.IsDBNull(9) ? null : reader.GetDouble(9),
                        reader.GetString(10),
                        null,
                        reader.GetInt64(11),
                        reader.IsDBNull(12) ? null : reader.GetInt32(12)
                    )
                );
            return rows;
        });

    private static NotSupportedException Unsupported() =>
        new("The interim test Archive reader supports only ReadMessages and ReadBlocks.");

    public bool HasReadOnlyIdentity() => throw Unsupported();

    public ValueTask<WriteReceipt<IReadOnlyList<ArchiveMessageRecord>>> EnqueueMessagesAsync(
        IReadOnlyList<ArchiveMessageRecord> records
    ) => throw Unsupported();

    public ValueTask<
        WriteReceipt<(IReadOnlyList<ArchiveBlockRecord> Blocks, IReadOnlyList<ArchiveMessageRecord> Messages)>
    > EnqueueCompactionAsync(
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<ArchiveMessageRecord> messages
    ) => throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> WriteMessages(IReadOnlyList<ArchiveMessageRecord> records) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveBlockRecord> WriteBlocks(IReadOnlyList<ArchiveBlockRecord> records) =>
        throw Unsupported();

    public void RollbackInsertedMessages(IReadOnlyList<ArchiveMessageRecord> records) => throw Unsupported();

    public void RollbackInsertedBlocks(IReadOnlyList<ArchiveBlockRecord> blocks) => throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadMessagesRange(long startSeq, long endSeq) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadMessagesNumericRange(
        double? startSeq,
        double? endSeq,
        int? limit = null,
        bool descending = false,
        bool substantiveWindow = false,
        long? startTime = null,
        long? endTime = null
    ) => throw Unsupported();

    public ArchiveMessageRecord? ReadMessageBySeq(long seq) => throw Unsupported();

    public ArchiveStats MessageStats(long first = 1, long last = 9007199254740991) => throw Unsupported();

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocksRange(long first, long last) => throw Unsupported();

    public IReadOnlyList<ArchiveBlockRecord> ReadBlocksNumericRange(
        double? first,
        double? last,
        int? limit = null,
        bool descending = false,
        long? startTime = null,
        long? endTime = null
    ) => throw Unsupported();

    public IReadOnlyList<ArchiveBlockTopology> BlockTopology() => throw Unsupported();

    public ArchiveBranch? ReadBranch() => throw Unsupported();

    public ArchiveBranch? EnsureBranch(string? parent = null, long messageCap = 0, long blockCap = 0) =>
        throw Unsupported();

    public void RollbackInsertedBranch(ArchiveBranch? branch) => throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesRange(long first, long last) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesNumericRange(double? first, double? last) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesBetween(long startTime, long endTime) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesPage(
        double? first,
        double? last,
        int limit,
        bool descending = false
    ) => throw Unsupported();

    public IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksRange(long first, long last) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksNumericRange(double? first, double? last) =>
        throw Unsupported();

    public ArchiveStats EffectiveMessageStats(long first = 1, long last = 9007199254740991) =>
        throw Unsupported();

    public IReadOnlyList<ArchiveBlockTopology> EffectiveBlockTopology() => throw Unsupported();

    public long EffectiveBlockHighWater() => throw Unsupported();

    public IReadOnlyList<ArchiveVectorScope> VectorLineage() => throw Unsupported();
}
