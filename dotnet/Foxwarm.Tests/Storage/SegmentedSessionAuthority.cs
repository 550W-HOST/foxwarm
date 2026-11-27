using System.Runtime.ExceptionServices;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

/// <summary>
/// Test-only Session authority stored as a head plus immutable history segments: the hosted
/// representation the storage design chose for Postgres. Tables are in memory; the Archive is
/// the ordinary SQLite Archive under the data root. It shows that the authority interfaces can
/// be implemented without whole-document writes, and it counts what each commit rewrites.
/// </summary>
internal sealed class SegmentedAuthorityBackend(string dataRoot) : ISessionAuthorityBackend
{
    // session_authority_head and session_history_segment. Segment rows are immutable.
    internal sealed record Head(Guid Lifetime, long Version, string Envelope, long[] Segments);

    private readonly Dictionary<string, Head> heads = new(StringComparer.Ordinal);
    private readonly Dictionary<long, SessionSegmentPiece> segments = [];
    private long nextSegment = 1;

    internal string DataRoot { get; } = Path.GetFullPath(dataRoot);
    internal int HeadWrites { get; private set; }
    internal int RecordsWritten { get; private set; }
    internal int SegmentCount => segments.Count;

    /// <summary>Makes the next commit fail after its Archive rows exist and before it commits.</summary>
    internal bool FailNextCommit { get; set; }

    internal void ResetCounters()
    {
        HeadWrites = 0;
        RecordsWritten = 0;
    }

    public ISessionAuthority Open(
        string sessionId,
        string agent,
        SessionAuthorityCallbacks callbacks
    ) => new SegmentedSessionAuthority(this, sessionId, agent, callbacks);

    public bool Exists(string sessionId) => heads.ContainsKey(sessionId);

    public JsonObject? ReadEnvelope(string sessionId, string agent)
    {
        if (Assemble(sessionId) is not { } raw)
            return null;
        var document = SessionAuthorityDocument.FromOwned(raw, sessionId, agent).CloneRoot();
        document.Remove("history");
        return document;
    }

    public Task<SessionAuthorityRaw?> ReadRawAsync(
        string sessionId,
        CancellationToken token = default
    ) =>
        Task.FromResult(
            Assemble(sessionId) is { } raw
                ? new SessionAuthorityRaw(raw, "session_authority/" + sessionId)
                : null
        );

    public void MoveIdentity(string fromId, string toId)
    {
        // Segments belong to the lifetime, not to the Session ID, so nothing else moves.
        if (!heads.Remove(fromId, out var head))
            return;
        heads[toId] = head;
        HeadWrites++;
    }

    public void ReplaceRaw(string sessionId, JsonObject document)
    {
        var envelope = (JsonObject)document.DeepClone();
        var history = envelope["history"] as JsonArray ?? [];
        envelope["history"] = null;
        var lifetime = heads.TryGetValue(sessionId, out var current)
            ? current.Lifetime
            : Guid.NewGuid();
        var written = SessionSegmentPlanner
            .Cut(0, history.Count, (writer, index) => history[index]!.WriteTo(writer))
            .Select(Insert)
            .ToArray();
        if (current is not null)
            foreach (var segment in current.Segments)
                segments.Remove(segment);
        heads[sessionId] = new(
            lifetime,
            (current?.Version ?? 0) + 1,
            envelope.ToJsonString(),
            written
        );
        HeadWrites++;
    }

    public void DeleteAuthority(string sessionId, Action? removed = null)
    {
        if (heads.Remove(sessionId, out var head))
            foreach (var segment in head.Segments)
                segments.Remove(segment);
        removed?.Invoke();
    }

    public void DeleteLegacyArtifacts(string sessionId, Action? removed = null) =>
        removed?.Invoke();

    internal Head? ReadHead(string sessionId) => heads.GetValueOrDefault(sessionId);

    internal SessionSegmentPiece ReadSegment(long id) => segments[id];

    internal long Insert(SessionSegmentPiece piece)
    {
        var id = nextSegment++;
        segments[id] = piece;
        RecordsWritten += piece.Count;
        return id;
    }

    /// <summary>One transaction: the new head replaces the expected one; dropped segments go.</summary>
    internal void Commit(string sessionId, Head? expected, Head next)
    {
        if (heads.GetValueOrDefault(sessionId) != expected)
            throw new InvalidOperationException("Session authority head changed concurrently.");
        heads[sessionId] = next;
        HeadWrites++;
        if (expected is not null)
            foreach (var segment in expected.Segments.Except(next.Segments))
                segments.Remove(segment);
    }

    internal void Abandon(IEnumerable<long> inserted)
    {
        foreach (var segment in inserted)
            segments.Remove(segment);
    }

    private JsonObject? Assemble(string sessionId)
    {
        if (!heads.TryGetValue(sessionId, out var head))
            return null;
        var raw = (JsonObject)JsonNode.Parse(head.Envelope)!;
        // The envelope keeps the history property's position, so the value equals file mode's.
        raw["history"] = new JsonArray(
            head
                .Segments.SelectMany(id => JsonNode.Parse(segments[id].Records)!.AsArray().ToArray())
                .Select(node => node?.DeepClone())
                .ToArray()
        );
        return raw;
    }
}

