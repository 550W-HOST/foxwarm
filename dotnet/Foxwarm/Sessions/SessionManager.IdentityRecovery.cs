using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private async Task EnsureIdentityStartupAsync()
    {
        if (identityStartupComplete)
            return;
        await identityStartupGate.WaitAsync();
        try
        {
            if (identityStartupComplete)
                return;
            if (IdentityJournal.Read() is { } record)
            {
                var metadata = new SessionIdentityMetadata(root, Catalog);
                metadata.Open();
                var backward = record.Phase == "rolling-back";
                var from = backward ? record.NewId : record.OldId;
                var to = backward ? record.OldId : record.NewId;
                var agent = backward ? record.OldAgent : record.TargetAgent;
                var source = metadata.Get(from);
                var target = metadata.Get(to);
                if (source is not null && target is not null || source is null && target is null)
                    throw new InvalidDataException(
                        "Pending move cannot prove a unique exact Main lifetime."
                    );
                if (
                    !backward
                    && (target is null || !File.Exists(IdentityJournal.AuthorityPath(record.NewId)))
                )
                    throw new InvalidDataException(
                        "Finishing identity intent requires its existing durable target."
                    );
                var resolved = record.OldId;
                if (File.Exists(ArchiveDatabase))
                {
                    using var db = new SqliteConnection(
                        new SqliteConnectionStringBuilder
                        {
                            DataSource = ArchiveDatabase,
                            Mode = SqliteOpenMode.ReadOnly,
                            Pooling = false,
                        }.ToString()
                    );
                    db.Open();
                    resolved = SqliteArchiveMessageStore.ResolveReadOnly(db, record.OldId);
                }
                if (backward && resolved != record.OldId)
                    throw new InvalidDataException(
                        "Rollback intent conflicts with committed identity authority."
                    );
                var file = File.Exists(IdentityJournal.AuthorityPath(to))
                    ? IdentityJournal.AuthorityPath(to)
                    : IdentityJournal.AuthorityPath(from);
                var raw =
                    JsonNode.Parse(await File.ReadAllTextAsync(file)) as JsonObject
                    ?? throw new InvalidDataException(
                        "Pending identity authority must be an object."
                    );
                if (
                    raw.ContainsKey("sessionStateVersion")
                    && SessionCatalog.Number(raw["sessionStateVersion"]) != 1
                )
                    throw new UnsupportedSessionAuthorityException(
                        "Pending identity authority version is unsupported."
                    );
                if (
                    SessionCatalog.Text(raw["id"]) is { } bound
                    && bound != record.OldId
                    && bound != record.NewId
                )
                    throw new InvalidDataException(
                        "Pending identity authority belongs to another lifetime."
                    );
                var aliases = backward
                    ? record.OldAliases
                    : (target?["aliases"] as JsonArray)
                        ?.Select(SessionCatalog.Text)
                        .OfType<string>()
                        .ToArray()
                        ?? record
                            .OldAliases.Concat([record.OldId])
                            .Where(id => id != record.NewId)
                            .Distinct(StringComparer.Ordinal)
                            .ToArray();
                if (
                    backward
                    && record.OwnsAgent
                    && metadata.HasOtherAgentLifetime(record.OwnedAgent!, record.NewId)
                )
                    throw new InvalidDataException(
                        "Owned identity destination contains another Main lifetime; preserve its directory."
                    );
                if (
                    backward
                    && record.OwnsAgent
                    && record.OwnedAgentPreparation is not null
                    && record.AgentDirectoryPublished is null
                )
                {
                    // A still-prepared directory was never renamed to the final destination.
                    // Persist that ownership distinction before cleanup can remove the evidence.
                    var prepared = agents.PreparationPath(record.OwnedAgentPreparation);
                    record = record with
                    {
                        AgentDirectoryPublished =
                            !Directory.Exists(prepared) && !File.Exists(prepared),
                    };
                    IdentityJournal.Write(record);
                }
                // Direction is persisted before any reversal. The audit transaction never merges competing branches.
                IdentityJournal.MoveArtifacts(from, to, record.Version);
                SqliteArchiveIdentityMove.Rename(ArchiveDatabase, from, to);
                await Vector.RenameAsync(from, to);
                if (raw.ContainsKey("id"))
                    raw["id"] = to;
                raw["agent"] = agent;
                raw["aliases"] = new JsonArray(
                    aliases.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
                );
                new LinuxAtomicJsonFile(root, $"state/sessions/{to}.json").WritePayload(raw);
                metadata.Rewrite(from, to, agent, aliases, requireSource: source is not null);
                deletionChannels.RewriteIdentity(from, to);
                if (!backward)
                    await archiveIdentities.CommitRenameAsync(record.OldId, record.NewId);
                if (backward && record.OwnsAgent)
                    await RemoveMoveOwnedAgentAsync(record, metadata);
                IdentityJournal.Clear();
            }
            await archiveIdentities.InitializeAsync(Catalog);
            identityStartupComplete = true;
        }
        finally
        {
            identityStartupGate.Release();
        }
    }

    private async Task RemoveMoveOwnedAgentAsync(
        SessionIdentityMoveRecord record,
        SessionIdentityMetadata? selected = null
    )
    {
        if (!record.OwnsAgent || record.OwnedAgent is null)
            return;
        if (
            selected?.Get(record.NewId) is not null
            || File.Exists(Catalog.FilePath) && Catalog.Get(record.NewId) is not null
        )
            throw new InvalidDataException(
                "Owned destination still has Main membership; preserve its directory until recovery completes."
            );
        if (
            selected?.HasOtherAgentLifetime(record.OwnedAgent, record.NewId) == true
            || File.Exists(Catalog.FilePath)
                && Catalog.List().Any(row => SessionCatalog.Text(row["agent"]) == record.OwnedAgent)
        )
            throw new InvalidDataException(
                "Owned destination contains another Main lifetime; its directory cannot be removed."
            );
        await agents.RemoveIdentityOwnedAsync(
            record.OwnedAgent,
            record.OwnedAgentPreparation,
            record.PreviousAgentMetadata,
            record.AgentDirectoryPublished ?? true
        );
    }
}
