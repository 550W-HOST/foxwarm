namespace Foxwarm.Storage;

/// <summary>
/// Small installation state kept as one whole document each. The set is closed: a store is
/// added here together with its owning domain class.
/// </summary>
internal enum StateDocumentName
{
    Timers,
    RunningExec,
    Channels,
    Nodes,
    McpOAuth,
    Agents,
    Installation,
    Secrets,
    SecretExposures,
    ChannelCursors,
}

/// <summary>Write-stage observation for tests of the file implementation.</summary>
internal sealed record StateDocumentOptions(Action<AtomicJsonWriteStage>? WriteStage = null);

/// <summary>
/// Whole-document state: read the current text, replace it atomically. Parsing, validation and
/// the meaning of the document stay in the owning domain class, which also serializes its own
/// writes. The file implementation is <see cref="FileStateDocuments"/>.
/// </summary>
internal interface IStateDocuments
{
    IStateDocument Open(StateDocumentName name, StateDocumentOptions? options = null);
}

internal interface IStateDocument
{
    /// <summary>Where the document lives, for diagnostics only.</summary>
    string Locator { get; }

    /// <summary>Whether the document exists.</summary>
    bool Exists();

    /// <summary>The current text, or null when the document doesn't exist.</summary>
    string? ReadText();

    Task<string?> ReadTextAsync(CancellationToken token = default);

    /// <summary>
    /// Parses the current text, falling back to retained earlier versions, newest first, when it
    /// is missing or unreadable. Null when none exists; when every existing version failed, the
    /// last failure is rethrown. <paramref name="source"/> is the locator of the version used,
    /// equal to <see cref="Locator"/> for the current one.
    /// </summary>
    T? ReadFirstAvailable<T>(Func<string, T> parse, out string? source)
        where T : class;

    /// <summary>
    /// Replaces the whole document. A failure before the new text is published leaves the
    /// previous document; a failure after it throws <see cref="AuthorityCommittedException"/>.
    /// </summary>
    void ReplaceText(string text, CancellationToken token = default);

    /// <summary>Makes the current document durable without changing it.</summary>
    void EnsureDurable();
}

/// <summary>Today's state files under <c>state/</c>, each with its existing read and write rules.</summary>
internal sealed class FileStateDocuments(string dataRoot) : IStateDocuments
{
    private readonly string root = Path.GetFullPath(dataRoot);

    public IStateDocument Open(StateDocumentName name, StateDocumentOptions? options = null) =>
        name switch
        {
            StateDocumentName.Timers => new File(
                root,
                "state/timers.json",
                options,
                Absence.KnownParent,
                "Timer store parent is unavailable."
            ),
            StateDocumentName.RunningExec => new File(
                root,
                Path.Combine("state", "running-exec.json"),
                options,
                Absence.NotFound
            ),
            StateDocumentName.Channels => new File(
                root,
                Path.Combine("state", "channels.json"),
                options,
                Absence.NotFound
            ),
            StateDocumentName.ChannelCursors => new File(root, "state/channel-cursors.json", options, Absence.NotFound, privateFile: true),
            StateDocumentName.Nodes => new File(
                root,
                "state/nodes.json",
                options,
                Absence.Exists,
                privateFile: true,
                backups: new(
                    Rotate: 3,
                    IncludeLegacyBak: true,
                    OnError: error =>
                        Console.Error.WriteLine(
                            "[nodes] Failed to rotate Node registry backups: " + error.Message
                        )
                )
            ),
            StateDocumentName.McpOAuth => new File(
                root,
                "state/mcp-oauth.json",
                options,
                Absence.Exists,
                privateFile: true
            ),
            StateDocumentName.Agents => new File(
                root,
                "state/agents.json",
                options,
                Absence.Exists
            ),
            StateDocumentName.Installation => new File(
                root,
                "state/installation.json",
                options,
                Absence.Exists
            ),
            StateDocumentName.Secrets => new File(
                root,
                "state/secrets.json",
                options,
                Absence.Exists,
                privateFile: true
            ),
            StateDocumentName.SecretExposures => new File(
                root,
                "state/secret-exposures.json",
                options,
                Absence.Exists,
                privateFile: true
            ),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    // How each existing reader decided that its file was absent.
    private enum Absence
    {
        // A missing file or directory reads as absent; anything else unreadable throws.
        NotFound,

        // File.Exists decides; a path that isn't a readable regular file reads as absent.
        Exists,

        // Absent only when the nearest existing ancestor is a directory.
        KnownParent,
    }

    private sealed class File(
        string root,
        string relativePath,
        StateDocumentOptions? options,
        Absence absence,
        string? unavailableParent = null,
        bool privateFile = false,
        AtomicJsonBackups? backups = null
    ) : IStateDocument
    {
        private readonly AtomicJsonFile file = new(
            root,
            relativePath,
            options?.WriteStage,
            privateFile,
            backups
        );

        public string Locator => file.FilePath;

        public bool Exists() => System.IO.File.Exists(file.FilePath);

        public string? ReadText()
        {
            if (absence == Absence.Exists)
                return System.IO.File.Exists(file.FilePath)
                    ? System.IO.File.ReadAllText(file.FilePath)
                    : null;
            if (absence == Absence.KnownParent && !Present())
                return null;
            try
            {
                return System.IO.File.ReadAllText(file.FilePath);
            }
            catch (Exception error)
                when (absence == Absence.NotFound
                    && error is FileNotFoundException or DirectoryNotFoundException)
            {
                return null;
            }
        }

        public async Task<string?> ReadTextAsync(CancellationToken token = default)
        {
            if (absence == Absence.Exists)
                return System.IO.File.Exists(file.FilePath)
                    ? await System.IO.File.ReadAllTextAsync(file.FilePath, token)
                    : null;
            if (absence == Absence.KnownParent && !Present())
                return null;
            try
            {
                return await System.IO.File.ReadAllTextAsync(file.FilePath, token);
            }
            catch (Exception error)
                when (absence == Absence.NotFound
                    && error is FileNotFoundException or DirectoryNotFoundException)
            {
                return null;
            }
        }

        public T? ReadFirstAvailable<T>(Func<string, T> parse, out string? source)
            where T : class =>
            file.LoadFirstAvailable(path => parse(System.IO.File.ReadAllText(path)), out source);

        public void ReplaceText(string text, CancellationToken token = default) =>
            file.WriteTextPayload(text, token);

        public void EnsureDurable() => DirectorySync.Sync(Path.GetDirectoryName(file.FilePath)!);

        // The file exists; when it doesn't, its nearest existing ancestor must be a directory.
        private bool Present()
        {
            try
            {
                _ = System.IO.File.GetAttributes(file.FilePath);
                return true;
            }
            catch (Exception error)
                when (error is FileNotFoundException or DirectoryNotFoundException)
            {
                RequireKnownAbsentParent();
                return false;
            }
        }

        private void RequireKnownAbsentParent()
        {
            for (
                var parent = Path.GetDirectoryName(file.FilePath);
                parent is not null;
                parent = Path.GetDirectoryName(parent)
            )
            {
                FileAttributes attributes;
                try
                {
                    attributes = System.IO.File.GetAttributes(parent);
                }
                catch (FileNotFoundException)
                {
                    continue;
                }
                catch (DirectoryNotFoundException)
                {
                    continue;
                }
                if (!attributes.HasFlag(FileAttributes.Directory) || !Directory.Exists(parent))
                    throw new IOException(unavailableParent);
                return;
            }
            throw new IOException(unavailableParent);
        }
    }
}
