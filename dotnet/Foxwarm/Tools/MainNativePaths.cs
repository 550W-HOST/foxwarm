namespace Foxwarm.Tools;

// Native Main's configured Agent root is independent of a Session's working directory.
// File and exec resolution intentionally retain their different source default chains.
internal sealed record MainNativePaths(
    string AgentDirectory,
    string? SessionCwd,
    string ProcessCwd,
    string Home
)
{
    internal static string ExpandAgentToken(string path, string agentDirectory)
    {
        if (!path.StartsWith('$'))
            return path;
        var slash = path.IndexOf('/');
        var name = path[1..(slash < 0 ? path.Length : slash)];
        var root = name switch
        {
            "fw_agentdir" => agentDirectory,
            "fw_tmp" => Path.Combine(agentDirectory, "tmp"),
            _ => throw new ArgumentException($"Unknown Agent path variable: ${name}"),
        };
        return slash < 0
            ? root
            : Path.GetFullPath(root + Path.DirectorySeparatorChar + path[(slash + 1)..]);
    }

    private string ExpandHome(string path) =>
        path == "~" ? Home
        : path.StartsWith("~/", StringComparison.Ordinal)
        || path.StartsWith("~\\", StringComparison.Ordinal)
            ? Path.Combine(Home, path[2..])
        : path;

    internal string FilePath(string raw)
    {
        if (raw.Contains('\0'))
            throw new ArgumentException("Invalid path.");
        var candidate = ExpandHome(ExpandAgentToken(raw, AgentDirectory));
        if (Path.IsPathRooted(candidate))
            return Path.GetFullPath(candidate);
        var stored = SessionCwd is null ? "" : SessionGoalTrim(SessionCwd);
        var basis = stored.Length > 0 ? ExpandHome(stored) : AgentDirectory;
        return Path.GetFullPath(Path.Combine(basis, candidate), ProcessCwd);
    }

    internal string ExecCwd(string? explicitValue)
    {
        string? Expand(string? value) =>
            value is null ? null : ExpandAgentToken(SessionGoalTrim(value), AgentDirectory);
        var declared = Expand(explicitValue);
        var stored = Expand(SessionCwd);
        var explicitCwd = declared?.Length > 0 ? declared : null;
        var sessionCwd = stored?.Length > 0 ? stored : null;
        var basis = sessionCwd is not null ? ExpandHome(sessionCwd) : AgentDirectory;
        var candidate = ExpandHome(explicitCwd ?? sessionCwd ?? AgentDirectory);
        return Path.GetFullPath(
            Path.IsPathRooted(candidate) ? candidate : Path.Combine(basis, candidate),
            ProcessCwd
        );
    }

    internal static string SessionGoalTrim(string value) =>
        Foxwarm.Sessions.SessionGoal.Trim(value);

    internal static MainNativePaths Default(string agentDirectory, string? cwd = null) =>
        new(
            Path.GetFullPath(agentDirectory),
            cwd,
            Directory.GetCurrentDirectory(),
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        );
}
