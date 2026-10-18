using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Vector;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly ConcurrentDictionary<long, Task> vectorHooks = new();
    private long vectorHookId;

    private static void VectorDiagnostic(string code, string id)
    {
        try
        {
            Console.Error.WriteLine("Vector " + code + " session=" + VectorText.SafeClip(id, 160));
        }
        catch { }
    }

    private void OnArchiveCommitted(
        SessionSnapshot snapshot,
        IReadOnlyList<ArchiveMessageRecord> messages,
        IReadOnlyList<ArchiveBlockRecord> blocks
    )
    {
        if (!Vector.Configuration.Enabled)
            return;
        var id = snapshot.Id;
        var seq = snapshot.NextMessageSeq - 1;
        var block = Math.Max(
            0,
            (long)(SessionWait.Number(snapshot.AuthorityEnvelope["nextBlockId"]) ?? 1) - 1
        );
        var tokens = messages.LastOrDefault() is { } last
            ? VectorText.Tokens(VectorText.Message(last.Message))
            : 0;
        TrackVectorHook(
            async () =>
            {
                await Vector.ScheduleAsync(id, seq, tokens, block);
            },
            id
        );
        foreach (var record in blocks.Where(record => record.MemoryFacts is { Count: > 0 }))
            TrackVectorHook(() => Vector.FactsAsync(record), id);
    }

    private void TrackVectorHook(Func<Task> run, string session)
    {
        var id = Interlocked.Increment(ref vectorHookId);
        // Run outside the authority/save publication stack. Derivative failures never change commit success.
        var task = Task.Run(async () =>
        {
            try
            {
                await run();
            }
            catch
            {
                VectorDiagnostic("VECTOR_COMMITTED_HOOK_FAILED", session);
            }
        });
        vectorHooks[id] = task;
        _ = ForgetVectorHookAsync(id, task);
    }

    private async Task ForgetVectorHookAsync(long id, Task task)
    {
        await task;
        vectorHooks.TryRemove(id, out _);
    }

    private async Task DrainVectorHooksAsync()
    {
        while (!vectorHooks.IsEmpty)
            await Task.WhenAll(vectorHooks.Values);
    }

    internal async Task<long> ForceVectorIndexAsync(SessionOwner owner)
    {
        owner.Entry.RequireIdentityAuthority();
        var snapshot = owner.Entry.Snapshot();
        var indexed = await Vector.ForceAsync(
            owner.Id,
            snapshot.NextMessageSeq - 1,
            Math.Max(
                0,
                (long)(SessionWait.Number(snapshot.AuthorityEnvelope["nextBlockId"]) ?? 1) - 1
            )
        );
        await owner.Entry.SaveLane.CommitVectorCompatibilityAsync();
        return indexed;
    }

    internal bool VectorCanonicalSourceAllowed(string sourceId, VectorSearchOptions scope)
    {
        var canonical = ArchiveReader(sourceId).CanonicalSessionId;
        if (scope.LineageSessions is { Count: > 0 } lineage)
            return lineage.Any(entry =>
                ArchiveReader(entry.SessionId).CanonicalSessionId == canonical
            );
        if (scope.SessionIds is { Length: > 0 } ids)
            return ids.Any(id => ArchiveReader(id).CanonicalSessionId == canonical);
        // Current-agent model recall must satisfy the same canonical target contract as explicit recall.
        // Canonical identity survives catalog deletion; historical Archive/dense Agent metadata does not grant authority.
        return scope.Agent is null
            || SessionIdentity.Agent(canonical) == scope.Agent;
    }

    internal (VectorSearchOptions Options, string Scope, string? SessionId) ResolveVectorScope(
        SessionOwner source,
        JsonObject args
    )
    {
        var targetAgent = SessionGoal.Trim(SessionWait.Text(args["agentName"]) ?? "");
        var targetId = SessionGoal.Trim(SessionWait.Text(args["sessionId"]) ?? "");
        var scope = SessionWait.Text(args["scope"]) ?? "current-agent";
        if (scope is not ("all" or "current-session" or "current-agent"))
            throw new InvalidDataException("scope must be all, current-session, or current-agent.");
        if (targetAgent.Length > 0 && targetAgent != source.Agent)
            throw new InvalidDataException(
                AgentIsolated(source.Agent)
                    ? "Isolated session can only search the current session."
                    : "recall vector_query cannot access memories outside the current agent."
            );
        var isolated = AgentIsolated(source.Agent);
        string? canonical = null;
        if (targetId.Length > 0)
        {
            canonical = SessionCatalog.Text(Catalog.Resolve(targetId)["sessionId"]);
            if (canonical is null)
                throw new InvalidDataException($"Session `{targetId}` not found.");
            if (isolated && canonical != source.Id)
                throw new InvalidDataException(
                    "Isolated session can only search the current session."
                );
            if (SessionCatalog.Text(Catalog.Get(canonical)?["agent"]) != source.Agent)
                throw new InvalidDataException(
                    "recall vector_query cannot access memories outside the current agent."
                );
        }
        if (isolated || canonical is not null || scope == "current-session")
        {
            canonical ??= source.Id;
            var lineage = ArchiveReader(canonical).VectorLineage();
            return (
                lineage.Count > 0 ? new(LineageSessions: lineage) : new(SessionIds: [canonical]),
                "current-session",
                canonical
            );
        }
        return (new(Agent: source.Agent), "current-agent", null);
    }
}
