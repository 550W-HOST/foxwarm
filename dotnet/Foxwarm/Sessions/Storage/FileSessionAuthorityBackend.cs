namespace Foxwarm.Sessions;

/// <summary>
/// File-mode Session authority: <c>state/sessions/&lt;id&gt;.json</c> under the data root, written
/// as a complete document per commit by <see cref="PersistentSessionAuthorityStore"/>.
/// </summary>
internal sealed class FileSessionAuthorityBackend(
    string dataRoot,
    Action<string, AtomicJsonWriteStage>? authorityStageHook = null,
    Func<string, int, CancellationToken, Task>? canonicalCommitBarrier = null
) : ISessionAuthorityBackend
{
    private readonly string root = Path.GetFullPath(dataRoot);

    public ISessionAuthority Open(
        string sessionId,
        string agent,
        SessionAuthorityCallbacks callbacks
    )
    {
        // The hooks and callbacks receive the store's current identity, which a move can rebind.
        PersistentSessionAuthorityStore store = null!;
        store = new PersistentSessionAuthorityStore(
            root,
            sessionId,
            agent,
            authorityStageHook: authorityStageHook is null
                ? null
                : stage => authorityStageHook(store.SessionId, stage),
            canonicalCommitBarrier: canonicalCommitBarrier is null
                ? null
                : (commit, token) => canonicalCommitBarrier(store.SessionId, commit, token),
            publishProjection: callbacks.PublishProjection,
            mainFields: callbacks.MainFields is null
                ? null
                : () => callbacks.MainFields(store.SessionId),
            checkLifetime: callbacks.CheckLifetime is null
                ? null
                : () => callbacks.CheckLifetime(store.SessionId),
            archiveCommitted: callbacks.ArchiveCommitted
        );
        return store;
    }
}
