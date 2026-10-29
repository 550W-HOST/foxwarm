using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

/// <summary>One-host Agent directories and metadata, with a bounded retained-layout reader.</summary>
internal sealed partial class AgentCatalog
{
    private readonly string workspaceRoot;
    private readonly string agentRoot;
    private readonly string indexPath;
    private readonly bool canonicalLayout;
    private readonly SemaphoreSlim createGate = new(1, 1);
    private readonly object stateGate = new();
    private readonly Func<(int MaxDepth, int MaxChildren)> treeLimits;
    private readonly Action<AtomicJsonWriteStage>? metadataWriteStage;
    private JsonObject metadata = new();
    private readonly HashSet<string> known = new(StringComparer.Ordinal) { "main" };

    public AgentCatalog(
        string dataRoot,
        string workspaceRoot,
        string? recoveringOwnedAgent = null,
        bool canonicalLayout = false,
        bool createDirectories = true,
        Func<(int MaxDepth, int MaxChildren)>? treeLimits = null,
        Action<AtomicJsonWriteStage>? metadataWriteStage = null
    )
    {
        this.treeLimits = treeLimits ?? (() => (16, 128));
        this.metadataWriteStage = metadataWriteStage;
        this.workspaceRoot = Path.GetFullPath(workspaceRoot);
        this.canonicalLayout = canonicalLayout;
        agentRoot = canonicalLayout
            ? this.workspaceRoot
            : Path.Combine(this.workspaceRoot, "agents");
        indexPath = Path.Combine(Path.GetFullPath(dataRoot), "state", "agents.json");
        if (File.Exists(indexPath))
        {
            var index =
                JsonNode.Parse(File.ReadAllText(indexPath)) as JsonObject
                ?? throw new InvalidDataException("Agent metadata must be an object.");
            // Only the identified C# envelope selects the retained list reader.
            // Source metadata may itself contain Agents named version or agents.
            var legacy =
                index["version"] is JsonValue versionValue
                && versionValue.TryGetValue<int>(out var storedVersion)
                && storedVersion is 1 or 2
                && index["agents"] is JsonArray;
            if (legacy)
            {
                if (canonicalLayout)
                    throw new InvalidDataException(
                        "Retained C# Agent data requires its original workspace. Use an explicit embedded workspace caller or migrate the physical layout before normal startup; no files were relocated."
                    );
                var version = index["version"]!.GetValue<int>();
                if (
                    index.Count != (version == 1 ? 2 : 3)
                    || version == 2 && index["metadata"] is not JsonObject
                )
                    throw new InvalidDataException("Unsupported retained Agent catalog format.");
                if (version == 2)
                    metadata = (JsonObject)index["metadata"]!.DeepClone();
                foreach (var item in index["agents"]!.AsArray())
                {
                    var name =
                        item?.GetValue<string>()
                        ?? throw new InvalidDataException("Invalid Agent catalog entry.");
                    ValidateName(name);
                    if (name == "main" || !known.Add(name))
                        throw new InvalidDataException("Duplicate Agent catalog entry.");
                }
            }
            else
                metadata = (JsonObject)index.DeepClone();
        }
        if (createDirectories)
            Directory.CreateDirectory(agentRoot);
        if (
            Directory.Exists(agentRoot)
            && (File.GetAttributes(agentRoot) & FileAttributes.ReparsePoint) != 0
        )
            throw new InvalidDataException("Agent directory root cannot be a symbolic link.");
        foreach (var row in metadata)
            _ = Foxwarm.Tools.IsolatedToolCompatibility.Metadata(row.Value);
        if (!canonicalLayout)
            foreach (var name in known.Where(name => name != "main"))
            {
                var directory = Path.Combine(agentRoot, name);
                if (
                    !Directory.Exists(directory)
                    || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0
                )
                    if (
                        name != recoveringOwnedAgent
                        || Directory.Exists(directory)
                            && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0
                    )
                        throw new InvalidDataException(
                            $"Agent '{name}' directory is missing or invalid."
                        );
            }
        if (
            recoveringOwnedAgent is not null
            && Directory.Exists(Path.Combine(agentRoot, recoveringOwnedAgent))
            && (
                File.GetAttributes(Path.Combine(agentRoot, recoveringOwnedAgent))
                & FileAttributes.ReparsePoint
            ) != 0
        )
            throw new InvalidDataException("Owned identity destination cannot be a symbolic link.");
    }

