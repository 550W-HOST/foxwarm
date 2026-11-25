using Foxwarm.Persistence;

namespace Foxwarm.Sessions;

// The Archive session interface over this store's existing members.
public sealed partial class SqliteArchiveMessageStore : IArchiveSession
{
    string IArchiveSession.SessionId => sessionId;

    string IArchiveSession.CanonicalSessionId => CanonicalSessionId;

    bool IArchiveSession.HasReadOnlyIdentity() => HasReadOnlyIdentity();

    ValueTask<WriteReceipt<IReadOnlyList<ArchiveMessageRecord>>> IArchiveSession.EnqueueMessagesAsync(
        IReadOnlyList<ArchiveMessageRecord> records
    ) => EnqueueMessagesAsync(records);

    ValueTask<
        WriteReceipt<(
            IReadOnlyList<ArchiveBlockRecord> Blocks,
            IReadOnlyList<ArchiveMessageRecord> Messages
        )>
    > IArchiveSession.EnqueueCompactionAsync(
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<ArchiveMessageRecord> messages
    ) => EnqueueCompactionAsync(blocks, messages);

    IReadOnlyList<ArchiveMessageRecord> IArchiveSession.ReadMessagesNumericRange(
        double? startSeq,
        double? endSeq,
        int? limit,
        bool descending,
        bool substantiveWindow,
        long? startTime,
        long? endTime
    ) =>
        ReadMessagesNumericRange(
            startSeq,
            endSeq,
            limit,
            descending,
            substantiveWindow,
            startTime,
            endTime
        );

    ArchiveStats IArchiveSession.MessageStats(long first, long last) => MessageStats(first, last);

    IReadOnlyList<ArchiveBlockRecord> IArchiveSession.ReadBlocksNumericRange(
        double? first,
        double? last,
        int? limit,
        bool descending,
        long? startTime,
        long? endTime
    ) => ReadBlocksNumericRange(first, last, limit, descending, startTime, endTime);

    IReadOnlyList<ArchiveBlockTopology> IArchiveSession.BlockTopology() => BlockTopology();

    ArchiveBranch? IArchiveSession.ReadBranch() => ReadBranch();

    ArchiveBranch? IArchiveSession.EnsureBranch(string? parent, long messageCap, long blockCap) =>
        EnsureBranch(parent, messageCap, blockCap);

    void IArchiveSession.RollbackInsertedBranch(ArchiveBranch? branch) =>
        RollbackInsertedBranch(branch);

    IReadOnlyList<ArchiveMessageRecord> IArchiveSession.ReadEffectiveMessagesRange(
        long first,
        long last
    ) => ReadEffectiveMessagesRange(first, last);

    IReadOnlyList<ArchiveMessageRecord> IArchiveSession.ReadEffectiveMessagesNumericRange(
        double? first,
        double? last
    ) => ReadEffectiveMessagesNumericRange(first, last);

    IReadOnlyList<ArchiveMessageRecord> IArchiveSession.ReadEffectiveMessagesBetween(
        long startTime,
        long endTime
    ) => ReadEffectiveMessagesBetween(startTime, endTime);

    IReadOnlyList<ArchiveMessageRecord> IArchiveSession.ReadEffectiveMessagesPage(
        double? first,
        double? last,
        int limit,
        bool descending
    ) => ReadEffectiveMessagesPage(first, last, limit, descending);

    IReadOnlyList<ArchiveBlockRecord> IArchiveSession.ReadEffectiveBlocksRange(
        long first,
        long last
    ) => ReadEffectiveBlocksRange(first, last);

    IReadOnlyList<ArchiveBlockRecord> IArchiveSession.ReadEffectiveBlocksNumericRange(
        double? first,
        double? last
    ) => ReadEffectiveBlocksNumericRange(first, last);

    ArchiveStats IArchiveSession.EffectiveMessageStats(long first, long last) =>
        EffectiveMessageStats(first, last);

    IReadOnlyList<ArchiveBlockTopology> IArchiveSession.EffectiveBlockTopology() =>
        EffectiveBlockTopology();

    long IArchiveSession.EffectiveBlockHighWater() => EffectiveBlockHighWater();

    IReadOnlyList<ArchiveVectorScope> IArchiveSession.VectorLineage() => VectorLineage();
}
