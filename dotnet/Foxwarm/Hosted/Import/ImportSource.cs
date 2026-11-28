using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Hosted.Import;

/// <summary>An import that can't start; the message names the reason and the operator's next step.</summary>
internal sealed class ImportRefusedException(string message) : Exception(message);

/// <summary>
/// The file-mode data directory being imported. It is the rollback point, so nothing here
/// writes to it: the installation lock is held without writing (<see cref="InstallationLock.HoldExisting"/>),
/// files are only read, and every SQLite store is read from a private copy in the work
/// directory, so no WAL replay, shared-memory index or schema step touches the source.
/// </summary>
internal sealed class ImportSource : IDisposable
{
    private readonly InstallationLock held;

    private ImportSource(string root, InstallationLock held)
    {
        Root = root;
        this.held = held;
    }

    internal string Root { get; }

    internal string State => Path.Combine(Root, "state");

    /// <summary>Opens <paramref name="dataRoot"/> and holds its installation lock until disposed.</summary>
    internal static ImportSource Open(string dataRoot)
    {
        var root = Directory.Exists(dataRoot) ? HostedDirectory.ExistingPath(dataRoot) : Path.GetFullPath(dataRoot);
        _ = Resolve(root, Path.Combine("state", InstallationLock.FileName));
        if (!Directory.Exists(Path.Combine(root, "state")))
            throw new ImportRefusedException($"{root} isn't a Foxwarm data directory: it has no state directory.");
        InstallationLock? held;
        try
        {
            held = InstallationLock.HoldExisting(root);
        }
        catch (InstallationLockedException error)
        {
            throw new ImportRefusedException(
                error.Message + " Stop Main before importing: the import reads the installation while nothing writes to it."
            );
        }
        if (held is null)
            throw new ImportRefusedException(
                $"state/{InstallationLock.FileName} is missing, so this data directory hasn't been run by this Foxwarm version."
                    + " Start and stop Main once with this version, which brings the data to the current format, then import."
            );
        return new ImportSource(root, held);
    }

    internal string PathOf(string relative) => Resolve(Root, relative);

    // The source is an offline copy, held under its installation lock. Check components in
    // filesystem order, including the nearest existing parent of optional (missing) files.
    private static string Resolve(string root, string relative)
    {
        ImportRefusedException Outside() => new($"The import source has a link that points outside it: {relative}. Copy the target into the source tree or remove the link.");
        if (Path.IsPathRooted(relative)) throw Outside();
        var current = root;
        foreach (var part in relative.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == ".") continue;
            if (part == "..") throw Outside();
            current = Path.Combine(current, part);
            var info = new FileInfo(current);
            if (info.LinkTarget is null)
            {
                if (!OperatingSystem.IsWindows()) continue;
                var attributes = info.Attributes;
                if (attributes == (FileAttributes)(-1) || (attributes & FileAttributes.ReparsePoint) == 0) continue;
            }
            try { current = HostedDirectory.ExistingPath(current); }
            catch (IOException)
            {
                throw new ImportRefusedException($"The import source has a link that cannot be resolved: {relative}. Restore the target or remove the link.");
            }
            var within = Path.GetRelativePath(root, current);
            if (Path.IsPathRooted(within) || within == ".." || within.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw Outside();
        }
        return current;
    }

    // Yield logical paths to keep Session IDs and blob keys independent of link targets.
    internal IEnumerable<string> Files(string directory, bool recurse = true)
    {
        var ancestors = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        return Walk(directory);
        IEnumerable<string> Walk(string relative)
        {
            var physical = PathOf(relative);
            if (!Directory.Exists(physical)) yield break;
            if (!ancestors.Add(physical)) throw new ImportRefusedException($"The import source contains a directory cycle: {relative}. Remove the circular link before importing.");
            try
            {
                foreach (var entry in Directory.EnumerateFileSystemEntries(physical))
                {
                    var logical = Path.Combine(relative, Path.GetFileName(entry));
                    var target = PathOf(logical);
                    if (!Directory.Exists(target)) yield return logical;
                    else if (recurse)
                        foreach (var item in Walk(logical)) yield return item;
                }
            }
            finally { ancestors.Remove(physical); }
        }
    }