    private IEnumerable<string> DirectoryMembers() =>
        Directory
            .EnumerateDirectories(agentRoot)
            .Where(path => (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0)
            .Select(Path.GetFileName)
            .OfType<string>()
            .Where(name => AgentName().IsMatch(name));

    public static void ValidateName(string name)
    {
        if (!AgentName().IsMatch(name))
            throw new InvalidDataException(
                "Agent name must use only letters, numbers, hyphens and underscores."
            );
    }

    public bool Exists(string name)
    {
        lock (stateGate)
        {
            if (known.Contains(name))
                return true;
            if (!canonicalLayout || !AgentName().IsMatch(name))
                return false;
            var directory = Path.Combine(agentRoot, name);
            return Directory.Exists(directory)
                && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0;
        }
    }

    public string[] List()
    {
        lock (stateGate)
            return (
                canonicalLayout
                    ? known.Concat(DirectoryMembers()).Distinct(StringComparer.Ordinal)
                    : known
            )
                .Order(StringComparer.Ordinal)
                .ToArray();
    }

    internal IEnumerable<string> ExecLogRoots()
    {
        if (!canonicalLayout)
            yield return Path.Combine(workspaceRoot, ".temp", "exec");
        foreach (var path in Directory.EnumerateFileSystemEntries(agentRoot))
            if (
                (
                    File.GetAttributes(path)
                    & (FileAttributes.Directory | FileAttributes.ReparsePoint)
                ) == FileAttributes.Directory
            )
                yield return Path.Combine(path, ".temp", "exec");
    }

    public string AgentDirectory(string name)
    {
        if (!Exists(name))
            throw new InvalidDataException($"Agent '{name}' does not exist.");
        return SourceDirectory(name);
    }

    public string MemoryDirectory(string name) => Path.Combine(AgentDirectory(name), "memory");

    public string FrameworkSystemPath => Path.Combine(agentRoot, "00_SYSTEM.md");
    public string MainFallbackSystemPath =>
        Path.Combine(SourceDirectory("main"), "memory", "00_SYSTEM.md");

    public async Task CreateAsync(
        string name,
        string? initialMemory = null,
        string? inherit = null,
        string? initialSoul = null,
        string? createdBy = null,
        JsonArray? rules = null,
        string? defaultNode = null,
        string? preparationName = null,
        bool restoreRetained = false,
        Action<bool>? publication = null
    )
    {
        ValidateName(name);
        if (name == "main" && (!restoreRetained || !canonicalLayout))
            throw new InvalidDataException("The main Agent already exists.");
        var directory = SourceDirectory(name);
        var prepared = PreparationPath(
            preparationName ?? ".create-" + Guid.NewGuid().ToString("N")
        );
        await createGate.WaitAsync();
        var createdDirectory = false;
        var publishedDirectory = false;
        var committed = false;
        JsonObject? initialMetadata = null;
        Monitor.Enter(stateGate);
        try
        {
            if (
                (!restoreRetained && Exists(name))
                || Directory.Exists(directory)
                || File.Exists(directory)
            )
                throw new InvalidDataException(
                    $"Agent '{name}' already exists or its directory is reserved."
                );
            var previous = MetadataSnapshot()[name] as JsonObject;
            if (restoreRetained)
            {
                if (previous is null)
                    throw new InvalidDataException(
                        "No retained Agent metadata exists for this name."
                    );
                if (
                    initialMemory is not null
                    || inherit is not null
                    || initialSoul is not null
                    || createdBy is not null
                    || rules is not null
                    || defaultNode is not null
                )
                    throw new InvalidDataException(
                        "Restoration does not accept metadata overrides."
                    );
                createdBy = Creator(MetadataSnapshot(), name);
                inherit = SessionWait.Text(previous["inherit"]);
                rules = previous.ContainsKey("rules")
                    ? previous["rules"] as JsonArray
                        ?? throw new InvalidDataException("Retained Agent rules must be an array.")
                    : null;
            }
            if (
                !restoreRetained
                && previous is not null
                && new[] { "createdBy", "rules" }.Any(previous.ContainsKey)
            )
                throw new InvalidDataException(
                    "This name has retained Agent authority. Use administrator restoration or explicit retained-record cleanup."
                );
            ValidateCreatorAdmission(createdBy, MetadataSnapshot());
            _ = Foxwarm.Tools.AgentRulePolicy.Parse(rules ?? new JsonArray());
            ValidateDefaultNode(defaultNode ?? DefaultNode(name));
            ValidateInheritance(name, inherit);
            ValidateCreatorInheritance(
                name,
                inherit ?? SessionWait.Text(previous?["inherit"]),
                createdBy
            );
            initialMetadata = previous is null
                ? new JsonObject()
                : (JsonObject)previous.DeepClone();
            if (createdBy is not null)
                initialMetadata["createdBy"] = createdBy;
            if (rules is not null)
                initialMetadata["rules"] = rules.DeepClone();
            if (defaultNode is not null)
                initialMetadata["defaultNode"] = defaultNode;
            if (inherit is not null)
                initialMetadata["inherit"] = inherit;
            // Dot-prefixed preparation is not Agent membership. Persist authority before
            // publishing the final directory so restart cannot discover an unrestricted child.
            if (IdentityEntry(prepared) is not null)
                throw new AgentIdentityCleanupException([prepared]);
            Directory.CreateDirectory(prepared);
            createdDirectory = true;
            if (preparationName is not null)
                WriteIdentityProof(prepared, preparationName);
            Directory.CreateDirectory(Path.Combine(prepared, "memory"));
            if (initialMemory is not null)
                File.WriteAllText(Path.Combine(prepared, "memory", "MEMORY.md"), initialMemory);
            if (initialSoul is not null)
                File.WriteAllText(Path.Combine(prepared, "memory", "SOUL.md"), initialSoul);
            var next = List()
                .Where(existing => existing != "main")
                .Append(name)
                .Order(StringComparer.Ordinal)
                .ToArray();
            var nextMetadata = MetadataSnapshot();
            if (initialMetadata.Count > 0)
                nextMetadata[name] = initialMetadata.DeepClone();
            var payload = Payload(next, nextMetadata);
            AuthorityCommittedException? durabilityFailure = null;
            try
            {
                AtomicIndexWrite(indexPath, payload.ToJsonString());
            }
            catch (AuthorityCommittedException error)
            {
                durabilityFailure = error;
            }
            committed = true;
            Directory.Move(prepared, directory);
            publishedDirectory = true;
            lock (stateGate)
            {
                if (!canonicalLayout)
                    known.Add(name);
                if (initialMetadata is { Count: > 0 })
                    metadata[name] = initialMetadata.DeepClone();
            }
            if (durabilityFailure is not null)
                throw durabilityFailure;
        }
        catch (AuthorityCommittedException)
        {
            lock (stateGate)
            {
                if (!canonicalLayout)
                    known.Add(name);
                if (initialMetadata is { Count: > 0 })
                    metadata[name] = initialMetadata.DeepClone();
            }
            throw;
        }
        catch (Exception error)
        {
            if (createdDirectory && !publishedDirectory && !committed)
            {
                try
                {
                    if (preparationName is null)
                        Directory.Delete(prepared, recursive: true);
                    else
                    {
                        _ = IdentityCleanupDirectories(name, preparationName);
                        Directory.Delete(prepared, recursive: true);
                    }
                }
                catch (Exception cleanup)
                {
                    error = new AggregateException(error, cleanup);
                }
            }
            if (committed)
            {
                if (initialMetadata is { Count: > 0 })
                    metadata[name] = initialMetadata.DeepClone();
                throw new AuthorityCommittedException(
                    "Agent metadata committed, but directory publication did not complete. "
                        + $"Prepared files remain at '{prepared}'.",
                    error
                );
            }
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
            throw;
        }
        finally
        {
            Monitor.Exit(stateGate);
            createGate.Release();
            publication?.Invoke(publishedDirectory);
        }
    }

    internal static void ValidatePreparationName(string name)
    {
        if (
            !name.StartsWith(".create-", StringComparison.Ordinal)
            || !Guid.TryParseExact(name[8..], "N", out _)
        )
            throw new InvalidDataException("Invalid owned Agent preparation name.");
    }

    internal string PreparationPath(string name)
    {
        ValidatePreparationName(name);
        return Path.Combine(agentRoot, name);
    }

    private void AtomicIndexWrite(string path, string text)
    {
        try
        {
            new LinuxAtomicJsonFile(
                Path.GetDirectoryName(path)!,
                Path.GetFileName(path),
                metadataWriteStage
            ).WriteTextPayload(text, default);
        }
        catch (AuthorityCommittedException error)
        {
            throw new AuthorityCommittedException(
                "Agent catalog committed before a later durability step failed.",
                error
            );
        }
    }

    [GeneratedRegex("^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex AgentName();
}
