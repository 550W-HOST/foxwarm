using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record ClaudeRuntimeConfiguration(string Executable, TimeSpan CredentialLifetime)
{
    internal static ClaudeRuntimeConfiguration Capture(JsonObject? app)
    {
        var raw = app?["claudeCode"];
        if (raw is not null && raw is not JsonObject)
            throw new InvalidDataException("claudeCode must be an object.");
        var config = raw as JsonObject;
        if (config?.Any(p => p.Key is not ("executable" or "credentialLifetimeSeconds")) == true)
            throw new InvalidDataException("Unsupported claudeCode setting.");
        string? Text(string key)
        {
            if (config?.ContainsKey(key) != true)
                return null;
            return
                SessionWait.Text(config[key]) is { Length: > 0 } text
                && !text.Contains('\0')
                && text.Trim() == text
                ? text
                : throw new InvalidDataException("Invalid claudeCode." + key + ".");
        }
        var executable = Text("executable") ?? "claude";
        var seconds = config?["credentialLifetimeSeconds"] is null
            ? 3600
            : SessionWait.Number(config["credentialLifetimeSeconds"]);
        if (
            seconds is null
            || !double.IsFinite(seconds.Value)
            || seconds < 1
            || seconds > 86400
            || seconds != Math.Truncate(seconds.Value)
        )
            throw new InvalidDataException(
                "claudeCode.credentialLifetimeSeconds must be an integer from 1 to 86400."
            );
        return new(executable, TimeSpan.FromSeconds(seconds.Value));
    }

    // Check only local launch prerequisites. Never run the CLI/wrapper or inspect its account.
    internal string? UnavailableReason(SessionManager manager, string? cwd = null)
    {
        if (!OperatingSystem.IsLinux())
            return "Claude Code requires Linux on master.";
        if (manager.RuntimeMcpEndpoint is null)
            return "Claude Code requires the Main server's HTTP listener.";
        if (!CanExecute("setsid", Environment.CurrentDirectory))
            return "Install setsid on the Main server's PATH to use Claude Code.";
        // New Sessions launch in a fresh private context, not Main's or the Agent's cwd.
        cwd ??= ClaudeSessionDriver.ContextDirectory(manager.DataRoot, Guid.NewGuid().ToString());
        if (!CanExecute(Executable, cwd))
            return "Claude Code launcher was not found or is not executable. Install claude on the Main server's PATH or configure claudeCode.executable.";
        return null;
    }

    private static bool CanExecute(string executable, string cwd)
    {
        bool Candidate(string path)
        {
            var fullPath = Path.GetFullPath(path, cwd);
            // File.Exists excludes directories and follows symlinks. Check effective-user execute
            // access (including parent directories/ACLs), rather than any single Unix mode bit.
            return File.Exists(fullPath) && faccessat(-100, fullPath, 1, 0x200) == 0;
        }
        if (executable.Contains('/'))
            return Candidate(executable);
        return (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator)
            .Any(directory => Candidate(Path.Combine(directory, executable)));
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int faccessat(int dirfd, string pathname, int mode, int flags);
}
