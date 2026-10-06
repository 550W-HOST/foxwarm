using System.Security.Cryptography;
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
                "No valid source Session catalog migration candidate. Pre-catalog .NET roots require the explicit DevTools import. "
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

    private void PublishNew(
        IReadOnlyList<MigrationRow> rows,
        string? source,
        Action? verifyFrozen = null
    )
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
            verifyFrozen?.Invoke();
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

    private static byte[] Digest(string path)
    {
        using var stream = File.OpenRead(path);
        return SHA256.HashData(stream);
    }

    internal Action? BeforeImportFreezeCheck { get; set; }

    internal int ImportDotNetV1(AgentCatalog agents)
    {
        lock (gate)
        {
            if (db is not null || File.Exists(FilePath))
                throw new InvalidOperationException(
                    "Catalog already exists; it cannot be reimported."
                );
            if (Candidates().Any(File.Exists))
                throw new InvalidOperationException(
                    "Source legacy catalog candidates exist; use normal source migration."
                );
            var files = AuthorityFiles();
            var rows = new List<MigrationRow>();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var frozen = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            var agentsFile = Path.Combine(root, "state", "agents.json");
            if (File.Exists(agentsFile))
                frozen[agentsFile] = Digest(agentsFile);
            foreach (var path in files)
            {
                var id = Path.GetRelativePath(AuthorityDirectory, path[..^5])
                    .Replace(Path.DirectorySeparatorChar, '/');
                if (!SessionIdentity.IsValid(id) || !ids.Add(id))
                    throw new InvalidDataException("Invalid predecessor authority filename.");
                var bytes = File.ReadAllBytes(path);
                frozen[path] = SHA256.HashData(bytes);
                var raw =
                    JsonNode.Parse(bytes) as JsonObject
                    ?? throw new InvalidDataException("Predecessor authority must be an object.");
                if (Number(raw["sessionStateVersion"]) != 1)
                    throw new InvalidDataException(
                        "The predecessor import only accepts declared .NET-v1 authorities."
                    );
                var agent = Text(raw["agent"]) ?? SessionIdentity.Agent(id);
                if (!agents.Exists(agent) || agent != SessionIdentity.Agent(id))
                    throw new InvalidDataException("Predecessor Agent binding is invalid.");
                _ = SessionAuthorityDocument.FromOwned(
                    NormalizeAuthority(raw, id, agent),
                    id,
                    agent
                );
                var authority = (JsonObject)raw.DeepClone();
                authority["id"] = id;
                rows.Add(new(id, Project(authority)));
            }
            var archivePath = Path.Combine(root, "state", "archive-store.sqlite");
            if (File.Exists(archivePath))
            {
                foreach (var candidate in new[] { archivePath, archivePath + "-wal" })
                    if (
                        File.Exists(candidate)
                        && (candidate == archivePath || new FileInfo(candidate).Length > 0)
                    )
                        frozen[candidate] = Digest(candidate);
                using var connection = new SqliteConnection(
                    new SqliteConnectionStringBuilder
                    {
                        DataSource = archivePath,
                        Mode = SqliteOpenMode.ReadOnly,
                        Pooling = false,
                    }.ToString()
                );
                connection.Open();
                foreach (var table in new[] { "archive_messages", "archive_blocks" })
                {
                    if (
                        Scalar(
                            connection,
                            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$p0",
                            table
                        )
                        is null
                    )
                        continue;
                    using var command = Command(
                        connection,
                        $"SELECT DISTINCT session_id FROM {table}"
                    );
                    using var reader = command.ExecuteReader();
                    while (reader.Read())
                        if (!ids.Contains(reader.GetString(0)))
                            throw new InvalidDataException(
                                "Unknown predecessor Archive history has no authority evidence."
                            );
                }
            }
            // New-parent operations remain strict; import is source-tolerant stored topology.
            PublishNew(
                rows,
                null,
                () =>
                {
                    BeforeImportFreezeCheck?.Invoke();
                    if (
                        !AuthorityFiles()
                            .Order(StringComparer.Ordinal)
                            .SequenceEqual(files.Order(StringComparer.Ordinal))
                    )
                        throw new IOException(
                            "Predecessor authority file set changed during import."
                        );
                    foreach (var (path, expected) in frozen)
                        if (!File.Exists(path) || !Digest(path).SequenceEqual(expected))
                            throw new IOException("Predecessor input changed during import.");
                    if (File.Exists(agentsFile) != frozen.ContainsKey(agentsFile))
                        throw new IOException("Predecessor Agent catalog changed during import.");
                    if (File.Exists(archivePath) != frozen.ContainsKey(archivePath))
                        throw new IOException(
                            "Predecessor Archive file set changed during import."
                        );
                    // SQLite may create/remove an empty WAL during this read-only inspection.
                    if (
                        !frozen.ContainsKey(archivePath + "-wal")
                        && File.Exists(archivePath + "-wal")
                        && new FileInfo(archivePath + "-wal").Length > 0
                    )
                        throw new IOException("Predecessor Archive WAL changed during import.");
                }
            );
            Open();
            return rows.Count;
        }
    }
}

/// <summary>Explicit one-shot compatibility entry point; normal startup never calls it.</summary>
public static class SessionCatalogImport
{
    public static int ImportPreCatalogDotNetV1(string root, string workspace)
    {
        root = Path.GetFullPath(root);
        workspace = Path.GetFullPath(workspace);
        if (!Directory.Exists(root) || !Directory.Exists(workspace))
            throw new ArgumentException(
                "Import needs existing data and tool-workspace directories."
            );
        using var catalog = new SessionCatalog(root);
        return catalog.ImportDotNetV1(new AgentCatalog(root, workspace));
    }
}
