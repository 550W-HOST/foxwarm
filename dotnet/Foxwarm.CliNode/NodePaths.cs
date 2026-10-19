using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

// CLI roots are captured at process startup, independent of the Session's cwd.
internal sealed class NodePaths(string startupDirectory)
{
    internal string StartupDirectory { get; } =
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(startupDirectory));

    internal static string Home(string path) =>
        path == "~" ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        : path.StartsWith("~/", StringComparison.Ordinal)
        || path.StartsWith("~\\", StringComparison.Ordinal)
            ? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                path[2..]
            )
        : path;

    internal string AgentDirectory(string agent)
    {
        var explicitDirectory = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR")?.Trim();
        if (!string.IsNullOrEmpty(explicitDirectory))
            return FullPath(Home(explicitDirectory), StartupDirectory);
        var agents = Environment.GetEnvironmentVariable("FOXWARM_AGENTS_DIR")?.Trim();
        return FullPath(
            Path.Combine(Home(string.IsNullOrEmpty(agents) ? "agents" : agents), agent),
            StartupDirectory
        );
    }

    internal string Resolve(string? raw, string? agent, string? cwd = null)
    {
        if (string.IsNullOrEmpty(raw))
            throw new InvalidDataException("filePath is required");
        if (raw.Contains('\0'))
            throw new NodeFileException(
                "ERR_INVALID_ARG_VALUE",
                "The path must not contain null bytes."
            );
        var path = raw;
        if (path.StartsWith('$'))
        {
            var slash = path.IndexOf('/');
            var name = path[1..(slash < 0 ? path.Length : slash)];
            var root = name switch
            {
                "fw_agentdir" when agent is not null => AgentDirectory(agent),
                "fw_tmp" when agent is not null => Path.Combine(AgentDirectory(agent), "tmp"),
                "fw_agentdir" or "fw_tmp" => throw new InvalidDataException($"Agent path variable ${name} is unavailable in this execution environment."),
                _ => throw new InvalidDataException("Unknown Agent path variable: $" + name),
            };
            path =
                slash < 0
                    ? root
                    : Path.Combine(
                        root,
                        path[(slash + 1)..].TrimStart(Path.DirectorySeparatorChar)
                    );
        }
        path = Home(path);
        var basis = agent is null
            ? FullPath(string.IsNullOrEmpty(cwd) ? StartupDirectory : cwd, StartupDirectory)
            : !string.IsNullOrWhiteSpace(cwd)
                ? FullPath(Home(cwd.Trim()), StartupDirectory)
                : AgentDirectory(agent);
        return FullPath(path, basis);
    }

    internal (string Cwd, string? Raw, string Source) ExecCwd(
        JsonNode? argument,
        string? sessionCwd,
        string? agent,
        string node
    )
    {
        string? Expand(string? value)
        {
            value = value is null ? null : TrimSpace(value);
            if (string.IsNullOrEmpty(value))
                return null;
            return value.StartsWith('$') ? Resolve(value, agent, StartupDirectory) : value;
        }
        var explicitCwd = Expand(NodeFileTools.Text(argument));
        var session = Expand(sessionCwd);
        var source =
            explicitCwd is not null ? "explicit"
            : session is not null ? "session"
            : "default";
        var raw = explicitCwd ?? session;
        var basis = session is not null
            ? FullPath(Home(session), StartupDirectory)
            : StartupDirectory;
        var cwd = FullPath(Home(raw ?? StartupDirectory), basis);
        string Invalid(string reason) =>
            $"Cannot start exec on node `{node}`: working directory is invalid ({reason}). Source: {source}.{(raw is null ? "" : $" Raw cwd: `{raw}`.")} Resolved cwd: `{cwd}`.";
        FileAttributes attributes;
        try
        {
            attributes = File.GetAttributes(cwd);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            throw new InvalidDataException(Invalid("path does not exist"));
        }
        catch (UnauthorizedAccessException)
        {
            throw new InvalidDataException(Invalid("path is not accessible: EACCES"));
        }
        if ((attributes & FileAttributes.Directory) == 0)
            throw new InvalidDataException(Invalid("path is not a directory"));
        if (!OperatingSystem.IsWindows() && Foxwarm.Tools.NativeProcessFacts.Access(cwd, 5) != 0)
            throw new InvalidDataException(Invalid("directory is not accessible: EACCES"));
        return (cwd, raw, source);
    }

    internal static string TrimSpace(string value) => value.Trim(
                "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff".ToCharArray()
            );

    internal IEnumerable<string> RecoveryDirectories()
    {
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR")))
            return [AgentDirectory("main")];
        var root = Path.GetDirectoryName(AgentDirectory("__foxwarm_recovery_probe__"))!;
        return Directory.Exists(root)
            ? Directory
                .EnumerateDirectories(root)
                .Where(directory =>
                    (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0
                )
                .ToArray()
            : [];
    }

    private static string FullPath(string path, string basis) =>
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(path, basis));

    internal string Transfer(string raw, string agent, bool restrict)
    {
        var root = AgentDirectory(agent);
        var path = Resolve(raw, agent);
        if (
            restrict
            && path != root
            && !path.StartsWith(
                root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            )
        )
            throw new InvalidDataException(
                "Path traversal detected: cannot access files outside agent folder"
            );
        return path;
    }
}