internal sealed class SegmentedSessionAuthority(
    SegmentedAuthorityBackend backend,
    string sessionId,
    string agent,
    SessionAuthorityCallbacks callbacks
) : ISessionAuthority
{
    private SqliteArchiveMessageStore archive = OpenArchive(backend.DataRoot, sessionId);
    private bool retired;
    private Exception? identityUnavailable;

    // The last committed history root and the record count of each of its segments.
    private SessionHistory? committed;
    private SessionSegment[] layout = [];

    public string SessionId => sessionId;
    public string Agent => agent;
    public IArchiveSession Archive => archive;
    public Foxwarm.Images.ImageBlobStore Images { get; } = new(backend.DataRoot);

    public void RebindIdentity(string id, string targetAgent)
    {
        archive = OpenArchive(backend.DataRoot, id);
        sessionId = id;
        agent = targetAgent;
    }

    public Task PersistIdentitySnapshotAsync(SessionSnapshot snapshot)
    {
        CheckBound(snapshot);
        Write(snapshot);
        return Task.CompletedTask;
    }

    public void MarkIdentityUnavailable(Exception error) => identityUnavailable = error;

    public void Retire() => retired = true;

    public async Task CommitAsync(
        SessionSnapshot snapshot,
        SaveKind kind,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        CheckBound(snapshot);
        Write(snapshot);
        await PublishAsync(snapshot);
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
        var receipt = await archive.EnqueueMessagesAsync(records);
        var inserted = await receipt.Completion;
        try
        {
            Write(stagedSnapshot);
        }
        catch
        {
            archive.RollbackInsertedMessages(inserted);
            throw;
        }
        Notify(stagedSnapshot, records, []);
        await PublishAsync(stagedSnapshot);
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
        var receipt = await archive.EnqueueCompactionAsync(blocks, records);
        var (newBlocks, newMessages) = await receipt.Completion;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            Write(stagedSnapshot);
        }
        catch
        {
            archive.RollbackInsertedMessages(newMessages);
            archive.RollbackInsertedBlocks(newBlocks);
            throw;
        }
        Notify(stagedSnapshot, records, newBlocks);
        await PublishAsync(stagedSnapshot);
    }

    public Task<SessionSnapshot?> LoadAsync(
        string requestedSessionId,
        CancellationToken cancellationToken = default
    )
    {
        if (requestedSessionId != sessionId)
            throw new InvalidOperationException("Store is bound to another Session.");
        var main = callbacks.MainFields?.Invoke(sessionId);
        if (backend.ReadHead(sessionId) is not { } head)
        {
            if (archive.ReadMessages().Count > 0)
                throw new SessionAuthorityUnavailableException(
                    sessionId,
                    new(null, "Active Session authority is missing while Archive rows exist."),
                    new FileNotFoundException()
                );
            return Task.FromResult<SessionSnapshot?>(null);
        }
        var raw = backend.ReadRawAsync(sessionId).Result!.Document!.AsObject();
        var normalized = SessionAuthorityReader.Normalize(raw, sessionId, agent, main: main);
        var loaded = SessionAuthorityCodec.FromAuthority(normalized, sessionId);
        // Later commits recognize the loaded records by reference.
        committed = loaded.History;
        layout = head
            .Segments.Select(id => new SessionSegment(
                id,
                backend.ReadSegment(id).Count,
                backend.ReadSegment(id).Records.Length
            ))
            .ToArray();
        return Task.FromResult<SessionSnapshot?>(loaded);
    }

    private void Write(SessionSnapshot snapshot)
    {
        var state = SessionAuthorityCodec.PrepareState(
            snapshot,
            sessionId,
            agent,
            callbacks.MainFields?.Invoke(sessionId)
        );
        var current = backend.ReadHead(sessionId);
        var history = snapshot.History;
        // The retained layout describes the head only if nothing else rewrote it meanwhile.
        var known =
            current is not null && current.Segments.SequenceEqual(layout.Select(item => item.Id))
                ? committed
                : null;
        var plan = SessionSegmentPlanner.Plan(known, known is null ? [] : layout, history);
        var kept = layout.Take(plan.KeptSegments).ToList();
        var inserted = new List<long>();
        // The product planner's pieces, validated and serialized as the document writer does.
        foreach (var piece in SessionSegmentPlanner.Cut(history, plan.Start))
        {
            var id = backend.Insert(piece);
            inserted.Add(id);
            kept.Add(new(id, piece.Count, piece.Records.Length));
        }
        if (backend.FailNextCommit)
        {
            backend.FailNextCommit = false;
            backend.Abandon(inserted);
            throw new IOException("Injected failure before the authority transaction commits.");
        }
        backend.Commit(
            sessionId,
            current,
            new(
                current?.Lifetime ?? Guid.NewGuid(),
                (current?.Version ?? 0) + 1,
                state.ToJsonString(),
                kept.Select(item => item.Id).ToArray()
            )
        );
        committed = history;
        layout = kept.ToArray();
    }

    private void CheckBound(SessionSnapshot snapshot)
    {
        if (identityUnavailable is { } error)
            ExceptionDispatchInfo.Capture(error).Throw();
        if (retired)
            throw new InvalidOperationException("Session authority owner has retired.");
        callbacks.CheckLifetime?.Invoke(sessionId);
        if (snapshot.Id != sessionId)
            throw new InvalidOperationException("Store is bound to another Session.");
    }

    private void Notify(
        SessionSnapshot snapshot,
        IReadOnlyList<ArchiveMessageRecord> messages,
        IReadOnlyList<ArchiveBlockRecord> blocks
    )
    {
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
                await publish(snapshot);
        }
        catch (Exception error)
        {
            throw new AuthorityCommittedException(
                "Session authority committed, but its Main catalog projection failed.",
                error
            );
        }
    }

    private static SqliteArchiveMessageStore OpenArchive(string root, string id)
    {
        var store = new SqliteArchiveMessageStore(
            Path.Combine(root, "state", "archive-store.sqlite"),
            id
        );
        store.Initialize();
        return store;
    }
}
