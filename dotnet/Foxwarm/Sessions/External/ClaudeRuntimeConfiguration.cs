using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record ClaudeRuntimeConfiguration(string Executable, string? WorkingDirectory, TimeSpan CredentialLifetime)
{
    internal static ClaudeRuntimeConfiguration Capture(JsonObject? app)
    {
        var raw = app?["claudeCode"];
        if (raw is not null && raw is not JsonObject) throw new InvalidDataException("claudeCode must be an object.");
        var config = raw as JsonObject;
        if (config?.Any(p => p.Key is not ("executable" or "workingDirectory" or "credentialLifetimeSeconds")) == true)
            throw new InvalidDataException("Unsupported claudeCode setting.");
        string? Text(string key)
        {
            if (config?.ContainsKey(key) != true) return null;
            return SessionWait.Text(config[key]) is { Length: > 0 } text && !text.Contains('\0') && text.Trim() == text
                ? text : throw new InvalidDataException("Invalid claudeCode." + key + ".");
        }
        var executable = Text("executable") ?? "claude";
        var cwd = Text("workingDirectory");
        if (cwd is not null && !Path.IsPathFullyQualified(cwd)) throw new InvalidDataException("claudeCode.workingDirectory must be an absolute Main-local path.");
        var seconds = config?["credentialLifetimeSeconds"] is null ? 3600 : SessionWait.Number(config["credentialLifetimeSeconds"]);
        if (seconds is null || !double.IsFinite(seconds.Value) || seconds < 1 || seconds > 86400 || seconds != Math.Truncate(seconds.Value))
            throw new InvalidDataException("claudeCode.credentialLifetimeSeconds must be an integer from 1 to 86400.");
        return new(executable, cwd, TimeSpan.FromSeconds(seconds.Value));
    }
}
