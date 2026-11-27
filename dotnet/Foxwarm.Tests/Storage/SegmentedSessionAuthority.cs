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
    private readonly Dictionary<long, string[]> segments = [];
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
        var history = (envelope["history"] as JsonArray ?? [])
            .Select(node => node!.ToJsonString())
            .ToArray();
        envelope["history"] = null;
        var lifetime = heads.TryGetValue(sessionId, out var current)
            ? current.Lifetime
            : Guid.NewGuid();
        var written = history.Length == 0 ? [] : new[] { Insert(history) };
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

    internal IReadOnlyList<string> ReadSegment(long id) => segments[id];

    internal long Insert(string[] records)
    {
        var id = nextSegment++;
        segments[id] = records;
        RecordsWritten += records.Length;
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
                .Segments.SelectMany(id => segments[id])
                .Select(text => JsonNode.Parse(text))
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
    private int[] layout = [];

    public string SessionId => sessionId;
    public string Agent => agent;
    public SqliteArchiveMessageStore Archive => archive;
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

    public Task CommitAsync(
        SessionSnapshot snapshot,
        SaveKind kind,
        CancellationToken cancellationToken = default
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        CheckBound(snapshot);
        Write(snapshot);
        Publish(snapshot);
        return Task.CompletedTask;
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
        Publish(stagedSnapshot);
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
        Publish(stagedSnapshot);
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
        layout = head.Segments.Select(id => backend.ReadSegment(id).Count).ToArray();
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
        // The same record validation the file writer applies to every history record.
        SessionAuthorityDocument.WriteTo(Stream.Null, state, snapshot.History);
        var current = backend.ReadHead(sessionId);
        var history = snapshot.History;
        // The retained layout describes the head only if nothing else rewrote it meanwhile.
        var known =
            current is not null && current.Segments.Length == layout.Length ? committed : null;
        // k: the longest prefix whose records are the committed records themselves.
        var kept = 0;
        if (known is not null)
            while (
                kept < known.Count
                && kept < history.Count
                && ReferenceEquals(known[kept], history[kept])
            )
                kept++;
        // Keep whole segments inside [0, k); rewrite from the first segment that isn't.
        var keptSegments = new List<long>();
        var keptLayout = new List<int>();
        var start = 0;
        if (known is not null && current is not null)
            for (var index = 0; index < layout.Length; index++)
            {
                if (start + layout[index] > kept)
                    break;
                keptSegments.Add(current.Segments[index]);
                keptLayout.Add(layout[index]);
                start += layout[index];
            }
        var inserted = new List<long>();
        if (start < history.Count)
        {
            var tail = Enumerable
                .Range(start, history.Count - start)
                .Select(index => history[index].ToJsonString())
                .ToArray();
            inserted.Add(backend.Insert(tail));
            keptSegments.AddRange(inserted);
            keptLayout.Add(tail.Length);
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
                keptSegments.ToArray()
            )
        );
        committed = history;
        layout = keptLayout.ToArray();
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

    private void Publish(SessionSnapshot snapshot)
    {
        try
        {
            callbacks.PublishProjection?.Invoke(snapshot);
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
