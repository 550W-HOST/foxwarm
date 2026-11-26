using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record SessionIdentityMoveRecord(
    string Phase,
    string OldId,
    string NewId,
    string OldAgent,
    string[] OldAliases,
    bool OwnsAgent,
    string? OwnedAgent,
    long CreatedAt,
    int Version = 2,
    string? OwnedAgentPreparation = null,
    JsonObject? PreviousAgentMetadata = null,
    bool? AgentDirectoryPublished = null
)
{
    internal string TargetAgent => SessionIdentity.Agent(NewId);

    internal JsonObject Json() =>
        new()
        {
            ["v"] = Version,
            ["phase"] = Phase,
            ["oldSessionId"] = OldId,
            ["newSessionId"] = NewId,
            ["oldAgent"] = OldAgent,
            ["oldAliases"] = new JsonArray(
                OldAliases.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
            ),
            ["ownsTargetAgentDirectory"] = OwnsAgent,
            ["targetAgentName"] = OwnedAgent,
            ["createdAt"] = CreatedAt,
            ["ownedAgentPreparation"] = OwnedAgentPreparation,
            ["previousAgentMetadata"] = PreviousAgentMetadata?.DeepClone(),
            ["agentDirectoryPublished"] = AgentDirectoryPublished,
        };
}

// Source-specific directional intent. It never authorizes reconstruction of a turn or an audit merge.
internal sealed class SessionIdentityMoveJournal(string root)
{
    internal string FilePath => Path.Combine(root, "state", "session-id-move-pending.json");

    internal static void SafeId(string id)
    {
        if (
            !SessionIdentity.IsValid(id)
            || Path.IsPathRooted(id)
            || id.Contains('\\')
            || id.Contains('\0')
            || id.Split('/').Any(part => part is "" or "." or "..")
        )
            throw new InvalidDataException("Unsafe Session identity in move intent.");
    }

    internal SessionIdentityMoveRecord? Read()
    {
        JsonObject row;
        try
        {
            row =
                JsonNode.Parse(File.ReadAllText(FilePath)) as JsonObject
                ?? throw new InvalidDataException("Identity move intent must be an object.");
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        return Parse(row);
    }

    /// <summary>Validates a stored move intent; any store keeps the same evidence rules.</summary>
    internal static SessionIdentityMoveRecord Parse(JsonObject row)
    {
        var phase = SessionCatalog.Text(row["phase"]);
        var old = SessionCatalog.Text(row["oldSessionId"]);
        var target = SessionCatalog.Text(row["newSessionId"]);
        var version = SessionCatalog.Number(row["v"]);
        if (
            version is not (1 or 2)
            || phase is not ("rolling-back" or "finishing")
            || old is null
            || target is null
            || old == target
            || row["oldAliases"] is not JsonArray aliases
            || aliases.Any(value => SessionCatalog.Text(value) is null)
            || row["ownsTargetAgentDirectory"] is not JsonValue owns
            || !owns.TryGetValue<bool>(out var ownsAgent)
        )
            throw new InvalidDataException(
                "Identity move intent lacks valid direction or ownership evidence."
            );
        SafeId(old);
        SafeId(target);
        var names = aliases.Select(value => SessionCatalog.Text(value)!).ToArray();
        foreach (var alias in names)
            SafeId(alias);
        var agent = SessionCatalog.Text(row["oldAgent"]) ?? "main";
        AgentCatalog.ValidateName(agent);
        if (agent != SessionIdentity.Agent(old))
            throw new InvalidDataException(
                "Identity move source Agent does not match its exact identity."
            );
        var owned = SessionCatalog.Text(row["targetAgentName"]);
        if (
            ownsAgent
                && (
                    owned is null
                    || owned == "main"
                    || owned == agent
                    || owned != SessionIdentity.Agent(target)
                )
            || !ownsAgent && owned is not null
        )
            throw new InvalidDataException(
                "Identity move intent cannot prove ownership of its destination directory."
            );
        var preparation = SessionCatalog.Text(row["ownedAgentPreparation"]);
        bool? published = null;
        if (row["agentDirectoryPublished"] is not null)
        {
            if (
                row["agentDirectoryPublished"] is not JsonValue flag
                || !flag.TryGetValue<bool>(out var value)
            )
                throw new InvalidDataException(
                    "Identity move has invalid Agent publication evidence."
                );
            published = value;
        }
        if (
            row["ownedAgentPreparation"] is not null && preparation is null
            || row["previousAgentMetadata"] is not null
                && row["previousAgentMetadata"] is not JsonObject
            || !ownsAgent
                && (
                    preparation is not null
                    || row["previousAgentMetadata"] is not null
                    || published is not null
                )
        )
            throw new InvalidDataException(
                "Identity move has invalid Agent preparation ownership."
            );
        if (preparation is not null)
            AgentCatalog.ValidatePreparationName(preparation);
        return new(
            phase,
            old,
            target,
            agent,
            names,
            ownsAgent,
            owned,
            (long)(SessionCatalog.Number(row["createdAt"]) ?? 0),
            (int)version!.Value,
            preparation,
            (JsonObject?)row["previousAgentMetadata"]?.DeepClone(),
            published
        );
    }

    internal void Write(SessionIdentityMoveRecord record) =>
        new AtomicJsonFile(root, "state/session-id-move-pending.json").WritePayload(
            record.Json()
        );

    internal void Clear()
    {
        File.Delete(FilePath);
        DirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
    }

    private string Artifact(string area, string id, string suffix)
    {
        SafeId(id);
        var path = Path.GetFullPath(Path.Combine(root, area, id + suffix));
        for (
            var directory = Path.GetDirectoryName(path);
            directory is not null
                && directory.StartsWith(
                    Path.GetFullPath(root) + Path.DirectorySeparatorChar,
                    StringComparison.Ordinal
                );
            directory = Path.GetDirectoryName(directory)
        )
            if (
                Directory.Exists(directory)
                && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0
            )
                throw new InvalidDataException(
                    "Identity artifact parent cannot be a symbolic link."
                );
        return path;
    }

    /// <summary>
    /// Moves every per-Session artifact of an identity move, starting with the authority, which
    /// its backend moves. Missing sources are skipped so recovery can replay a partial move.
    /// </summary>
    internal void MoveArtifacts(
        string from,
        string to,
        int version,
        Action<string, string> moveAuthority
    )
    {
        if (version is not (1 or 2))
            throw new InvalidDataException("Unsupported identity move intent version.");
        moveAuthority(from, to);
        var artifacts = new List<(string, string)>
        {
            ("logs/sessions", ".jsonl"),
            ("logs/sessions", ".blocks.jsonl"),
            ("state/sessions", ".frontier.json"),
        };
        if (version == 1)
            artifacts.Add(("state/sessions-blob", ".images"));
        foreach (var (area, suffix) in artifacts)
            MoveArtifact(area, suffix, from, to);
    }

    /// <summary>Moves one file or directory artifact, refusing symbolic links.</summary>
    internal void MoveArtifact(string area, string suffix, string from, string to)
    {
        var source = Artifact(area, from, suffix);
        var target = Artifact(area, to, suffix);
        if (!File.Exists(source) && !Directory.Exists(source))
            return;
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Identity artifact cannot be a symbolic link.");
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        if (Directory.Exists(source))
        {
            if (Directory.Exists(target))
                Directory.Delete(target, true);
            Directory.Move(source, target);
        }
        else
            File.Move(source, target, true);
        DirectorySync.Sync(Path.GetDirectoryName(source)!);
        DirectorySync.Sync(Path.GetDirectoryName(target)!);
    }
}

internal sealed class SessionIdentityUnavailableException(
    string message,
    JsonObject details,
    Exception? inner = null
) : InvalidOperationException(message, inner)
{
    internal const string Code = "SESSION_IDENTITY_RECOVERY_REQUIRED";
    internal JsonObject Details { get; } = (JsonObject)details.DeepClone();
}

internal sealed class SessionIdentityMoveException(
    string message,
    JsonObject details,
    Exception? inner = null
) : InvalidOperationException(message, inner)
{
    internal JsonObject Details { get; } = (JsonObject)details.DeepClone();
}

/// <summary>
/// Committed Session identities and the pending identity move: reservations of retired IDs,
/// rename commits and the move intent that startup recovery replays. The file implementation is
/// <see cref="FileIdentityLedger"/>.
/// </summary>
internal interface IIdentityLedger
{
    /// <summary>Fails startup when stored identity evidence is inconsistent.</summary>
    void ValidateStartupEvidence(bool allowPendingIdentityRecovery = false);

