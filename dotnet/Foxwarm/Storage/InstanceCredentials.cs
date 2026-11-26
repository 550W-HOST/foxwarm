using System.Text;

namespace Foxwarm.Storage;

/// <summary>Installation credentials generated once and kept for the installation's lifetime.</summary>
internal enum InstanceCredentialName
{
    /// <summary>The HTTP access token (<c>state/token</c>).</summary>
    HttpToken,

    /// <summary>The Node pairing token (<c>state/node_token</c>).</summary>
    NodePairingToken,

    /// <summary>The Node event capability secret (<c>state/node_event_capability_secret</c>).</summary>
    NodeEventCapability,
}

/// <summary>
/// Credentials of one installation. A credential is created at most once, owner-only, and
/// then always read back; callers trim and validate the text. The file implementation is
/// <see cref="FileInstanceCredentials"/>.
/// </summary>
internal interface IInstanceCredentials
{
    /// <summary>The stored text, or null when the credential doesn't exist.</summary>
    string? Read(InstanceCredentialName name);

    /// <summary>
    /// The stored text, creating it from <paramref name="generate"/> when it doesn't exist.
    /// </summary>
    string ReadOrCreate(InstanceCredentialName name, Func<string> generate);
}

/// <summary>Today's credential files under <c>state/</c>, each with its existing rules.</summary>
internal sealed class FileInstanceCredentials(string dataRoot) : IInstanceCredentials
{
    private static readonly UTF8Encoding Strict = new(false, true);
    private readonly string root = Path.GetFullPath(dataRoot);

    internal string PathFor(InstanceCredentialName name) =>
        Path.Combine(
            root,
            "state",
            name switch
            {
                InstanceCredentialName.HttpToken => "token",
                InstanceCredentialName.NodePairingToken => "node_token",
                InstanceCredentialName.NodeEventCapability => "node_event_capability_secret",
                _ => throw new ArgumentOutOfRangeException(nameof(name)),
            }
        );

    public string? Read(InstanceCredentialName name)
    {
        var path = PathFor(name);
        switch (name)
        {
            case InstanceCredentialName.HttpToken:
                try
                {
                    return Strict.GetString(File.ReadAllBytes(path));
                }
                catch (Exception error)
                    when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    return null;
                }
            case InstanceCredentialName.NodePairingToken:
                return File.Exists(path) ? File.ReadAllText(path, Strict) : null;
            default:
                return File.Exists(path) ? File.ReadAllText(path) : null;
        }
    }

    public string ReadOrCreate(InstanceCredentialName name, Func<string> generate)
    {
        var path = PathFor(name);
        switch (name)
        {
            case InstanceCredentialName.HttpToken:
            {
                if (Read(name) is { } existing)
                    return existing;
                var token = generate();
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var options = new FileStreamOptions
                {
                    Mode = FileMode.CreateNew,
                    Access = FileAccess.Write,
                };
                if (!OperatingSystem.IsWindows())
                    options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using var stream = new FileStream(path, options);
                stream.Write(Encoding.UTF8.GetBytes(token));
                return token;
            }
            case InstanceCredentialName.NodePairingToken:
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (!File.Exists(path))
                {
                    File.WriteAllText(path, generate());
                    if (!OperatingSystem.IsWindows())
                        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
                return File.ReadAllText(path, Strict);
            default:
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                FileStream? created = null;
                try
                {
                    created = new FileStream(
                        path,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.Read
                    );
                }
                catch (IOException) when (File.Exists(path)) { }
                if (created is not null)
                {
                    using (created)
                    {
                        if (!OperatingSystem.IsWindows())
                            File.SetUnixFileMode(
                                path,
                                UnixFileMode.UserRead | UnixFileMode.UserWrite
                            );
                        created.Write(Encoding.ASCII.GetBytes(generate()));
                        created.Flush(true);
                        DirectorySync.Sync(Path.GetDirectoryName(path)!);
                    }
                }
                return File.ReadAllText(path);
        }
    }
}
