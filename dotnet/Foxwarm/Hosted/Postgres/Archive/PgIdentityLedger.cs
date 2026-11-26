using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres.Archive;

/// <summary>
/// The identity ledger in PostgreSQL. Committed mappings are the rows of
/// <c>session_id_reservations</c>, the same table the Archive readers resolve through, so there
/// is no second copy to reconcile. The pending move is one <c>session_identity_pending_move</c>
/// row with the file intent's JSON; its protocol and validation are the file ledger's
/// (<see cref="SessionIdentityMoveJournal"/>), and each step is still its own transaction
/// (no cross-store unit of work in P1).
/// </summary>
internal sealed class PgIdentityLedger(TenantDb database) : IIdentityLedger
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private bool initialized;
    private HashSet<string> reserved = new(StringComparer.Ordinal);

    public void ValidateStartupEvidence(bool allowPendingIdentityRecovery = false)
    {
        // File mode also checks SQLite-only migration evidence; a hosted tenant starts from an
        // import of a current-format installation and has none.
        if (
            !allowPendingIdentityRecovery
            && database.Read(tx => tx.Scalar("SELECT 1 FROM session_identity_pending_move")) is not null
        )
            throw new UnsupportedSessionAuthorityException(
                "Pending Session identity move recovery is not supported by this host."
            );
    }

    public async Task InitializeAsync(ISessionCatalogStore catalog)
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (initialized)
                return;
            ValidateStartupEvidence();
            catalog.Initialize();
            var mappings = database.Read(Mappings);
            var committed = new HashSet<string>(mappings.Keys, StringComparer.Ordinal);
            CommittedArchiveIdentity.MergeCatalogAliases(
                mappings,
                catalog.List(),
                alias => SessionCatalog.Text(catalog.Resolve(alias)["sessionId"])
            );
            var added = mappings.Where(pair => !committed.Contains(pair.Key)).ToArray();
            if (added.Length > 0)
                database.Write(
                    tx =>
                    {
                        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        foreach (var (id, canonical) in added)
                            if (Insert(tx, id, canonical, now) != canonical)
                                throw new InvalidDataException("Archive identity mirror changed during initialization.");
                        return true;
                    },
                    new PgWriteOptions(Verify: tx => added.All(pair => Stored(tx, pair.Key) == pair.Value))
                );
            reserved = Reserved(mappings);
            initialized = true;
        }
        finally
        {
            gate.Release();
        }
    }

    public bool IsReserved(string sessionId) => reserved.Contains(sessionId);

    public void ValidateRename(string oldId, string newId)
    {
        var graph = database.Read(Mappings);
        if (graph.TryGetValue(oldId, out var prior) && prior != newId)
            throw new InvalidDataException("Source identity already has a different committed reservation.");
        graph[oldId] = newId;
        CommittedArchiveIdentity.ValidateGraph(graph);
    }

    public async Task CommitRenameAsync(string oldId, string newId)
    {
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var graph = database.Write(
                tx =>
                {
                    var graph = Mappings(tx);
                    if (graph.TryGetValue(oldId, out var prior))
                    {
                        if (prior != newId)
                            throw new InvalidDataException(
                                "Source identity already has a different committed reservation."
                            );
                        return graph;
                    }
                    graph.Add(oldId, newId);
                    CommittedArchiveIdentity.ValidateGraph(graph);
                    Insert(tx, oldId, newId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    return graph;
                },
                new PgWriteOptions(Verify: tx => Stored(tx, oldId) == newId)
            );
            reserved = Reserved(graph);
        }
        finally
        {
            gate.Release();
        }
    }

    public SessionIdentityMoveRecord? ReadPendingMove()
    {
        var text = database.Read(tx => tx.Scalar("SELECT record FROM session_identity_pending_move") as string);
        if (text is null)
            return null;
        return SessionIdentityMoveJournal.Parse(
            JsonNode.Parse(text) as JsonObject
                ?? throw new InvalidDataException("Identity move intent must be an object.")
        );
    }

    public void WritePendingMove(SessionIdentityMoveRecord record)
    {
        var text = EcmaJson.Stringify(record.Json());
        database.Write(
            tx =>
                tx.Execute(
                    "INSERT INTO session_identity_pending_move (record) VALUES ($1)"
                        + " ON CONFLICT (tenant_id) DO UPDATE SET record = excluded.record, written_at = now()",
                    text
                ),
            new PgWriteOptions(Verify: tx =>
                tx.Scalar("SELECT 1 FROM session_identity_pending_move WHERE record = $1", text) is not null
            )
        );
    }

    public void ClearPendingMove() =>
        database.Write(
            tx => tx.Execute("DELETE FROM session_identity_pending_move"),
            new PgWriteOptions(Verify: tx => tx.Scalar("SELECT 1 FROM session_identity_pending_move") is null)
        );

    /// <summary>
    /// A hosted tenant has no per-Session artifacts besides the authority (file mode also moves
    /// legacy logs and frontier files), so this moves the authority only.
    /// </summary>
    public void MoveArtifacts(string fromId, string toId, int version, Action<string, string> moveAuthority)
    {
        if (version is not (1 or 2))
            throw new InvalidDataException("Unsupported identity move intent version.");
        moveAuthority(fromId, toId);
    }

    private static Dictionary<string, string> Mappings(PgTx tx)
    {
        var mappings = new Dictionary<string, string>(StringComparer.Ordinal);
        using var command = tx.Command("SELECT session_id, canonical_session_id FROM session_id_reservations");
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                var id = reader.GetString(0);
                var canonical = reader.GetString(1);
                CommittedArchiveIdentity.ValidateIdentity(id);
                CommittedArchiveIdentity.ValidateIdentity(canonical);
                mappings[id] = canonical;
            }
        CommittedArchiveIdentity.ValidateGraph(mappings);
        return mappings;
    }

    // Inserts a mapping unless one exists; returns the stored target.
    private static string Insert(PgTx tx, string id, string canonical, long now)
    {
        tx.Execute(
            "INSERT INTO session_id_reservations (session_id, canonical_session_id, created_at, updated_at)"
                + " VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
            id,
            canonical,
            now
        );
        return Stored(tx, id)!;
    }

    private static string? Stored(PgTx tx, string id) =>
        tx.Scalar("SELECT canonical_session_id FROM session_id_reservations WHERE session_id = $1", id) as string;

    private static HashSet<string> Reserved(Dictionary<string, string> mappings) =>
        mappings.Keys.Concat(mappings.Values).ToHashSet(StringComparer.Ordinal);
}
