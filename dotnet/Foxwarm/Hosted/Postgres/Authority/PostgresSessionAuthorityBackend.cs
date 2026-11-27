using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres.Authority;

/// <summary>
/// Session authority in PostgreSQL (design U3(b)): a <c>session_heads</c> row per Session plus
/// immutable <c>session_segments</c> and <c>session_envelope_parts</c> keyed by the head's
/// lifetime. Values equal file mode's by construction: writes use the shared state preparation
/// and the document writer's record serialization, and loads assemble the raw document and run
/// the shared normalization. Every write goes through <see cref="TenantDb"/>.
/// </summary>
internal sealed class PostgresSessionAuthorityBackend : ISessionAuthorityBackend
{
    internal PostgresSessionAuthorityBackend(
        TenantDb database,
        Func<string, IArchiveSession>? archive,
        string scratchRoot,
        Foxwarm.Storage.IBlobStore? imageBlobs
    )
    {
        Database = database;
        Archive = archive;
        ScratchRoot = Path.GetFullPath(scratchRoot);
        ImageBlobs = imageBlobs;
    }

    internal TenantDb Database { get; }

    /// <summary>Opens one Session's Archive view; null while the build has no Archive store.</summary>
    internal Func<string, IArchiveSession>? Archive { get; }

    /// <summary>The replica's scratch directory, which holds the provider image variant cache.</summary>
    internal string ScratchRoot { get; }

    internal Foxwarm.Storage.IBlobStore? ImageBlobs { get; }

    /// <summary>Test seam: runs inside every commit transaction of a bound store, before COMMIT.</summary>
    internal Action<string>? BeforeCommit { get; set; }

    /// <summary>Observes every committed write of a bound store or <see cref="ReplaceRaw"/>.</summary>
    internal Action<PgSessionCommitStats>? Committed { get; set; }

    internal static string Locator(string sessionId) => "session_authority/" + sessionId;

    public ISessionAuthority Open(
        string sessionId,
        string agent,
        SessionAuthorityCallbacks callbacks
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(agent);
        return new PostgresSessionAuthority(this, sessionId, agent, callbacks);
    }

    public bool Exists(string sessionId) =>
        Database.Read(tx =>
            tx.Scalar("SELECT 1 FROM session_heads WHERE session_id = $1", sessionId) is not null
        );

    public JsonObject? ReadEnvelope(string sessionId, string agent) =>
        Database.Read(tx => ReadEnvelope(tx, sessionId, agent), snapshot: true);

    public Task<JsonObject?> ReadEnvelopeAsync(string sessionId, string agent) =>
        Database.ReadAsync(tx => ReadEnvelope(tx, sessionId, agent), snapshot: true);

    private static JsonObject? ReadEnvelope(PgTx tx, string sessionId, string agent)
    {
        if (PgSessionRows.ReadHeadAsync(tx, sessionId, forUpdate: false, async: false, default).GetAwaiter().GetResult() is not { } head)
            return null;
        var values = PgSessionRows.ReadPartsAsync(tx, head, async: false, default).GetAwaiter().GetResult();
        var document = PgSessionEnvelope.Decode(head.Envelope, head.Parts, values);
        var count = head.RecordCount;
        if (!document.ContainsKey("history"))
            throw SessionAuthorityErrors.Invalid("Session authority history must be an array.", "history");
        SessionAuthorityDocument.ValidateState(document, count, sessionId, agent);
        document.Remove("history");
        return document;
    }

    public Task<SessionAuthorityRaw?> ReadRawAsync(
        string sessionId,
        CancellationToken token = default
    ) =>
        Database.ReadAsync<SessionAuthorityRaw?>(
            async (tx, cancel) =>
            {
                if (
                    await PgSessionRows
                        .ReadHeadAsync(tx, sessionId, forUpdate: false, async: true, cancel)
                        .ConfigureAwait(false)
                    is not { } head
                )
                    return null;
                var (document, _) = await PgSessionRows
                    .AssembleAsync(tx, head, async: true, cancel)
                    .ConfigureAwait(false);
                return new SessionAuthorityRaw(document, Locator(sessionId));
            },
            snapshot: true,
            token: token
        );

    public void MoveIdentity(string fromId, string toId)
    {
        // Segments and parts belong to the lifetime, so only the head moves. Like the file
        // rename, the move replaces an authority already stored under the target ID; a
        // missing source is a no-op so that recovery can replay it.
        if (fromId == toId)
            return;
        Guid? moved = null;
        Database.Write(
            tx =>
            {
                if (
                    tx.Scalar("SELECT lifetime_id FROM session_heads WHERE session_id = $1 FOR UPDATE", fromId)
                    is not Guid lifetime
                )
                    return 0;
                moved = lifetime;
                PgSessionRows.DeleteAsync(tx, toId, async: false, default).GetAwaiter().GetResult();
                return tx.Execute(
                    "UPDATE session_heads SET session_id = $2, updated_at = now() WHERE session_id = $1",
                    fromId,
                    toId
                );
            },
            new PgWriteOptions(
                Verify: tx =>
                    moved is not { } lifetime
                    || tx.Scalar(
                        "SELECT 1 FROM session_heads WHERE session_id = $1 AND lifetime_id = $2",
                        toId,
                        lifetime
                    )
                        is not null
            )
        );
    }

    public void ReplaceRaw(string sessionId, JsonObject document)
    {
        var envelopeState = (JsonObject)document.DeepClone();
        var history = new JsonArray();
        if (envelopeState.ContainsKey("history"))
        {
            history =
                envelopeState["history"] as JsonArray
                ?? throw new InvalidDataException("Session authority history must be an array.");
            envelopeState["history"] = null;
        }
        var envelope = PgSessionEnvelope.Encode(envelopeState);
        var pieces = SessionSegmentPlanner.Cut(
            0,
            history.Count,
            (writer, index) =>
            {
                if (history[index] is { } record)
                    record.WriteTo(writer);
                else
                    writer.WriteNullValue();
            }
        );
        var commitId = Guid.NewGuid();
        var committed = Database.Write(
            tx =>
            {
                var current = PgSessionRows
                    .ReadHeadAsync(tx, sessionId, forUpdate: true, async: false, default)
                    .GetAwaiter()
                    .GetResult();
                return PgSessionRows
                    .CommitAsync(tx, sessionId, current, 0, pieces, envelope, commitId, async: false, default)
                    .GetAwaiter()
                    .GetResult();
            },
            new PgWriteOptions(Verify: tx => PgSessionRows.Committed(tx, commitId))
        );
        Observe(committed.Stats);
    }

    public void DeleteAuthority(string sessionId, Action? removed = null)
    {
        Guid? lifetime = null;
        Database.Write(
            tx =>
            {
                lifetime = PgSessionRows.DeleteAsync(tx, sessionId, async: false, default).GetAwaiter().GetResult();
                return 0;
            },
            new PgWriteOptions(
                Verify: tx =>
                    lifetime is not { } id
                    || tx.Scalar("SELECT 1 FROM session_heads WHERE lifetime_id = $1", id) is null
            )
        );
        // The transaction that made the authority invisible also made the removal durable.
        removed?.Invoke();
    }

    // Older file layouts wrote these artifacts; a database never held them.
    public void DeleteLegacyArtifacts(string sessionId, Action? removed = null) => removed?.Invoke();

    internal void Observe(PgSessionCommitStats stats)
    {
        try
        {
            Committed?.Invoke(stats);
        }
        catch { }
    }
}
