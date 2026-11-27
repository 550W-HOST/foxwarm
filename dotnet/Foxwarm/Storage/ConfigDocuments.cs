using System.Text;
using Foxwarm.Tools;

namespace Foxwarm.Storage;

/// <summary>The configuration documents an installation edits through Setup and <c>set_config</c>.</summary>
internal enum ConfigDocumentName
{
    /// <summary>The app configuration (<c>state/config.yaml</c>).</summary>
    Config,

    /// <summary>The models configuration (<c>state/models.yaml</c>).</summary>
    Models,

    /// <summary>The tool authorization policy (<c>state/tool-authorization.yaml</c>).</summary>
    ToolAuthorization,

    /// <summary>The outbound MCP servers (<c>state/mcp.json</c>, or the configured path).</summary>
    Mcp,

    /// <summary>The WebUI presentation settings (<c>state/webui.json</c>).</summary>
    WebUi,
}

/// <summary>
/// Where the configuration documents live. A document is verbatim bytes: its owner parses,
/// validates and decodes it, and a replacement is atomic. The file implementation is
/// <see cref="FileConfigDocuments"/>; a database context stores the same text in a table.
/// </summary>
internal interface IConfigDocumentStore
{
    /// <summary>Where the document lives, for diagnostics and display.</summary>
    string Locator(ConfigDocumentName name);

    /// <summary>The document's file, or null when it isn't a file.</summary>
    string? PhysicalPath(ConfigDocumentName name);

    /// <summary>
    /// Whether the document can change outside this process (a file edited by hand). Without
    /// direct edits, an owner's cached value stays current until its own installation.
    /// </summary>
    bool DirectEdits { get; }

    bool Exists(ConfigDocumentName name);

    /// <summary>The stored bytes, or null when the document doesn't exist.</summary>
    byte[]? Read(ConfigDocumentName name);

    /// <summary>As <see cref="Read"/>, without blocking a thread on remote storage.</summary>
    Task<byte[]?> ReadAsync(ConfigDocumentName name, CancellationToken token) =>
        Task.FromResult(Read(name));

    /// <summary>
    /// The stored bytes, or null when the document doesn't exist, read as one value of at most
    /// <paramref name="maxBytes"/> bytes. A document that is larger, or that can't be read as
    /// one value, throws; it is never reported as absent.
    /// </summary>
    byte[]? ReadBounded(ConfigDocumentName name, int maxBytes);

    /// <summary>
    /// Replaces the document atomically. <see cref="AuthorityCommittedException"/> means the
    /// replacement is in place but its final durability step failed.
    /// </summary>
    Task ReplaceAsync(
        ConfigDocumentName name,
        byte[] bytes,
        CancellationToken token,
        Action<AtomicJsonWriteStage>? stage = null
    );

    /// <summary>Creates the document unless it exists; false when it already existed.</summary>
    Task<bool> TryCreateAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token);
}

internal static class ConfigDocumentText
{
    /// <summary>
    /// Decodes document bytes the way <see cref="File.ReadAllText(string, Encoding)"/> decodes
    /// a file with UTF-8: a byte order mark selects its encoding and isn't part of the text.
    /// </summary>
    internal static string Decode(byte[] bytes)
    {
        using var reader = new StreamReader(
            new MemoryStream(bytes, writable: false),
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: true
        );
        return reader.ReadToEnd();
    }
}

/// <summary>
/// Today's configuration files: <c>state/config.yaml</c>, <c>state/models.yaml</c>,
/// <c>state/tool-authorization.yaml</c> and <c>state/webui.json</c> under the data root, and the
/// MCP file at its configured path. Each keeps its existing file mode: owner-only except the
/// WebUI settings.
/// </summary>
internal sealed class FileConfigDocuments : IConfigDocumentStore
{
    private readonly string root;
    private readonly string configPath;
    private readonly string mcpPath;

    internal FileConfigDocuments(
        string dataRoot,
        string? mcpConfigPath = null,
        string? appConfigPath = null
    )
    {
        root = Path.GetFullPath(dataRoot);
        configPath = appConfigPath ?? Path.Combine(root, "state", "config.yaml");
        mcpPath = mcpConfigPath ?? Path.Combine(root, "state", "mcp.json");
    }

    // The captured locations: the app file and the MCP file may be configured elsewhere.
    internal FileConfigDocuments(HostPaths paths)
        : this(paths.DataRoot, paths.McpConfigPath, paths.ConfigPath) { }

    public bool DirectEdits => true;

    public string Locator(ConfigDocumentName name) => PathFor(name);

    public string? PhysicalPath(ConfigDocumentName name) => PathFor(name);

    internal string PathFor(ConfigDocumentName name) =>
        name switch
        {
            ConfigDocumentName.Config => configPath,
            ConfigDocumentName.Models => Path.Combine(root, "state", "models.yaml"),
            ConfigDocumentName.ToolAuthorization => Path.Combine(
                root,
                "state",
                "tool-authorization.yaml"
            ),
            ConfigDocumentName.Mcp => mcpPath,
            ConfigDocumentName.WebUi => Path.Combine(root, "state", "webui.json"),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    private static bool PrivateFile(ConfigDocumentName name) => name != ConfigDocumentName.WebUi;

    public bool Exists(ConfigDocumentName name) => File.Exists(PathFor(name));

    // A path that File.Exists doesn't report (missing, a directory, unreadable parent) is absent,
    // as every configuration reader has always treated it.
    public byte[]? Read(ConfigDocumentName name)
    {
        var path = PathFor(name);
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    // The policy reader's file checks: a regular file (absent only when missing), a regular-file
    // handle, and the byte limit while reading.
    public byte[]? ReadBounded(ConfigDocumentName name, int maxBytes)
    {
        var path = PathFor(name);
        try
        {
            if (!WorkspaceTools.PolicyFileKind(path, out var missing))
            {
                if (missing)
                    return null;
                throw new InvalidDataException("Policy must be a readable regular file.");
            }
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            );
            if (stream.Length > maxBytes)
                throw new InvalidDataException("Tool policy exceeds its byte limit.");
            using var output = new MemoryStream();
            var buffer = new byte[8192];
            int count;
            while ((count = stream.Read(buffer)) > 0)
            {
                if (output.Length + count > maxBytes)
                    throw new InvalidDataException("Tool policy exceeds its byte limit.");
                output.Write(buffer, 0, count);
            }
            return output.ToArray();
        }
        catch (Exception error)
            when ((error is FileNotFoundException or DirectoryNotFoundException)
                && !WorkspaceTools.PolicyFileKind(path, out var absent)
                && absent
            )
        {
            return null;
        }
    }

    public Task ReplaceAsync(
        ConfigDocumentName name,
        byte[] bytes,
        CancellationToken token,
        Action<AtomicJsonWriteStage>? stage = null
    )
    {
        var path = PathFor(name);
        var file = new AtomicJsonFile(
            Path.GetDirectoryName(path)!,
            Path.GetFileName(path),
            stage,
            privateFile: PrivateFile(name)
        );
        return file.WriteStreamPayloadAsync(stream => stream.Write(bytes), null, token);
    }

    // Publishes a complete temporary file without replacing one created concurrently.
    public async Task<bool> TryCreateAsync(
        ConfigDocumentName name,
        byte[] bytes,
        CancellationToken token
    )
    {
        var path = PathFor(name);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(
            directory,
            "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp"
        );
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, token);
            File.Move(temporary, path, false);
            return true;
        }
        catch (IOException) when (File.Exists(path))
        {
            return false;
        }
        finally
        {
            File.Delete(temporary);
        }
    }
}
