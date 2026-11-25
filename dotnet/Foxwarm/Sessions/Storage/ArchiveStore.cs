using Foxwarm.Persistence;

namespace Foxwarm.Sessions;

/// <summary>
/// One Session's view of the immutable Archive: messages, blocks and its branch lineage.
/// Rows are immutable; exact replay is idempotent, a conflicting row fails closed, and
/// rollback removes only rows the same attempt inserted. The file implementation is
/// <see cref="SqliteArchiveMessageStore"/>.
/// </summary>
internal interface IArchiveSession
{
    string SessionId { get; }

    /// <summary>The current identity the reservation graph resolves this Session to.</summary>
    string CanonicalSessionId { get; }

    bool HasReadOnlyIdentity();

    ValueTask<WriteReceipt<IReadOnlyList<ArchiveMessageRecord>>> EnqueueMessagesAsync(
        IReadOnlyList<ArchiveMessageRecord> records
    );

    ValueTask<
        WriteReceipt<(
            IReadOnlyList<ArchiveBlockRecord> Blocks,
            IReadOnlyList<ArchiveMessageRecord> Messages
        )>
    > EnqueueCompactionAsync(
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<ArchiveMessageRecord> messages
    );

    IReadOnlyList<ArchiveMessageRecord> WriteMessages(IReadOnlyList<ArchiveMessageRecord> records);
    IReadOnlyList<ArchiveBlockRecord> WriteBlocks(IReadOnlyList<ArchiveBlockRecord> records);
    void RollbackInsertedMessages(IReadOnlyList<ArchiveMessageRecord> records);
    void RollbackInsertedBlocks(IReadOnlyList<ArchiveBlockRecord> blocks);

    IReadOnlyList<ArchiveMessageRecord> ReadMessages();
    IReadOnlyList<ArchiveMessageRecord> ReadMessagesRange(long startSeq, long endSeq);
    IReadOnlyList<ArchiveMessageRecord> ReadMessagesNumericRange(
        double? startSeq,
        double? endSeq,
        int? limit = null,
        bool descending = false,
        bool substantiveWindow = false,
        long? startTime = null,
        long? endTime = null
    );
    ArchiveMessageRecord? ReadMessageBySeq(long seq);
    ArchiveStats MessageStats(long first = 1, long last = 9007199254740991);

    IReadOnlyList<ArchiveBlockRecord> ReadBlocks();
    IReadOnlyList<ArchiveBlockRecord> ReadBlocksRange(long first, long last);
    IReadOnlyList<ArchiveBlockRecord> ReadBlocksNumericRange(
        double? first,
        double? last,
        int? limit = null,
        bool descending = false,
        long? startTime = null,
        long? endTime = null
    );
    IReadOnlyList<ArchiveBlockTopology> BlockTopology();

    ArchiveBranch? ReadBranch();
    ArchiveBranch? EnsureBranch(string? parent = null, long messageCap = 0, long blockCap = 0);
    void RollbackInsertedBranch(ArchiveBranch? branch);

    // Effective views include the inherited part of a fork's lineage.
    IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesRange(long first, long last);
    IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesNumericRange(
        double? first,
        double? last
    );
    IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesBetween(long startTime, long endTime);
    IReadOnlyList<ArchiveMessageRecord> ReadEffectiveMessagesPage(
        double? first,
        double? last,
        int limit,
        bool descending = false
    );
    IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksRange(long first, long last);
    IReadOnlyList<ArchiveBlockRecord> ReadEffectiveBlocksNumericRange(double? first, double? last);
    ArchiveStats EffectiveMessageStats(long first = 1, long last = 9007199254740991);
    IReadOnlyList<ArchiveBlockTopology> EffectiveBlockTopology();
    long EffectiveBlockHighWater();

    /// <summary>The Archive scopes of this Session's lineage, for Vector search filters.</summary>
    IReadOnlyList<ArchiveVectorScope> VectorLineage();
}

/// <summary>
/// The installation's Archive: per-Session views, the single writer, committed identities and
/// the cross-Session queries Main runs over it. The file implementation is
/// <see cref="SqliteArchiveStore"/>.
/// </summary>
internal interface IArchiveStore
{
    /// <summary>A read and write view of one Session. Opening it performs no I/O.</summary>
    IArchiveSession ForSession(string sessionId);

    /// <summary>Holds the runtime's Archive writer for its lifetime.</summary>
    IAsyncDisposable AcquireWriter();

    /// <summary>
    /// The committed identity the reservation graph resolves <paramref name="sessionId"/> to, or
    /// null while no Archive exists. An unreadable mapping throws <see cref="InvalidDataException"/>.
    /// </summary>
    string? ResolveCommittedIdentity(string sessionId);

    /// <summary>Whether any message, block, branch or reservation names this Session ID.</summary>
    Task<bool> HasLifetimeRowsAsync(string sessionId);

    /// <summary>
    /// Per Session: its own message count (a fork's after its fork point) and the sequence of its
    /// newest message, inherited history included. Sessions without rows are omitted only when no
    /// Archive exists.
    /// </summary>
    Dictionary<string, (long Count, long Latest)> SequenceCounts(string[] ids);

    /// <summary>Moves every row of one identity to another during a proven identity move.</summary>
    void RenameIdentity(string fromId, string toId);

    /// <summary>A reader for identity and first-message facts, or null while no Archive exists.</summary>
    IArchiveIdentityReader? OpenIdentityReader();

    /// <summary>A reader for cross-Session sequence paging, or null while no Archive exists.</summary>
    IArchiveSequenceReader? OpenSequenceReader();
}

internal interface IArchiveIdentityReader : IDisposable
{
    /// <summary>Resolves an ID through the reservation graph; throws on an unreadable mapping.</summary>
    string Resolve(string sessionId);

    /// <summary>Floored timestamp and Agent of the identity's first message, or null.</summary>
    (long? Start, string? Agent)? FirstMessage(string canonicalSessionId);
}

internal interface IArchiveSequenceReader : IDisposable
{
    ArchiveSpan? Span(SessionCatalog.SequenceSession session);
    long SeqBefore(string sessionId, ArchiveSpan span, ArchiveSequenceCursor? cursor);
    List<(long Seq, double Timestamp)> Positions(ArchiveSpan span, long high, int count);
    ArchiveSequencePage ReadRange(string sessionId, ArchiveSpan span, long low, long high);
    ArchiveSequencePage ReadAfter(
        string sessionId,
        ArchiveSpan span,
        long? afterSeq,
        double since,
        int limit
    );
}
