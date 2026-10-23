using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCatalog
{
    private sealed class SelectedAuthorityFailure(string message, Exception? cause = null)
        : IOException(message, cause);

    private sealed record MigrationRow(
        string Id,
        JsonObject Projection,
        string? StagePath = null,
        string? AuthorityPath = null
    );

    private string AuthorityDirectory => Path.Combine(root, "state", "sessions");

    private string[] Candidates()
    {
        var primary = Path.Combine(root, "state", "sessions.json");
        return
        [
            primary,
            .. Enumerable.Range(1, 5).Select(index => primary + "." + index + ".bak"),
            primary + ".bak",
        ];
    }

    private string EvidencePath =>
        Path.Combine(root, "state", "sessions.json.pre-catalog-sqlite-v1.bak");

    private void EnsureInitialized()
    {
        if (db is not null)
            return;
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        if (File.Exists(FilePath))
        {
            Open();
            return;
        }
        var candidates = Candidates();
        var seen = false;
        var failures = new List<string>();
        foreach (var source in candidates)
        {
            if (!File.Exists(source))
                continue;
            seen = true;
            var rows = new List<MigrationRow>();
            try
            {
                var data =
                    JsonNode.Parse(File.ReadAllText(source)) as JsonObject
                    ?? throw new InvalidDataException("Catalog candidate must be an object.");
                if (
                    data.ContainsKey("channelAttachments")
                    && data["channelAttachments"] is not JsonObject
                )
                    throw new InvalidDataException("Invalid legacy channelAttachments.");
                var sessions = data["sessions"] is JsonObject set
                    ? set
                    : new JsonObject(
                        data.Where(pair => pair.Key != "channelAttachments")
                            .Select(pair => KeyValuePair.Create(pair.Key, pair.Value?.DeepClone()))
                    );
                foreach (var (id, node) in sessions)
                {
                    var row =
                        node as JsonObject
                        ?? throw new InvalidDataException("Catalog row must be an object.");
                    var main = Project(row);
                    if (!SessionIdentity.IsValid(id))
                        throw new SelectedAuthorityFailure(
                            "Cataloged Session identity is not supported by this host."
                        );
                    if (Text(main["id"]) != id)
                        throw new InvalidDataException("Catalog key does not match row ID.");
                    var authorityPath = Path.Combine(AuthorityDirectory, id + ".json");
                    JsonObject raw;
                    try
                    {
                        raw =
                            JsonNode.Parse(File.ReadAllText(authorityPath)) as JsonObject
                            ?? throw new InvalidDataException("Authority must be an object.");
                    }
                    catch (Exception error)
                        when (error
                                is IOException
                                    or JsonException
                                    or InvalidDataException
                                    or UnauthorizedAccessException
                        )
                    {
                        throw new SelectedAuthorityFailure(
                            $"Cataloged Session '{id}' authority is missing, unreadable or malformed.",
                            error
                        );
                    }
                    try
                    {
                        var authority = NormalizeAuthority(raw, id, Text(main["agent"])!, row);
                        var projection = AuthorityProjection(authority, id, main);
                        string? staged = null;
                        if (!raw.ContainsKey("sessionStateVersion"))
                        {
                            staged =
                                authorityPath
                                + ".catalog-upgrade-v1-"
                                + Guid.NewGuid().ToString("N")
                                + ".tmp";
                            try
                            {
                                WriteDurably(
                                    staged,
                                    Encoding.UTF8.GetBytes(authority.ToJsonString())
                                );
                            }
                            catch
                            {
                                File.Delete(staged);
                                throw;
                            }
                        }
                        rows.Add(new(id, projection, staged, authorityPath));
                    }
                    catch (Exception error)
                    {
                        throw new SelectedAuthorityFailure(
                            $"Cataloged Session '{id}' authority cannot be admitted.",
                            error
                        );
                    }
                }
                PublishNew(rows, source);
                Open();
                return;
            }
            catch (SelectedAuthorityFailure)
            {
                CleanupStages(rows);
                throw;
            }
            catch (Exception error) when (error is JsonException or InvalidDataException)
            {
                CleanupStages(rows);
                failures.Add(Path.GetFileName(source) + ": " + error.Message);
            }
        }
        if (seen || AuthorityFiles().Length > 0 || HasArchiveHistory())
            throw new InvalidDataException(
                "No valid source Session catalog migration candidate. "
                    + string.Join("; ", failures)
            );
        PublishNew([], null);
        Open();
    }

    private string[] AuthorityFiles() =>
        Directory.Exists(AuthorityDirectory)
            ? Directory
                .GetFiles(AuthorityDirectory, "*.json", SearchOption.AllDirectories)
                .Where(file => !file.EndsWith(".frontier.json", StringComparison.Ordinal))
                .ToArray()
            : [];

    private bool HasArchiveHistory()
    {
        var path = Path.Combine(root, "state", "archive-store.sqlite");
        if (!File.Exists(path))
            return false;
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        foreach (var table in new[] { "archive_messages", "archive_blocks" })
            if (
                Scalar(
                    connection,
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$p0",
                    table
                )
                    is not null
                && Scalar(connection, $"SELECT 1 FROM {table} LIMIT 1") is not null
            )
                return true;
        return false;
    }

    private void PublishNew(IReadOnlyList<MigrationRow> rows, string? source)
    {
        var temp =
            FilePath + ".migrating-" + Environment.ProcessId + "-" + Guid.NewGuid().ToString("N");
        try
        {
            using (
                var connection = new SqliteConnection(
                    new SqliteConnectionStringBuilder
                    {
                        DataSource = temp,
                        Pooling = false,
                    }.ToString()
                )
            )
            {
                connection.Open();
                Execute(
                    connection,
                    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE"
                );
                try
                {
                    Execute(connection, CreateSchemaSql);
                    foreach (var row in rows)
                        Insert(connection, row.Projection);
                    NormalizeParents(connection);
                    Execute(connection, "COMMIT");
                }
                catch
                {
                    Execute(connection, "ROLLBACK");
                    throw;
                }
                if (Scalar(connection, "PRAGMA integrity_check")?.ToString() != "ok")
                    throw new InvalidDataException("Catalog integrity check failed.");
            }
            SyncFile(temp);
            if (source is not null)
            {
                var bytes = File.ReadAllBytes(source);
                if (File.Exists(EvidencePath))
                {
                    if (!bytes.AsSpan().SequenceEqual(File.ReadAllBytes(EvidencePath)))
                        throw new IOException("Existing catalog migration evidence differs.");
                }
                else
                {
                    WriteDurably(EvidencePath, bytes);
                    LinuxAtomicJsonFile.LinuxDirectorySync.Sync(
                        Path.GetDirectoryName(EvidencePath)!
                    );
                }
            }
            foreach (var row in rows.Where(row => row.StagePath is not null))
            {
                File.Move(row.StagePath!, row.AuthorityPath!, overwrite: true);
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(
                    Path.GetDirectoryName(row.AuthorityPath!)!
                );
            }
            File.Move(temp, FilePath, overwrite: false);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
            if (source is not null)
            {
                foreach (var candidate in Candidates())
                    File.Delete(candidate);
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
            }
        }
        finally
        {
            File.Delete(temp);
            CleanupStages(rows);
        }
    }

    private static void CleanupStages(IEnumerable<MigrationRow> rows)
    {
        foreach (var row in rows)
            if (row.StagePath is not null)
                File.Delete(row.StagePath);
    }

    private static void WriteDurably(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough
        );
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
    }

    private static void SyncFile(string path)
    {
        using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.ReadWrite,
            FileShare.Read
        );
        stream.Flush(flushToDisk: true);
    }
}
