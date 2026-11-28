using System.Runtime.ExceptionServices;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres.Authority;

/// <summary>
/// One Session lifetime's authority in PostgreSQL. Each commit is one <see cref="TenantDb"/>
/// transaction: the Archive rows it carries, the new segments and parts, the deletion of the
/// replaced ones, and the head's compare-and-set on <c>doc_version</c> with a fresh
/// <c>commit_id</c>. A lost <c>COMMIT</c> is resolved by reading the <c>commit_id</c> back.
/// The catalog projection follows the commit, as in file mode. All calls are serialized by the
/// owner's <see cref="SessionSaveLane"/>.
/// </summary>
internal sealed class PostgresSessionAuthority : ISessionAuthority
{
    // The last head this store committed or loaded, with the history root it holds. Later
    // commits recognize that root's records by reference and keep the segments holding them.
    private sealed record Known(SessionHistory History, PgSessionHead Head);

    private sealed record Stored(
        PgSessionHead? Head,
        JsonObject? Document,
        SessionSegment[]? Layout,
        bool ArchiveRows
    );

    private readonly PostgresSessionAuthorityBackend backend;
    private readonly SessionAuthorityCallbacks callbacks;
    private string sessionId;
    private string agent;
    private IArchiveSession? archive;
    private Known? known;
    private volatile bool retired;
    private Exception? identityUnavailable;

    internal PostgresSessionAuthority(
        PostgresSessionAuthorityBackend backend,
        string sessionId,
        string agent,
        SessionAuthorityCallbacks callbacks
    )
    {
        this.backend = backend;
        this.sessionId = sessionId;
        this.agent = agent;
        this.callbacks = callbacks;
        Images = new(
            backend.ScratchRoot,
            callbacks.ImageBlobs ?? backend.ImageBlobs,
            Foxwarm.Images.TenantImageDecoder.ForTenant(backend.Database.TenantId)
        );
    }

    public string SessionId => sessionId;

    public Task<long?> PersistedHistoryBytesAsync(CancellationToken token)
    {
        var id = sessionId;
        return backend.Database.ReadAsync(
            async (tx, cancel) =>
                await tx.Command(
                        "SELECT sum(s.byte_length) FROM session_heads h JOIN session_segments s"
                            + " ON s.lifetime_id = h.lifetime_id AND s.segment_id = ANY(h.segment_ids)"
                            + " WHERE h.session_id = $1",
                        id
                    )
                    .ExecuteScalarAsync(cancel)
                    .ConfigureAwait(false) is long bytes
                    ? bytes
                    : (long?)null,
            token: token
        );
    }

    public string Agent => agent;

    public IArchiveSession Archive =>
        archive ??=
            backend.Archive?.Invoke(sessionId)
            ?? throw new NotSupportedException("This build has no PostgreSQL Archive store.");

    public Foxwarm.Images.ImageBlobStore Images { get; }

    public void RebindIdentity(string id, string targetAgent)
    {
        // The caller holds the owner's lane. The head moved with the identity, so the known
        // head still describes it.
        sessionId = id;
        agent = targetAgent;
        archive = null;
    }

    public async Task PersistIdentitySnapshotAsync(SessionSnapshot snapshot)
    {
        CheckBound(snapshot);
        await WriteAsync(snapshot, null, compaction: false, default).ConfigureAwait(false);
    }

    public void MarkIdentityUnavailable(Exception error) =>
        Volatile.Write(ref identityUnavailable, error);

    public void Retire() => retired = true;

    public async Task CommitAsync(
        SessionSnapshot snapshot,
        SaveKind kind,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        CheckBound(snapshot);
        await WriteAsync(snapshot, null, compaction: false, default).ConfigureAwait(false);
        await PublishAsync(snapshot).ConfigureAwait(false);
    }