    Task InitializeAsync(ISessionCatalogStore catalog);
    bool IsReserved(string sessionId);
    void ValidateRename(string oldId, string newId);
    Task CommitRenameAsync(string oldId, string newId);

    SessionIdentityMoveRecord? ReadPendingMove();
    void WritePendingMove(SessionIdentityMoveRecord record);
    void ClearPendingMove();

    /// <summary>
    /// Moves the per-Session artifacts of an identity move; <paramref name="moveAuthority"/>
    /// moves the authority itself first.
    /// </summary>
    void MoveArtifacts(
        string fromId,
        string toId,
        int version,
        Action<string, string> moveAuthority
    );
}

/// <summary>
/// File-mode identity ledger: <c>state/session-id-reservations.jsonl</c> with its SQLite mirror
/// and <c>state/session-id-move-pending.json</c>.
/// </summary>
internal sealed class FileIdentityLedger(string dataRoot) : IIdentityLedger
{
    private readonly CommittedArchiveIdentity committed = new(dataRoot);

    private SessionIdentityMoveJournal Journal => new(dataRoot);

    public void ValidateStartupEvidence(bool allowPendingIdentityRecovery = false) =>
        CommittedArchiveIdentity.ValidateStartupEvidence(dataRoot, allowPendingIdentityRecovery);

    public Task InitializeAsync(ISessionCatalogStore catalog) => committed.InitializeAsync(catalog);

    public bool IsReserved(string sessionId) => committed.IsReserved(sessionId);

    public void ValidateRename(string oldId, string newId) => committed.ValidateRename(oldId, newId);

    public Task CommitRenameAsync(string oldId, string newId) =>
        committed.CommitRenameAsync(oldId, newId);

    public SessionIdentityMoveRecord? ReadPendingMove() => Journal.Read();

    public void WritePendingMove(SessionIdentityMoveRecord record) => Journal.Write(record);

    public void ClearPendingMove() => Journal.Clear();

    public void MoveArtifacts(
        string fromId,
        string toId,
        int version,
        Action<string, string> moveAuthority
    ) => Journal.MoveArtifacts(fromId, toId, version, moveAuthority);
}
