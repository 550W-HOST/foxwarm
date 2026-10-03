using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record SessionIdentityMoveRecord(string Phase, string OldId, string NewId, string OldAgent,
    string[] OldAliases, bool OwnsAgent, string? OwnedAgent, long CreatedAt)
{
    internal string TargetAgent => SessionIdentity.Agent(NewId);
    internal JsonObject Json() => new()
    {
        ["v"] = 1, ["phase"] = Phase, ["oldSessionId"] = OldId, ["newSessionId"] = NewId,
        ["oldAgent"] = OldAgent, ["oldAliases"] = new JsonArray(OldAliases.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
        ["ownsTargetAgentDirectory"] = OwnsAgent, ["targetAgentName"] = OwnedAgent, ["createdAt"] = CreatedAt
    };
}

// Source-specific directional intent. It never authorizes reconstruction of a turn or an audit merge.
internal sealed class SessionIdentityMoveJournal(string root)
{
    internal string FilePath => Path.Combine(root, "state", "session-id-move-pending.json");
    internal static void SafeId(string id)
    {
        if (!SessionIdentity.IsValid(id) || Path.IsPathRooted(id) || id.Contains('\\') || id.Contains('\0')
            || id.Split('/').Any(part => part is "" or "." or ".."))
            throw new InvalidDataException("Unsafe Session identity in move intent.");
    }
    internal SessionIdentityMoveRecord? Read()
    {
        JsonObject row;
        try { row = JsonNode.Parse(File.ReadAllText(FilePath)) as JsonObject ?? throw new InvalidDataException("Identity move intent must be an object."); }
        catch (FileNotFoundException) { return null; } catch (DirectoryNotFoundException) { return null; }
        var phase = SessionCatalog.Text(row["phase"]); var old = SessionCatalog.Text(row["oldSessionId"]); var target = SessionCatalog.Text(row["newSessionId"]);
        if (SessionCatalog.Number(row["v"]) != 1 || phase is not ("rolling-back" or "finishing") || old is null || target is null || old == target
            || row["oldAliases"] is not JsonArray aliases || aliases.Any(value => SessionCatalog.Text(value) is null)
            || row["ownsTargetAgentDirectory"] is not JsonValue owns || !owns.TryGetValue<bool>(out var ownsAgent))
            throw new InvalidDataException("Identity move intent lacks valid direction or ownership evidence.");
        SafeId(old); SafeId(target); var names = aliases.Select(value => SessionCatalog.Text(value)!).ToArray(); foreach (var alias in names) SafeId(alias);
        var agent = SessionCatalog.Text(row["oldAgent"]) ?? "main"; AgentCatalog.ValidateName(agent);
        if (agent != SessionIdentity.Agent(old)) throw new InvalidDataException("Identity move source Agent does not match its exact identity.");
        var owned = SessionCatalog.Text(row["targetAgentName"]);
        if (ownsAgent && (owned is null || owned == "main" || owned == agent || owned != SessionIdentity.Agent(target)) || !ownsAgent && owned is not null)
            throw new InvalidDataException("Identity move intent cannot prove ownership of its destination directory.");
        return new(phase, old, target, agent, names, ownsAgent, owned, (long)(SessionCatalog.Number(row["createdAt"]) ?? 0));
    }
    internal void Write(SessionIdentityMoveRecord record) => new LinuxAtomicJsonFile(root, "state/session-id-move-pending.json").WritePayload(record.Json());
    internal void Clear()
    {
        File.Delete(FilePath); LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
    }
    internal string AuthorityPath(string id) { SafeId(id); return Path.Combine(root, "state", "sessions", id + ".json"); }
    private string Artifact(string area, string id, string suffix)
    {
        SafeId(id); var path = Path.GetFullPath(Path.Combine(root, area, id + suffix));
        for (var directory = Path.GetDirectoryName(path); directory is not null && directory.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.Ordinal); directory = Path.GetDirectoryName(directory))
            if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Identity artifact parent cannot be a symbolic link.");
        return path;
    }
    internal void MoveArtifacts(string from, string to)
    {
        foreach (var (area, suffix) in new[] { ("state/sessions", ".json"), ("logs/sessions", ".jsonl"), ("logs/sessions", ".blocks.jsonl"), ("state/sessions", ".frontier.json"), ("state/sessions-blob", ".images") })
        {
            var source = Artifact(area, from, suffix); var target = Artifact(area, to, suffix);
            if (!File.Exists(source) && !Directory.Exists(source)) continue;
            if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Identity artifact cannot be a symbolic link.");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (Directory.Exists(source)) { if (Directory.Exists(target)) Directory.Delete(target, true); Directory.Move(source, target); }
            else File.Move(source, target, true);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(source)!);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(target)!);
        }
    }
}

internal sealed class SessionIdentityUnavailableException(string message, JsonObject details, Exception? inner = null)
    : InvalidOperationException(message, inner)
{
    internal const string Code = "SESSION_IDENTITY_RECOVERY_REQUIRED";
    internal JsonObject Details { get; } = (JsonObject)details.DeepClone();
}
internal sealed class SessionIdentityMoveException(string message, JsonObject details, Exception? inner = null)
    : InvalidOperationException(message, inner)
{
    internal JsonObject Details { get; } = (JsonObject)details.DeepClone();
}
