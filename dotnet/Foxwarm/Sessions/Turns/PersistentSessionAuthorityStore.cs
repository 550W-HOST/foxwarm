using System.Runtime.ExceptionServices;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

/// <summary>
/// File implementation of <see cref="ISessionAuthority"/>: one complete active JSON document per
/// Session, while Archive rows are immutable audit records. Opened through
/// <see cref="FileSessionAuthorityBackend"/>; tests may construct it directly.
/// All calls are expected to be serialized by one SessionSaveLane.
/// </summary>
public sealed class PersistentSessionAuthorityStore : ISessionAuthority
{
    private string sessionId;
    private string agent;
    private AtomicJsonFile authorityFile;
    private SqliteArchiveMessageStore archive;
    private readonly string root;
    internal Foxwarm.Images.ImageBlobStore Images { get; }
    private readonly Action<AtomicJsonWriteStage>? authorityStageHook;
    private readonly Func<int, CancellationToken, Task>? canonicalCommitBarrier;
    private int canonicalCommitCount;
    private readonly Func<SessionSnapshot, Task>? publishProjection;
    private readonly Func<JsonObject?>? mainFields;
    private readonly Action? checkLifetime;
    private readonly Action<
        SessionSnapshot,
        IReadOnlyList<ArchiveMessageRecord>,
        IReadOnlyList<ArchiveBlockRecord>
    >? archiveCommitted;
    private volatile bool retired;
    private Exception? identityUnavailable;

    internal void MarkIdentityUnavailable(Exception error) =>
        Volatile.Write(ref identityUnavailable, error);

    internal void Retire() => retired = true;

    private void CheckWrite()
    {
        if (Volatile.Read(ref identityUnavailable) is { } error)
            throw error;
        if (retired)
            throw new InvalidOperationException("Session authority owner has retired.");
        checkLifetime?.Invoke();
    }

    internal PersistentSessionAuthorityStore(
        string root,
        string sessionId,
        string agent = "main",
        Action<AtomicJsonWriteStage>? authorityStageHook = null,
        Func<int, CancellationToken, Task>? canonicalCommitBarrier = null,
        Func<SessionSnapshot, Task>? publishProjection = null,
        Func<JsonObject?>? mainFields = null,
        Action? checkLifetime = null,
        Action<
            SessionSnapshot,
            IReadOnlyList<ArchiveMessageRecord>,
            IReadOnlyList<ArchiveBlockRecord>
        >? archiveCommitted = null,
        Foxwarm.Storage.IBlobStore? imageBlobs = null
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(agent);
        this.root = root;
        Images = new(root, imageBlobs);
        this.authorityStageHook = authorityStageHook;
        this.sessionId = sessionId;
        this.agent = agent;
        this.canonicalCommitBarrier = canonicalCommitBarrier;
        this.publishProjection = publishProjection;
        this.mainFields = mainFields;
        this.checkLifetime = checkLifetime;
        this.archiveCommitted = archiveCommitted;
        authorityFile = new AtomicJsonFile(
            root,
            $"state/sessions/{sessionId}.json",
            authorityStageHook
        );
        archive = new SqliteArchiveMessageStore(
            Path.Combine(root, "state", "archive-store.sqlite"),
            sessionId
        );
        archive.Initialize();
    }

    internal string SessionId => sessionId;
    internal string Agent => agent;
    string ISessionAuthority.SessionId => sessionId;
    string ISessionAuthority.Agent => agent;
    Foxwarm.Images.ImageBlobStore ISessionAuthority.Images => Images;
    IArchiveSession ISessionAuthority.Archive => archive;

    void ISessionAuthority.RebindIdentity(string sessionId, string agent) =>
        RebindIdentity(sessionId, agent);

    Task ISessionAuthority.PersistIdentitySnapshotAsync(SessionSnapshot snapshot) =>
        PersistIdentitySnapshotAsync(snapshot);

    void ISessionAuthority.MarkIdentityUnavailable(Exception error) =>
        MarkIdentityUnavailable(error);

    void ISessionAuthority.Retire() => Retire();

