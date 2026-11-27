using System.Text.Json.Nodes;

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

    private string AuthorityPath(string sessionId) =>
        Path.Combine(root, "state", "sessions", sessionId + ".json");

    public bool Exists(string sessionId) => File.Exists(AuthorityPath(sessionId));

    public JsonObject? ReadEnvelope(string sessionId, string agent)
    {
        var path = AuthorityPath(sessionId);
        if (!File.Exists(path))
            return null;
        // The complete document is read and validated; only the head is returned.
        var document = SessionAuthorityDocument.Load(path, sessionId, agent).CloneRoot();
        document.Remove("history");
        return document;
    }

    public async Task<SessionAuthorityRaw?> ReadRawAsync(
        string sessionId,
        CancellationToken token = default
    )
    {
        var path = AuthorityPath(sessionId);
        string text;
        try
        {
            text = await File.ReadAllTextAsync(path, token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
        return new SessionAuthorityRaw(JsonNode.Parse(text), path);
    }

    public void MoveIdentity(string fromId, string toId) =>
        new SessionIdentityMoveJournal(root).MoveArtifact("state/sessions", ".json", fromId, toId);

    public void ReplaceRaw(string sessionId, JsonObject document) =>
        new AtomicJsonFile(root, $"state/sessions/{sessionId}.json").WritePayload(document);

    public void DeleteAuthority(string sessionId, Action? removed = null) =>
        Unlink(AuthorityPath(sessionId), removed);

    // Frontier files were written by older layouts; current authority never creates them.
    public void DeleteLegacyArtifacts(string sessionId, Action? removed = null) =>
        Unlink(Path.Combine(root, "state", "sessions", sessionId + ".frontier.json"), removed);

    private static void Unlink(string path, Action? removed)
    {
        File.Delete(path);
        removed?.Invoke();
        if (Directory.Exists(Path.GetDirectoryName(path)))
            DirectorySync.Sync(Path.GetDirectoryName(path)!);
    }
}