    // Check fixed inputs even in a dry run, before any write phase.
    internal void CheckFixedInputs()
    {
        var documents = new Storage.FileStateDocuments(Root);
        foreach (var name in Enum.GetValues<Storage.StateDocumentName>())
            PathOf(Path.GetRelativePath(Root, documents.Open(name).Locator));
        var credentials = new Storage.FileInstanceCredentials(Root);
        foreach (var name in Enum.GetValues<Storage.InstanceCredentialName>())
            PathOf(Path.GetRelativePath(Root, credentials.PathFor(name)));
        foreach (var name in new[] { "config.yaml", "models.yaml", "tool-authorization.yaml", "mcp.json", "webui.json", "migrationVersion.json", "session-id-move-pending.json" })
            PathOf("state/" + name);
    }

    internal string? ReadCredential(Storage.InstanceCredentialName name)
    {
        var relative = Path.GetRelativePath(Root, new Storage.FileInstanceCredentials(Root).PathFor(name));
        return Storage.FileInstanceCredentials.ReadAt(name, PathOf(relative));
    }

    internal string? ReadDocument(Storage.StateDocumentName name) =>
        ReadText(Path.GetRelativePath(Root, new Storage.FileStateDocuments(Root).Open(name).Locator));

    internal Task<JsonObject> ReadRunAsync(string id, CancellationToken token)
    {
        ToolScript.ToolScriptRunLanes.ValidateId(id);
        return new ToolScript.ToolScriptDataBudget().ReadRecordAsync(PathOf(Path.Combine("state/toolscript-runs", id + ".json")), token);
    }

    internal bool Exists(string relative) => File.Exists(PathOf(relative));

    internal string? ReadText(string relative)
    {
        try
        {
            return File.ReadAllText(PathOf(relative));
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    internal byte[]? ReadBytes(string relative)
    {
        try
        {
            return File.ReadAllBytes(PathOf(relative));
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    internal JsonObject? ReadJson(string relative) =>
        ReadText(relative) is { } text
            ? JsonNode.Parse(text) as JsonObject
                ?? throw new InvalidDataException(relative + " isn't a JSON object.")
            : null;

    /// <summary>The SQLite stores the import reads, under <c>state/</c>.</summary>
    internal static readonly string[] SqliteFiles =
    [
        "catalog.sqlite",
        "archive-store.sqlite",
        "tasks.sqlite",
        "llm-request-journal.sqlite",
        "text-redaction.sqlite",
        "session-runtime.sqlite",
    ];

    /// <summary>
    /// Copies <c>state/<paramref name="file"/></c> with its write-ahead log into
    /// <paramref name="workRoot"/>'s state directory and checkpoints the copy, so the copy holds
    /// every committed transaction whether or not the stopped Main checkpointed. Returns the
    /// copy's path, or null when the store doesn't exist. Main is stopped and its lock held, so
    /// the two files are one consistent state.
    /// </summary>
    internal string? Snapshot(string file, string workRoot)
    {
        var source = PathOf("state/" + file);
        if (!File.Exists(source))
            return null;
        var target = Path.Combine(workRoot, "state", file);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(source, target, overwrite: true);
        var wal = PathOf("state/" + file + "-wal");
        if (File.Exists(wal))
            File.Copy(wal, target + "-wal", overwrite: true);
        using (var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = target, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString()
        ))
        {
            connection.Open();
            using var checkpoint = connection.CreateCommand();
            checkpoint.CommandText = "PRAGMA wal_checkpoint(TRUNCATE)";
            checkpoint.ExecuteNonQuery();
        }
        return target;
    }

    /// <summary>
    /// Session authority documents: every <c>state/sessions/**/&lt;id&gt;.json</c> except the
    /// legacy frontier files, with the Session ID being the relative path without the extension.
    /// </summary>
    internal IEnumerable<(string Id, string Path)> SessionDocuments()
    {
        foreach (var entry in Files("state/sessions").Order(StringComparer.Ordinal))
        {
            if (!entry.EndsWith(".json", StringComparison.Ordinal) || entry.EndsWith(".frontier.json", StringComparison.Ordinal)) continue;
            var relative = Path.GetRelativePath("state/sessions", entry).Replace(Path.DirectorySeparatorChar, '/');
            yield return (relative[..^".json".Length], PathOf(entry));
        }
    }

    internal (int Frontier, int Other) SessionDirectoryLeftovers()
    {
        var frontier = 0;
        var other = 0;
        foreach (var entry in Files("state/sessions"))
            if (entry.EndsWith(".frontier.json", StringComparison.Ordinal)) frontier++;
            else if (!entry.EndsWith(".json", StringComparison.Ordinal)) other++;
        return (frontier, other);
    }

    /// <summary>Opens a read-only connection to a snapshot copy made by <see cref="Snapshot"/>.</summary>
    internal static SqliteConnection OpenCopy(string path)
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        return connection;
    }

    public void Dispose() => held.Dispose();
}