    internal void RebindIdentity(string id, string targetAgent)
    {
        // Caller owns the ordered lane; no old-bound commit can overlap replacement.
        var next = new SqliteArchiveMessageStore(ArchivePath, id);
        next.Initialize();
        sessionId = id;
        agent = targetAgent;
        archive = next;
        authorityFile = new AtomicJsonFile(
            root,
            $"state/sessions/{id}.json",
            authorityStageHook
        );
    }

    public string AuthorityPath => authorityFile.FilePath;
    public string ArchivePath => archive.DatabasePath;
    public DirectorySyncResult LastDirectorySyncResult => authorityFile.LastDirectorySyncResult;
    public SqliteArchiveMessageStore Archive => archive;

    internal Task PersistIdentitySnapshotAsync(SessionSnapshot snapshot)
    {
        ValidateBoundSnapshot(snapshot);
        WriteAuthority(snapshot);
        return Task.CompletedTask;
    }

    public async Task CommitAsync(
        SessionSnapshot snapshot,
        SaveKind kind,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateBoundSnapshot(snapshot);
        AuthorityCommittedException? publicationError = null;
        try
        {
            WriteAuthority(snapshot);
        }
        catch (AuthorityCommittedException error)
        {
            publicationError = error;
        }
        await PublishProjectionAsync(snapshot, publicationError).ConfigureAwait(false);
    }