    public async Task CommitCanonicalAppendAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<JsonObject> appendedMessages,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        CheckBound(stagedSnapshot);
        var records = appendedMessages
            .Select(message => SessionAuthorityCodec.ToArchiveRecord(message, sessionId, agent))
            .ToArray();
        // Admission runs before any transaction, as in the file Archive.
        var batch = PgArchiveBatch.Prepare(sessionId, [], records);
        await WriteAsync(stagedSnapshot, batch, compaction: false, default).ConfigureAwait(false);
        Notify(stagedSnapshot, records, []);
        await PublishAsync(stagedSnapshot).ConfigureAwait(false);
    }

    public async Task CommitCompactionAsync(
        SessionSnapshot stagedSnapshot,
        IReadOnlyList<ArchiveBlockRecord> blocks,
        IReadOnlyList<JsonObject> messages,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        CheckBound(stagedSnapshot);
        var records = messages
            .Select(message => SessionAuthorityCodec.ToArchiveRecord(message, sessionId, agent))
            .ToArray();
        var batch = PgArchiveBatch.Prepare(sessionId, blocks, records);
        var inserted = await WriteAsync(stagedSnapshot, batch, compaction: true, cancellationToken)
            .ConfigureAwait(false);
        Notify(stagedSnapshot, records, inserted.Blocks);
        await PublishAsync(stagedSnapshot).ConfigureAwait(false);
    }

    public async Task<SessionSnapshot?> LoadAsync(
        string requestedSessionId,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (requestedSessionId != sessionId)
            throw new InvalidOperationException(
                $"Session authority is bound to Session '{sessionId}', not '{requestedSessionId}'."
            );
        // Main-owned fields may read Catalog; keep that global failure outside the local read.
        var main = callbacks.MainFields?.Invoke(sessionId);
        var id = sessionId;
        var read = await backend
            .Database.ReadAsync(
                async (tx, token) =>
                {
                    var head = await PgSessionRows
                        .ReadHeadAsync(tx, id, forUpdate: false, async: true, token)
                        .ConfigureAwait(false);
                    if (head is null)
                    {
                        var rows = tx.Scalar(
                            "SELECT 1 FROM archive_messages WHERE session_id = $1 LIMIT 1",
                            id
                        );
                        return new Stored(null, null, null, rows is not null);
                    }
                    try
                    {
                        var (document, layout) = await PgSessionRows
                            .AssembleAsync(tx, head, async: true, token)
                            .ConfigureAwait(false);
                        return new Stored(head, document, layout, false);
                    }
                    catch (Exception error)
                        when (error
                                is InvalidDataException
                                    or UnsupportedSessionAuthorityException
                                    or System.Text.Json.JsonException
                                    or System.Text.DecoderFallbackException
                        )
                    {
                        throw SessionAuthorityErrors.Unavailable(id, error);
                    }
                },
                snapshot: true,
                token: cancellationToken
            )
            .ConfigureAwait(false);
        if (read.Head is null)
        {
            if (read.ArchiveRows)
                throw new SessionAuthorityUnavailableException(
                    id,
                    new(
                        null,
                        "Active Session authority is missing while Archive rows exist; Archive cannot rebuild active history."
                    ),
                    new FileNotFoundException("No Session authority head is stored.")
                );
            return null;
        }
        var normalized = SessionAuthorityReader.Normalize(read.Document!, id, agent, main: main);
        var loaded = await SessionAuthorityIngress
            .FromNormalizedAsync(Images, normalized, id, cancellationToken)
            .ConfigureAwait(false);
        known = new(loaded.History, read.Head with { Layout = read.Layout! });
        return loaded;
    }

    private async Task<PgArchiveInserted> WriteAsync(
        SessionSnapshot snapshot,
        PgArchiveBatch? rows,
        bool compaction,
        CancellationToken cancellationToken
    )
    {
        var state = SessionAuthorityCodec.PrepareState(
            snapshot,
            sessionId,
            agent,
            callbacks.MainFields?.Invoke(sessionId)
        );
        var envelope = PgSessionEnvelope.Encode(state);
        var history = snapshot.History;
        var basis = known;
        var plan = basis is null
            ? new SessionSegmentPlan(0, 0)
            : SessionSegmentPlanner.Plan(basis.History, basis.Head.Layout, history);
        var id = sessionId;
        var commitId = Guid.NewGuid();
        (PgSessionCommitted Committed, PgArchiveInserted Inserted) result;
        try
        {
            result = await backend
                .Database.WriteAsync(
                    async (tx, token) =>
                    {
                        var inserted = rows is null || rows.IsEmpty
                            ? PgArchiveInserted.None
                            : await PgArchiveRows.InsertAsync(tx, rows, token).ConfigureAwait(false);
                        // Without a known head, the stored one (if any) is replaced completely.
                        var current =
                            basis?.Head
                            ?? await PgSessionRows
                                .ReadHeadAsync(tx, id, forUpdate: true, async: true, token)
                                .ConfigureAwait(false);
                        var committed = await PgSessionRows
                            .CommitAsync(
                                tx,
                                id,
                                current,
                                plan.KeptSegments,
                                SessionSegmentPlanner.Cut(history, plan.Start),
                                envelope,
                                commitId,
                                async: true,
                                token
                            )
                            .ConfigureAwait(false);
                        backend.BeforeCommit?.Invoke(id);
                        // A cancelled compaction leaves nothing behind.
                        if (compaction)
                            cancellationToken.ThrowIfCancellationRequested();
                        return (committed, inserted);
                    },
                    new PgWriteOptions(Verify: tx => PgSessionRows.Committed(tx, commitId)),
                    cancellationToken
                )
                .ConfigureAwait(false);
        }
        catch (Exception error) when (error is SessionHeadChangedException or CommitOutcomeUnknownException)
        {
            // The stored head is no longer known; the next commit rereads and rewrites it.
            known = null;
            throw;
        }
        var head = result.Committed;
        known = new(history, new(head.Lifetime, head.Version, [], head.Parts, head.Layout));
        backend.Observe(result.Committed.Stats);
        return result.Inserted;
    }

    private void CheckBound(SessionSnapshot snapshot)
    {
        if (Volatile.Read(ref identityUnavailable) is { } error)
            ExceptionDispatchInfo.Capture(error).Throw();
        if (retired)
            throw new InvalidOperationException("Session authority owner has retired.");
        callbacks.CheckLifetime?.Invoke(sessionId);
        if (snapshot.Id != sessionId)
            throw new InvalidOperationException(
                $"Session authority is bound to Session '{sessionId}', not '{snapshot.Id}'."
            );
    }

    private void Notify(
        SessionSnapshot snapshot,
        IReadOnlyList<ArchiveMessageRecord> messages,
        IReadOnlyList<ArchiveBlockRecord> blocks
    )
    {
        // Derived indexing cannot change the result of an authority commit.
        try
        {
            callbacks.ArchiveCommitted?.Invoke(snapshot, messages, blocks);
        }
        catch { }
    }

    private async Task PublishAsync(SessionSnapshot snapshot)
    {
        try
        {
            if (callbacks.PublishProjection is { } publish)
                await publish(snapshot).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            throw new AuthorityCommittedException(
                "Session authority committed, but its Main catalog projection failed.",
                error
            );
        }
    }
}
