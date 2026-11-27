using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Installation-level access to Session authority. Domain code opens bound stores and reads
/// authority through this backend and never builds authority paths. The file implementation
/// keeps one complete JSON document per Session; a head-plus-segments implementation must give
/// the same observable results.
/// </summary>
internal interface ISessionAuthorityBackend
{
    /// <summary>Opens the store bound to one Session lifetime. It performs no authority I/O.</summary>
    ISessionAuthority Open(string sessionId, string agent, SessionAuthorityCallbacks callbacks);

    /// <summary>True when an authority exists for the ID. No validation, no hydration.</summary>
    bool Exists(string sessionId);

    /// <summary>
    /// The validated authority without its <c>history</c>, or null when absent. Validation and
    /// errors match a load; there is no Main overlay and no image work.
    /// </summary>
    JsonObject? ReadEnvelope(string sessionId, string agent);

    /// <summary>
    /// The stored document as persisted, with history in order and without normalization, for
    /// the administrator debug view and identity recovery. Null when absent.
    /// </summary>
    Task<SessionAuthorityRaw?> ReadRawAsync(string sessionId, CancellationToken token = default);

    /// <summary>
    /// Renames the authority's storage key during an identity move without changing its content.
    /// A missing source is a no-op, so recovery can replay it.
    /// </summary>
    void MoveIdentity(string fromId, string toId);

    /// <summary>
    /// Pending-move recovery only: stores a document read with <see cref="ReadRawAsync"/> and
    /// edited in its identity fields, as given and without normalization.
    /// </summary>
    void ReplaceRaw(string sessionId, JsonObject document);

    /// <summary>
    /// Removes the active authority of a retired lifetime. Absence isn't an error.
    /// <paramref name="removed"/> runs once the authority is no longer visible, before the
    /// removal is known to be durable; the method returns after it is durable.
    /// </summary>
    void DeleteAuthority(string sessionId, Action? removed = null);

    /// <summary>
    /// Removes per-Session artifacts that only older file layouts wrote, with the same
    /// <paramref name="removed"/> stage as <see cref="DeleteAuthority"/>. Absence isn't an error.
    /// </summary>
    void DeleteLegacyArtifacts(string sessionId, Action? removed = null);
}

/// <summary>
/// A stored authority document. <see cref="Document"/> is whatever JSON value is stored;
/// <see cref="Locator"/> names its storage location for administrators.
/// </summary>
internal sealed record SessionAuthorityRaw(JsonNode? Document, string Locator);

/// <summary>
/// Main-owned callbacks of a bound store. Each receives the store's current Session ID, which
/// changes when an identity move rebinds the store.
/// </summary>
internal sealed record SessionAuthorityCallbacks(
    Func<SessionSnapshot, Task>? PublishProjection = null,
    Func<string, JsonObject?>? MainFields = null,
    Action<string>? CheckLifetime = null,
    Action<
        SessionSnapshot,
        IReadOnlyList<ArchiveMessageRecord>,
        IReadOnlyList<ArchiveBlockRecord>
    >? ArchiveCommitted = null,
    // The blob store the authority's image writer uses instead of the backend's: the tenant's
    // limited one, so queue ingress, tool results and migrations count against its limit.
    Foxwarm.Storage.IBlobStore? ImageBlobs = null
);

/// <summary>
/// One bound Session lifetime. Its owner's <see cref="SessionSaveLane"/> serializes every call.
/// </summary>
internal interface ISessionAuthority
    : ISessionAuthorityStore,
        ICanonicalAppendAuthorityStore,
        ICompactionAuthorityStore
{
    string SessionId { get; }
    string Agent { get; }
    IArchiveSession Archive { get; }
    Foxwarm.Images.ImageBlobStore Images { get; }

    /// <summary>Binds the store to a new identity. The caller holds the owner's lane.</summary>
    void RebindIdentity(string sessionId, string agent);

    /// <summary>Writes the complete snapshot under the current identity, without projection.</summary>
    Task PersistIdentitySnapshotAsync(SessionSnapshot snapshot);

    void MarkIdentityUnavailable(Exception error);

    /// <summary>Rejects every later write.</summary>
    void Retire();

    /// <summary>
    /// The stored size of the bound Session's history, read without loading it (the hot-owner
    /// reservation of a cold load); null when unknown.
    /// </summary>
    Task<long?> PersistedHistoryBytesAsync(CancellationToken token) => Task.FromResult<long?>(null);
}
