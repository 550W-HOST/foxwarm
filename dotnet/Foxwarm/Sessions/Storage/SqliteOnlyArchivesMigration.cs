using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

// The existing, fixed sqlite-only-large-archives-v1 migration. SQLite imports
// commit independently; only verified sources are moved and versioned jointly.
internal static class SqliteOnlyArchivesMigration
{
    internal const string Id = LlmRequestJournalStore.MigrationId;

    internal static async Task RunAsync(string root, LlmRequestJournalStore journal)
    {
        var state = Path.Combine(root, "state");
        Directory.CreateDirectory(state);
        var lockPath = Path.Combine(state, Id + ".lock");
        using var held = await AcquireLockAsync(lockPath);
        try
        {
            var versionPath = Path.Combine(state, "migrationVersion.json");
            var version = ReadVersion(versionPath);
            if (SessionWait.Text(version["migrations"]?[Id]?["status"]) == "completed")
            {
                CommittedArchiveIdentity.ValidateStartupEvidence(
                    root,
                    allowPendingIdentityRecovery: true
                );
                return;
            }
            var backup = Path.Combine(state, "migration-backup", Id);
            var manifestPath = Path.Combine(backup, "manifest.json");
            RestoreInterruptedMoves(state, backup, manifestPath);
            var files = new JsonArray();
            foreach (var source in await SqliteArchiveMessageStore.ImportLegacyAsync(root))
                files.Add(source);
            await journal.InitializeAsync();
            var legacyJournal = Path.Combine(state, "llm-request-journal.jsonl");
            if (File.Exists(legacyJournal))
            {
                await journal.MigrateLegacyAsync(legacyJournal, moveSource: false);
                long count = 0;
                await foreach (var _ in LegacyArchiveRecords.Lines(legacyJournal))
                    count++;
                files.Add(
                    new JsonObject
                    {
                        ["relativeStatePath"] = "llm-request-journal.jsonl",
                        ["sha256"] = await HashFileAsync(legacyJournal),
                        ["recordCount"] = count,
                    }
                );
            }
            SqliteArchiveMessageStore.OrderedMaintenance(
                Path.Combine(state, "archive-store.sqlite"),
                connection =>
                    SqliteArchiveMessageStore.LegacySetMetadata(
                        connection,
                        null,
                        "sqlite_authority_migration",
                        Id
                    )
            );
            await journal.MarkSqliteAuthorityAsync(Id);
            foreach (var file in files.OfType<JsonObject>())
                file["moved"] = false;
            var recoveries = files
                .OfType<JsonObject>()
                .SelectMany(file =>
                    (file["recoveredRecords"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
                )
                .ToArray();
            string Key(JsonObject recovery) => recovery["sessionId"] + "\0" + recovery["seq"];
            var manifest = new JsonObject
            {
                ["v"] = 1,
                ["migrationId"] = Id,
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["audit"] = new JsonObject
                {
                    ["recoveredLogicalRecordCount"] = recoveries.Select(Key).Distinct().Count(),
                    ["insertedRecoveredLogicalRecordCount"] = recoveries
                        .Where(record => record["insertedIntoSqlite"]?.GetValue<bool>() == true)
                        .Select(Key)
                        .Distinct()
                        .Count(),
                    ["tornPrefixCount"] = files
                        .OfType<JsonObject>()
                        .Sum(file => file["tornPrefixCount"]?.GetValue<int>() ?? 0),
                },
                ["files"] = files,
            };
            Write(root, manifestPath, manifest);
            foreach (var file in files.OfType<JsonObject>())
            {
                var relative = file["relativeStatePath"]!.GetValue<string>();
                var source = Contained(state, relative);
                var destination = Contained(backup, relative);
                var expected = file["sha256"]!.GetValue<string>();
                if (await HashFileAsync(source) != expected)
                    throw new InvalidDataException(
                        "Migration source changed after verification: " + relative
                    );
                Move(source, destination);
                if (await HashFileAsync(destination) != expected)
                    throw new InvalidDataException(
                        "Migration backup verification failed: " + relative
                    );
                file["moved"] = true;
                Write(root, manifestPath, manifest);
            }
            var completed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            manifest["completedAt"] = completed;
            Write(root, manifestPath, manifest);
            version["migrations"]![Id] = new JsonObject
            {
                ["status"] = "completed",
                ["completedAt"] = completed,
                ["migratedFiles"] = files.Count,
                ["skippedFiles"] = 0,
                ["failedFiles"] = 0,
                ["backupRoot"] = backup,
            };
            Write(root, versionPath, version);
        }
        finally
        {
            held.Dispose();
            File.Delete(lockPath);
        }
    }

    private static JsonObject ReadVersion(string path)
    {
        try
        {
            if (JsonNode.Parse(File.ReadAllText(path)) is JsonObject raw)
                return new JsonObject
                {
                    ["v"] = 1,
                    ["migrations"] =
                        (raw["migrations"] as JsonObject)?.DeepClone() ?? new JsonObject(),
                };
        }
        catch (Exception error) when (error is IOException or JsonException) { }
        return new JsonObject { ["v"] = 1, ["migrations"] = new JsonObject() };
    }

    private static async Task<FileStream> AcquireLockAsync(string path)
    {
        while (true)
        {
            FileStream? held = null;
            try
            {
                held = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                await held.WriteAsync(
                    Encoding.UTF8.GetBytes(
                        JsonSerializer.Serialize(
                            new
                            {
                                pid = Environment.ProcessId,
                                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                            }
                        )
                    )
                );
                await held.FlushAsync();
                return held;
            }
            catch (IOException) when (held is null && File.Exists(path))
            {
                int? pid = null;
                try
                {
                    pid = JsonNode
                        .Parse(await File.ReadAllTextAsync(path))
                        ?["pid"]?.GetValue<int>();
                }
                catch (Exception error)
                    when (error is IOException or JsonException or InvalidOperationException) { }
                var alive = false;
                if (pid is > 0)
                    try
                    {
                        using var process = Process.GetProcessById(pid.Value);
                        alive = !process.HasExited;
                    }
                    catch (ArgumentException) { }
                    catch (System.ComponentModel.Win32Exception)
                    {
                        alive = true;
                    }
                if (
                    !alive
                    && (
                        pid is not null
                        || DateTime.UtcNow - File.GetLastWriteTimeUtc(path)
                            >= TimeSpan.FromSeconds(30)
                    )
                )
                    try
                    {
                        File.Delete(path);
                    }
                    catch (IOException) { }
                await Task.Delay(25);
            }
            catch
            {
                held?.Dispose();
                throw;
            }
        }
    }

    private static void RestoreInterruptedMoves(string state, string backup, string manifestPath)
    {
        if (!File.Exists(manifestPath))
            return;
        var manifest = JsonNode.Parse(File.ReadAllText(manifestPath)) as JsonObject;
        if (
            SessionWait.Number(manifest?["v"]) != 1
            || SessionWait.Text(manifest?["migrationId"]) != Id
            || manifest?["files"] is not JsonArray files
        )
            throw new InvalidDataException("Invalid SQLite-only archive migration manifest");
        foreach (var file in files.OfType<JsonObject>())
        {
            var relative = file["relativeStatePath"]!.GetValue<string>();
            var source = Contained(state, relative);
            var destination = Contained(backup, relative);
            var sourceExists = File.Exists(source);
            var backupExists = File.Exists(destination);
            if (!sourceExists && !backupExists)
                throw new InvalidDataException(
                    "Migration source and backup are both missing: " + relative
                );
            var expected = file["sha256"]!.GetValue<string>();
            if (backupExists && HashFileAsync(destination).GetAwaiter().GetResult() != expected)
                throw new InvalidDataException("Migration backup hash mismatch: " + relative);
            if (!sourceExists && backupExists)
                Move(destination, source);
            else if (sourceExists && backupExists)
            {
                if (HashFileAsync(source).GetAwaiter().GetResult() != expected)
                    throw new InvalidDataException("Migration source hash mismatch: " + relative);
                File.Delete(destination);
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(destination)!);
            }
        }
    }

    private static string Contained(string root, string relative)
    {
        if (
            relative.Length == 0
            || Path.IsPathRooted(relative)
            || relative.Split('/', '\\').Contains("..")
        )
            throw new InvalidDataException("Unsafe migration relative path: " + relative);
        var path = Path.GetFullPath(relative, root);
        if (
            !path.StartsWith(
                Path.GetFullPath(root) + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            )
        )
            throw new InvalidDataException("Migration path escapes its data root: " + relative);
        return path;
    }

    private static void Write(string root, string path, JsonObject value) =>
        new LinuxAtomicJsonFile(
            root,
            Path.GetRelativePath(root, path),
            privateFile: true
        ).WritePayload(value);

    private static void Move(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.Move(source, destination);
        LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(source)!);
        if (Path.GetDirectoryName(source) != Path.GetDirectoryName(destination))
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(destination)!);
    }

    internal static async Task<string> HashFileAsync(string path)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
    }
}
