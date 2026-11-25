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
}

/// <summary>
/// Main-owned callbacks of a bound store. Each receives the store's current Session ID, which
/// changes when an identity move rebinds the store.
/// </summary>
internal sealed record SessionAuthorityCallbacks(
    Action<SessionSnapshot>? PublishProjection = null,
    Func<string, JsonObject?>? MainFields = null,
    Action<string>? CheckLifetime = null,
    Action<
        SessionSnapshot,
        IReadOnlyList<ArchiveMessageRecord>,
        IReadOnlyList<ArchiveBlockRecord>
    >? ArchiveCommitted = null
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
    SqliteArchiveMessageStore Archive { get; }
    Foxwarm.Images.ImageBlobStore Images { get; }

    /// <summary>Binds the store to a new identity. The caller holds the owner's lane.</summary>
    void RebindIdentity(string sessionId, string agent);

    /// <summary>Writes the complete snapshot under the current identity, without projection.</summary>
    Task PersistIdentitySnapshotAsync(SessionSnapshot snapshot);

    void MarkIdentityUnavailable(Exception error);

    /// <summary>Rejects every later write.</summary>
    void Retire();
}
