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
        var root = Path.GetFullPath(dataRoot);
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

    internal string PathOf(string relative) => Path.Combine(Root, relative);

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
        var source = Path.Combine(State, file);
        if (!File.Exists(source))
            return null;
        var target = Path.Combine(workRoot, "state", file);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(source, target, overwrite: true);
        if (File.Exists(source + "-wal"))
            File.Copy(source + "-wal", target + "-wal", overwrite: true);
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
        var directory = Path.Combine(State, "sessions");
        if (!Directory.Exists(directory))
            yield break;
        foreach (
            var path in Directory
                .EnumerateFiles(directory, "*.json", SearchOption.AllDirectories)
                .Order(StringComparer.Ordinal)
        )
        {
            if (path.EndsWith(".frontier.json", StringComparison.Ordinal))
                continue;
            var relative = Path.GetRelativePath(directory, path).Replace(Path.DirectorySeparatorChar, '/');
            yield return (relative[..^".json".Length], path);
        }
    }

    /// <summary>Files under <c>state/sessions</c> that aren't authority documents.</summary>
    internal (int Frontier, int Other) SessionDirectoryLeftovers()
    {
        var directory = Path.Combine(State, "sessions");
        if (!Directory.Exists(directory))
            return (0, 0);
        var frontier = 0;
        var other = 0;
        foreach (var path in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
            if (path.EndsWith(".frontier.json", StringComparison.Ordinal))
                frontier++;
            else if (!path.EndsWith(".json", StringComparison.Ordinal))
                other++;
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
