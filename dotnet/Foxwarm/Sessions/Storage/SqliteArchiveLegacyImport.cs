using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed record LegacyArchiveSource(
    string FilePath,
    string SessionId,
    bool Blocks,
    JsonObject Manifest
);

internal sealed record LegacyArchiveCandidate(string Id, string? Parent, string[] Aliases);

public sealed partial class SqliteArchiveMessageStore
{
    internal static async Task<IReadOnlyList<JsonObject>> ImportLegacyAsync(string root)
    {
        var path = Path.Combine(root, "state", "archive-store.sqlite");
        using var lease = AcquireWriter(path);
        var receipt = await lease.Writer.ExclusiveAsync(async connection =>
        {
            Execute(
                connection,
                "CREATE TABLE IF NOT EXISTS archive_store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)"
            );
            Execute(
                connection,
                "CREATE TABLE IF NOT EXISTS archive_import_state(session_id TEXT PRIMARY KEY,messages_file_size INTEGER NOT NULL DEFAULT -1,messages_file_mtime_ms INTEGER NOT NULL DEFAULT 0,blocks_file_size INTEGER NOT NULL DEFAULT -1,blocks_file_mtime_ms INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)"
            );
            var candidates = LegacyCandidates(root);
            var sources = new List<LegacyArchiveSource>();
            var recovered = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            // Full structural validation precedes branches, aliases and imported rows.
            foreach (var candidate in candidates)
            foreach (var blocks in new[] { false, true })
            {
                var file = Path.Combine(
                    root,
                    "state",
                    "logs",
                    "sessions",
                    candidate.Id + (blocks ? ".blocks.jsonl" : ".jsonl")
                );
                if (!File.Exists(file))
                    continue;
                long count = 0;
                var recoveries = new JsonArray();
                await foreach (var line in LegacyArchiveRecords.Lines(file))
                {
                    var parsed = LegacyArchiveRecords.Parse(line, blocks);
                    count++;
                    if (!parsed.Recovered)
                        continue;
                    var key = LegacyKey(parsed.Record);
                    if (
                        recovered.TryGetValue(key, out var prior)
                        && LegacyArchiveRecords.Canonical(prior)
                            != LegacyArchiveRecords.Canonical(parsed.Record)
                    )
                        throw new InvalidDataException(
                            "Divergent recovered legacy session message " + key
                        );
                    recovered[key] = parsed.Record;
                    recoveries.Add(
                        new JsonObject
                        {
                            ["sessionId"] = parsed.Record["sessionId"]!.DeepClone(),
                            ["seq"] = parsed.Record["seq"]!.DeepClone(),
                            ["payloadSha256"] = LegacyHash(
                                LegacyArchiveRecords.Canonical(parsed.Record)
                            ),
                            ["insertedIntoSqlite"] = false,
                        }
                    );
                }
                sources.Add(
                    new(
                        file,
                        candidate.Id,
                        blocks,
                        new JsonObject
                        {
                            ["relativeStatePath"] = Path.GetRelativePath(
                                    Path.Combine(root, "state"),
                                    file
                                )
                                .Replace('\\', '/'),
                            ["kind"] = blocks ? "blocks" : "messages",
                            ["sha256"] = await SqliteOnlyArchivesMigration.HashFileAsync(file),
                            ["recordCount"] = count,
                            ["recoveredRecords"] = recoveries,
                            ["tornPrefixCount"] = recoveries.Count,
                        }
                    )
                );
            }
            var preMessages = LegacyKeys(connection, "archive_messages", "seq");
            var preBlocks = LegacyKeys(connection, "archive_blocks", "id");
            var identities = new CommittedArchiveIdentity(root);
            var mappings = identities.ReadLegacyMappings(connection);
            string Resolve(string id) => CommittedArchiveIdentity.Resolve(mappings, id);
            var discovered = candidates
                .Select(candidate => candidate.Id)
                .Concat(LegacyBranchIds(connection))
                .ToHashSet(StringComparer.Ordinal);
            var uncertain = new HashSet<string>(StringComparer.Ordinal);
            var pending = new SessionIdentityMoveJournal(root).Read();
            foreach (var candidate in candidates)
            {
                var exists = LegacyBranchExists(connection, candidate.Id);
                foreach (var alias in candidate.Aliases.Reverse())
                    identities.AddLegacyMapping(connection, mappings, alias, candidate.Id);
                // The established directional recovery owner will move this
                // existing branch back/forward. Metadata alone must not invent
                // an empty competing destination before it can do so.
                if (
                    pending is not null
                    && !exists
                    && candidate.Id
                        == (pending.Phase == "rolling-back" ? pending.OldId : pending.NewId)
                    && LegacyBranchExists(
                        connection,
                        pending.Phase == "rolling-back" ? pending.NewId : pending.OldId
                    )
                    && !sources.Any(source => source.SessionId == candidate.Id)
                )
                    continue;
                if (!exists)
                {
                    string? last = null;
                    var sawCurrent = false;
                    foreach (
                        var source in sources
                            .Where(source => source.SessionId == candidate.Id)
                            .OrderBy(source => source.Blocks)
                    )
                    {
                        if (source.Blocks && last is not null)
                            break;
                        await foreach (var line in LegacyArchiveRecords.Lines(source.FilePath))
                        {
                            var parsed = LegacyArchiveRecords.Parse(line, source.Blocks);
                            if (parsed.Recovered)
                                continue; // Source's ordinary bootstrap parser skips this physical line.
                            last = LegacyArchiveRecords.Text(parsed.Record, "sessionId")!;
                            if (last == candidate.Id)
                                sawCurrent = true;
                        }
                    }
                    if (!sawCurrent && last is not null && last != candidate.Id)
                    {
                        if (!discovered.Contains(last))
                            uncertain.Add(candidate.Id + "\0" + last);
                        LegacyEnsureBranch(connection, last);
                    }
                }
                if (exists)
                    continue;
                var parent = candidate.Parent is null ? null : Resolve(candidate.Parent);
                var messageCap = parent is null
                    ? 0
                    : await LegacyForkCap(sources, candidate.Id, parent, false, Resolve);
                var blockCap = parent is null
                    ? 0
                    : await LegacyForkCap(sources, candidate.Id, parent, true, Resolve);
                LegacyEnsureBranch(connection, candidate.Id, parent, messageCap, blockCap);
            }
            foreach (var source in sources)
            {
                if (LegacyImportCurrent(connection, source))
                    continue;
                var batch = 0;
                // Keep the existing Source import batching, rather than holding one
                // transaction across both databases or across the whole archive.
                SqliteTransaction? current = null;
                try
                {
                    await foreach (var line in LegacyArchiveRecords.Lines(source.FilePath))
                    {
                        var parsed = LegacyArchiveRecords.Parse(line, source.Blocks);
                        if (parsed.Recovered)
                            continue;
                        var record = parsed.Record;
                        var id = Resolve(LegacyArchiveRecords.Text(record, "sessionId")!);
                        if (id != source.SessionId)
                        {
                            if (current is not null)
                            {
                                current.Commit();
                                current.Dispose();
                                current = null;
                                batch = 0;
                            }
                            LegacyEnsureBranch(connection, id);
                            if (!uncertain.Contains(source.SessionId + "\0" + id))
                                continue;
                        }
                        current ??= connection.BeginTransaction();
                        LegacyInsert(connection, current, record, id, source.Blocks);
                        if (++batch >= 200)
                        {
                            current.Commit();
                            current.Dispose();
                            current = null;
                            batch = 0;
                        }
                    }
                    current?.Commit();
                }
                finally
                {
                    current?.Dispose();
                }
                LegacyRecordImport(connection, source);
            }
            var insertedRecoveries = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (key, record) in recovered)
            {
                var id = Resolve(LegacyArchiveRecords.Text(record, "sessionId")!);
                LegacyEnsureBranch(connection, id);
                var markerKey = "migration_recovered_torn_message:" + LegacyHash(key);
                var markerValue = LegacyArchiveRecords.Canonical(
                    new JsonObject
                    {
                        ["sessionId"] = record["sessionId"]!.DeepClone(),
                        ["seq"] = record["seq"]!.DeepClone(),
                        ["payloadSha256"] = LegacyHash(LegacyArchiveRecords.Canonical(record)),
                    }
                );
                using var tx = connection.BeginTransaction();
                var marker = LegacyMetadata(connection, markerKey, tx);
                if (marker is not null && marker != markerValue)
                    throw new InvalidDataException(
                        "Conflicting durable torn-message recovery marker."
                    );
                var stored = LegacyReadRecord(connection, tx, record, id, false);
                var matches =
                    stored is not null
                    && LegacyComparable(record, false) == LegacyComparable(stored, false);
                if (marker is not null && !matches)
                    throw new InvalidDataException(
                        "Recovered torn-message row no longer matches its durable marker."
                    );
                var preexisting = preMessages.Contains(id + "\0" + record["seq"]);
                if (stored is null && preexisting)
                    throw new InvalidDataException(
                        "Preexisting SQLite row disappeared during torn-message recovery."
                    );
                if (stored is null)
                    LegacyInsert(connection, tx, record, id, false);
                if (stored is null || marker is not null || !preexisting)
                {
                    if (stored is not null && !matches)
                        throw new InvalidDataException(
                            "Bootstrap recovered torn-message row does not match."
                        );
                    LegacySetMetadata(connection, tx, markerKey, markerValue);
                    insertedRecoveries.Add(key);
                }
                tx.Commit();
            }
            ValidateLegacyLineage(connection);
            foreach (var source in sources)
            {
                foreach (
                    var audit in source.Manifest["recoveredRecords"]!.AsArray().OfType<JsonObject>()
                )
                    if (insertedRecoveries.Remove(LegacyKey(audit)))
                        audit["insertedIntoSqlite"] = true;
                long count = 0;
                await foreach (var line in LegacyArchiveRecords.Lines(source.FilePath))
                {
                    var record = LegacyArchiveRecords.Parse(line, source.Blocks).Record;
                    var original = LegacyArchiveRecords.Text(record, "sessionId")!;
                    var id = Resolve(original);
                    var stored = LegacyReadRecord(connection, null, record, id, source.Blocks);
                    if (stored is null && id != original)
                    {
                        id = original;
                        stored = LegacyReadRecord(connection, null, record, id, source.Blocks);
                    }
                    if (stored is null)
                        throw new InvalidDataException(
                            "Legacy session archive record is missing from SQLite."
                        );
                    var preexisting = (source.Blocks ? preBlocks : preMessages).Contains(
                        id + "\0" + record[source.Blocks ? "id" : "seq"]
                    );
                    if (
                        !preexisting
                        && LegacyComparable(record, source.Blocks)
                            != LegacyComparable(stored, source.Blocks)
                    )
                        throw new InvalidDataException(
                            "Conflicting legacy session archive record in " + source.FilePath
                        );
                    count++;
                }
                if (
                    count != source.Manifest["recordCount"]!.GetValue<long>()
                    || await SqliteOnlyArchivesMigration.HashFileAsync(source.FilePath)
                        != source.Manifest["sha256"]!.GetValue<string>()
                )
                    throw new InvalidDataException("Legacy archive changed during verification.");
            }
            using var integrity = connection.CreateCommand();
            integrity.CommandText = "PRAGMA integrity_check";
            if (integrity.ExecuteScalar() as string != "ok")
                throw new InvalidDataException("archive-store.sqlite integrity_check failed");
            integrity.CommandText = "PRAGMA foreign_key_check";
            using var foreign = integrity.ExecuteReader();
            if (foreign.Read())
                throw new InvalidDataException("archive-store.sqlite foreign_key_check failed");
            return (IReadOnlyList<JsonObject>)
                sources
                    .OrderBy(source => source.FilePath, StringComparer.Ordinal)
                    .Select(source => source.Manifest)
                    .ToArray();
        });
        return await receipt.Completion;
    }

    private static string LegacyKey(JsonObject record) =>
        LegacyArchiveRecords.Text(record, "sessionId") + "\0" + record["seq"];

    private static string LegacyHash(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
