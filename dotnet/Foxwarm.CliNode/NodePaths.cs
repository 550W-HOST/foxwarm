namespace Foxwarm.CliNode;

// CLI roots are captured at process startup, independent of the Session's cwd.
internal sealed class NodePaths(string startupDirectory)
{
    internal string StartupDirectory { get; } = Path.GetFullPath(startupDirectory);

    internal static string Home(string path) =>
        path == "~" ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        : path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path[2..])
        : path;

    internal string AgentDirectory(string agent)
    {
        var explicitDirectory = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR")?.Trim();
        if (!string.IsNullOrEmpty(explicitDirectory))
            return Path.GetFullPath(Home(explicitDirectory), StartupDirectory);
        var agents = Environment.GetEnvironmentVariable("FOXWARM_AGENTS_DIR")?.Trim();
        return Path.GetFullPath(Path.Combine(Home(string.IsNullOrEmpty(agents) ? "agents" : agents), agent), StartupDirectory);
    }

    internal string Resolve(string? raw, string agent, string? cwd = null)
    {
        if (string.IsNullOrEmpty(raw))
            throw new InvalidDataException("filePath is required");
        if (raw.Contains('\0'))
            throw new NodeFileException("ERR_INVALID_ARG_VALUE", "The path must not contain null bytes.");
        var path = raw;
        if (path.StartsWith('$'))
        {
            var slash = path.IndexOf('/');
            var name = path[1..(slash < 0 ? path.Length : slash)];
            var root = name switch
            {
                "fw_agentdir" => AgentDirectory(agent),
                "fw_tmp" => Path.Combine(AgentDirectory(agent), "tmp"),
                _ => throw new InvalidDataException("Unknown Agent path variable: $" + name),
            };
            path = slash < 0 ? root : Path.Combine(root, path[(slash + 1)..].TrimStart(Path.DirectorySeparatorChar));
        }
        path = Home(path);
        var basis = !string.IsNullOrWhiteSpace(cwd)
            ? Path.GetFullPath(Home(cwd.Trim()), StartupDirectory)
            : AgentDirectory(agent);
        return Path.GetFullPath(path, basis);
    }

    internal string Transfer(string raw, string agent, bool restrict)
    {
        var root = AgentDirectory(agent);
        var path = Resolve(raw, agent);
        if (restrict && path != root && !path.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidDataException("Path traversal detected: cannot access files outside agent folder");
        return path;
    }
}