    public async Task CommitCanonicalAppendAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<JsonObject> appendedMessages,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateBoundSnapshot(stagedSnapshot);
        var records = appendedMessages
            .Select(message => SessionAuthorityCodec.ToArchiveRecord(message, sessionId, agent))
            .ToArray();
        var receipt = await archive.EnqueueMessagesAsync(records).ConfigureAwait(false);
        IReadOnlyList<ArchiveMessageRecord> inserted = [];
        var published = false;
        AuthorityCommittedException? publicationError = null;
        try
        {
            var state = SessionAuthorityCodec.PrepareState(
                stagedSnapshot,
                sessionId,
                agent,
                mainFields?.Invoke()
            );
            await authorityFile
                .WriteStreamPayloadAsync(
                    stream =>
                        SessionAuthorityDocument.WriteTo(stream, state, stagedSnapshot.History),
                    async () =>
                    {
                        if (canonicalCommitBarrier is not null)
                            await canonicalCommitBarrier(
                                    Interlocked.Increment(ref canonicalCommitCount),
                                    cancellationToken
                                )
                                .ConfigureAwait(false);
                        inserted = await receipt.Completion.ConfigureAwait(false);
                    },
                    default
                )
                .ConfigureAwait(false);
            published = true;
        }
        catch (AuthorityCommittedException error)
        {
            published = true;
            publicationError = error;
        }
        catch (Exception writeError)
        {
            try
            {
                // Preparation can fail before the receipt settles. Resolve it before exact compensation.
                inserted = await receipt.Completion.ConfigureAwait(false);
                archive.RollbackInsertedMessages(inserted);
            }
            catch (Exception rollbackError)
            {
                if (ReferenceEquals(writeError, rollbackError))
                    throw;
                throw new AggregateException(
                    "Authority precommit failed and exact Archive rollback also failed.",
                    writeError,
                    rollbackError
                );
            }
            throw;
        }
        finally
        {
            if (published)
                NotifyArchiveCommitted(stagedSnapshot, records, []);
        }
        await PublishProjectionAsync(stagedSnapshot, publicationError).ConfigureAwait(false);
    }

    public async Task CommitCompactionAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<JsonObject> messages,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateBoundSnapshot(stagedSnapshot);
        var records = messages
            .Select(message => SessionAuthorityCodec.ToArchiveRecord(message, sessionId, agent))
            .ToArray();
        var receipt = await archive.EnqueueCompactionAsync(blocks, records).ConfigureAwait(false);
        IReadOnlyList<ArchiveBlockRecord> newBlocks = [];
        IReadOnlyList<ArchiveMessageRecord> newMessages = [];
        var published = false;
        AuthorityCommittedException? publicationError = null;
        try
        {
            var state = SessionAuthorityCodec.PrepareState(
                stagedSnapshot,
                sessionId,
                agent,
                mainFields?.Invoke()
            );
            await authorityFile
                .WriteStreamPayloadAsync(
                    stream =>
                        SessionAuthorityDocument.WriteTo(stream, state, stagedSnapshot.History),
                    async () =>
                    {
                        (newBlocks, newMessages) = await receipt.Completion.ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                    },
                    cancellationToken
                )
                .ConfigureAwait(false);
            published = true;
        }
        catch (AuthorityCommittedException error)
        {
            published = true;
            publicationError = error;
        }
        catch (Exception error)
        {
            try
            {
                (newBlocks, newMessages) = await receipt.Completion.ConfigureAwait(false);
                archive.RollbackInsertedMessages(newMessages);
                archive.RollbackInsertedBlocks(newBlocks);
            }
            catch (Exception rollback)
            {
                if (ReferenceEquals(error, rollback))
                    throw;
                throw new AggregateException("Compact precommit rollback failed.", error, rollback);
            }
            throw;
        }
        finally
        {
            if (published)
                NotifyArchiveCommitted(stagedSnapshot, records, newBlocks);
        }
        await PublishProjectionAsync(stagedSnapshot, publicationError).ConfigureAwait(false);
    }

    private void NotifyArchiveCommitted(
        SessionSnapshot snapshot,
        IReadOnlyList<ArchiveMessageRecord> messages,
        IReadOnlyList<ArchiveBlockRecord> blocks
    )
    {
        // Derived indexing cannot change the result of an authority commit, including a post-rename failure.
        try
        {
            archiveCommitted?.Invoke(snapshot, messages, blocks);
        }
        catch { }
    }

    private async Task PublishProjectionAsync(
        SessionSnapshot snapshot,
        AuthorityCommittedException? publicationError
    )
    {
        // Known publication still needs its normal projection attempt before reporting durability failure.
        try
        {
            if (publishProjection is not null)
                await publishProjection(snapshot).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            throw new AuthorityCommittedException(
                "Session authority committed, but its Main catalog projection failed.",
                publicationError is null ? error : new AggregateException(publicationError, error)
            );
        }
        if (publicationError is not null)
            ExceptionDispatchInfo.Capture(publicationError).Throw();
    }

    public async Task<SessionSnapshot?> LoadAsync(
        string requestedSessionId,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (requestedSessionId != sessionId)
            throw new InvalidOperationException(
                $"Persistent store is bound to Session '{sessionId}', not '{requestedSessionId}'."
            );
        // Main-owned fields may read Catalog; keep that global failure outside the local reader.
        var main = mainFields?.Invoke();
        JsonObject normalized;
        try
        {
            normalized = SessionAuthorityReader.Read(root, sessionId, agent, main: main);
        }
        catch (SessionAuthorityUnavailableException error)
            when (error.InnerException is FileNotFoundException or DirectoryNotFoundException)
        {
            if (archive.ReadMessages().Count > 0)
                throw new SessionAuthorityUnavailableException(
                    sessionId,
                    new(
                        null,
                        "Active Session authority is missing while Archive rows exist; Archive cannot rebuild active history."
                    ),
                    error
                );
            return null;
        }
        return await SessionAuthorityIngress.FromNormalizedAsync(
            Images,
            normalized,
            sessionId,
            cancellationToken
        );
    }

    private void ValidateBoundSnapshot(SessionSnapshot snapshot)
    {
        CheckWrite();
        if (snapshot.Id != sessionId)
            throw new InvalidOperationException(
                $"Persistent store is bound to Session '{sessionId}', not '{snapshot.Id}'."
            );
    }

    private void WriteAuthority(SessionSnapshot snapshot)
    {
        var state = SessionAuthorityCodec.PrepareState(
            snapshot,
            sessionId,
            agent,
            mainFields?.Invoke()
        );
        authorityFile.WriteStreamPayload(
            stream => SessionAuthorityDocument.WriteTo(stream, state, snapshot.History),
            default
        );
    }
}
