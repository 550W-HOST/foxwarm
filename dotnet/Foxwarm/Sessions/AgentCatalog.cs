using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

/// <summary>
/// One-host Agent directories and metadata, with a bounded retained-layout reader. With an
/// Agent store (hosted mode) the Agents' files and membership are the store's instead of
/// directories: see <c>AgentCatalog.Store.cs</c>.
/// </summary>
internal sealed partial class AgentCatalog
{
    private readonly string workspaceRoot;
    private readonly string agentRoot;
    private readonly Foxwarm.Storage.IStateDocument index;
    private readonly Foxwarm.Storage.IStateDocument installation;
    private readonly bool canonicalLayout;
    private readonly SemaphoreSlim createGate = new(1, 1);
    private readonly object stateGate = new();
    private readonly Func<(int MaxDepth, int MaxChildren)> treeLimits;
    private readonly Func<string?> installDefaultNode;
    private readonly Action<AtomicJsonWriteStage>? metadataWriteStage;
    private JsonObject metadata = new();
    private readonly HashSet<string> known = new(StringComparer.Ordinal) { "main" };
    private readonly IAgentStore? store;

    public AgentCatalog(
        string dataRoot,
        string workspaceRoot,
        string? recoveringOwnedAgent = null,
        bool canonicalLayout = false,
        bool createDirectories = true,
        Func<(int MaxDepth, int MaxChildren)>? treeLimits = null,
        Action<AtomicJsonWriteStage>? metadataWriteStage = null,
        Func<string?>? installDefaultNode = null,
        Foxwarm.Storage.IStateDocuments? documents = null,
        IAgentStore? store = null
    )
    {
        if (store is not null && !canonicalLayout)
            throw new ArgumentException("An Agent store holds the canonical layout only.", nameof(store));
        this.store = store;
        this.treeLimits = treeLimits ?? (() => (16, 128));
        this.installDefaultNode = installDefaultNode ?? (() => null);
        this.metadataWriteStage = metadataWriteStage;
        this.workspaceRoot = Path.GetFullPath(workspaceRoot);
        this.canonicalLayout = canonicalLayout;
        agentRoot = canonicalLayout
            ? this.workspaceRoot
            : Path.Combine(this.workspaceRoot, "agents");
        documents ??= new Foxwarm.Storage.FileStateDocuments(dataRoot);
        index = documents.Open(
            Foxwarm.Storage.StateDocumentName.Agents,
            new(stage => this.metadataWriteStage?.Invoke(stage))
        );
        installation = documents.Open(Foxwarm.Storage.StateDocumentName.Installation);
        if (this.index.ReadText() is { } indexText)
        {
            var index =
                JsonNode.Parse(indexText) as JsonObject
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
        if (createDirectories && store is null)
            Directory.CreateDirectory(agentRoot);
        if (
            store is null
            && Directory.Exists(agentRoot)
            && (File.GetAttributes(agentRoot) & FileAttributes.ReparsePoint) != 0
        )
            throw new InvalidDataException("Agent directory root cannot be a symbolic link.");
        RequireReaderVersion();
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
            store is null
            && recoveringOwnedAgent is not null
            && Directory.Exists(Path.Combine(agentRoot, recoveringOwnedAgent))
            && (
                File.GetAttributes(Path.Combine(agentRoot, recoveringOwnedAgent))
                & FileAttributes.ReparsePoint
            ) != 0
        )
            throw new InvalidDataException("Owned identity destination cannot be a symbolic link.");
    }

    private IEnumerable<string> DirectoryMembers() =>
        store is not null
            ? store.Agents().Where(name => AgentName().IsMatch(name))
            : Directory
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

    /// <summary>The longest name a new Agent may have; existing longer names stay readable.</summary>
    internal const int MaxNewNameLength = 128;

    internal static void ValidateNewName(string name)
    {
        if (name.Length > MaxNewNameLength)
            throw new InvalidDataException($"Agent names can be at most {MaxNewNameLength} characters.");
    }

    public bool Exists(string name)
    {
        lock (stateGate)
        {
            if (known.Contains(name))
                return true;
            if (!canonicalLayout || !AgentName().IsMatch(name))
                return false;
            if (store is not null)
                return store.AgentExists(name);
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
        // Agent store Agents have no folder for master exec logs.
        if (store is not null)
            yield break;
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
        RequireMember(name);
        return SourceDirectory(name);
    }

    /// <summary>Refuses a name that isn't an Agent now, in either layout.</summary>
    internal void RequireMember(string name)
    {
        if (!Exists(name))
            throw new InvalidDataException($"Agent '{name}' does not exist.");
    }

    public string MemoryDirectory(string name) => Path.Combine(AgentDirectory(name), "memory");

    /// <summary>The directory holding the Agent folders and the installation prompt files.</summary>
    internal string AgentRoot => agentRoot;

    public string FrameworkSystemPath => Path.Combine(agentRoot, FrameworkPrompt.FileName);
    public string FrameworkLocalPath => Path.Combine(agentRoot, FrameworkPrompt.LocalFileName);
    public string MainFallbackSystemPath =>
        Path.Combine(SourceDirectory("main"), "memory", FrameworkPrompt.FileName);

    public async Task CreateAsync(
        string name,
        string? initialMemory = null,
        string? inherit = null,
        string? initialSoul = null,
        string? createdBy = null,
        JsonArray? rules = null,
        string? defaultNode = null,
        string? defaultCwd = null,
        string? preparationName = null,
        bool restoreRetained = false,
        Action<bool>? publication = null,
        bool unlimitedChildren = false
    )
    {
        ValidateName(name);
        if (!restoreRetained)
            ValidateNewName(name);
        if (name == "main" && (!restoreRetained || !canonicalLayout))
            throw new InvalidDataException("The main Agent already exists.");
        var directory = store is null ? SourceDirectory(name) : store.Locator(name, "");
        var prepared = store is null
            ? PreparationPath(preparationName ?? ".create-" + Guid.NewGuid().ToString("N"))
            : directory;
        if (store is not null && preparationName is not null)
            ValidatePreparationName(preparationName);
        await createGate.WaitAsync();
        var createdDirectory = false;
        var publishedDirectory = false;
        var committed = false;
        JsonObject? initialMetadata = null;
        // The state gate is held from the existence check through the metadata commit, so no
        // other metadata change interleaves, and in the file layout through the directory's
        // publication. The store creates the Agent's files after the gate is released: a
        // monitor can't be held across that await, and until the root exists the Agent isn't
        // a member, as before a directory's publication.
        var holdState = true;
        Monitor.Enter(stateGate);
        try
        {
            if (
                (!restoreRetained && Exists(name))
                || store is null && (Directory.Exists(directory) || File.Exists(directory))
                || store is not null && store.AgentExists(name)
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
                    || defaultCwd is not null
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
            ValidateCreatorAdmission(createdBy, MetadataSnapshot(), unlimitedChildren);
            _ = Foxwarm.Tools.AgentRulePolicy.Parse(rules ?? new JsonArray());
            RequireStoreRoots(name, rules);
            ValidateDefaultNode(defaultNode ?? DefaultNode(name));
            ValidateDefaultCwd(defaultCwd ?? DefaultCwd(name));
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
            if (defaultCwd is not null)
                initialMetadata["defaultCwd"] = defaultCwd;
            if (inherit is not null)
                initialMetadata["inherit"] = inherit;
            // Dot-prefixed preparation is not Agent membership. Persist authority before
            // publishing the final directory so restart cannot discover an unrestricted child.
            if (store is null)
            {
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
            }
            var next = List()
                .Where(existing => existing != "main")
                .Append(name)
                .Order(StringComparer.Ordinal)
                .ToArray();
            var nextMetadata = MetadataSnapshot();
            if (initialMetadata.Count > 0)
                nextMetadata[name] = initialMetadata.DeepClone();
            // A creation the store would refuse now (its limits) is refused before anything
            // about it is committed, so it leaves no authority record behind.
            store?.AdmitCreation(name, ["memory"], StoreInitialFiles(initialMemory, initialSoul, preparationName));
            var payload = Payload(next, nextMetadata);
            AuthorityCommittedException? durabilityFailure = null;
            try
            {
                AtomicIndexWrite(payload.ToJsonText());
            }
            catch (AuthorityCommittedException error)
            {
                durabilityFailure = error;
            }
            committed = true;
            if (store is null)
                Directory.Move(prepared, directory);
            else
            {
                // Readers see the committed metadata (creator, rules, defaults) before the
                // root makes the Agent a member; until then it isn't one.
                if (initialMetadata is { Count: > 0 })
                    metadata[name] = initialMetadata.DeepClone();
                Monitor.Exit(stateGate);
                holdState = false;
                BeforeStoreCreation?.Invoke(name);
                // The root, the memory directory, the initial memory and the identity proof
                // appear together, after the metadata, as the published directory does.
                try
                {
                    await store.CreateAgentAsync(
                        name,
                        ["memory"],
                        StoreInitialFiles(initialMemory, initialSoul, preparationName),
                        CancellationToken.None,
                        restoration: restoreRetained
                    );
                }
                catch (Exception refusal) when (refusal is AgentStoreQuotaException or AgentFilePathTooLongException)
                {
                    // A known refusal (the limits moved since admission): nothing of the Agent
                    // exists, so its metadata record goes again while creation is serialized,
                    // and the name stays free.
                    RetireCreationRecord(name, previous);
                    committed = false;
                    throw;
                }
            }
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
                    lock (stateGate)
                        metadata[name] = initialMetadata.DeepClone();
                throw new AuthorityCommittedException(
                    store is not null
                        ? "Agent metadata committed, but the Agent's files were not created."
                        : "Agent metadata committed, but directory publication did not complete. "
                            + $"Prepared files remain at '{prepared}'.",
                    error
                );
            }
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error).Throw();
            throw;
        }
        finally
        {
            if (holdState)
                Monitor.Exit(stateGate);
            createGate.Release();
            publication?.Invoke(publishedDirectory);
        }
    }

    // Restores the metadata of a name as it was before a creation that published none of its
    // files: the earlier retained record, or none.
    private void RetireCreationRecord(string name, JsonObject? previous)
    {
        lock (stateGate)
        {
            var next = MetadataSnapshot();
            if (previous is null)
                next.Remove(name);
            else
                next[name] = previous.DeepClone();
            try
            {
                AtomicIndexWrite(Payload(List().Where(id => id != "main" && id != name), next).ToJsonText());
            }
            catch (AuthorityCommittedException)
            {
                // Published, only not yet durable: the refusal stands, and the next durable
                // write carries the retirement.
            }
            metadata = next;
        }
    }

    // Test seam: runs between the metadata's publication and the store creation of an Agent.
    internal Action<string>? BeforeStoreCreation { get; set; }

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

    private void AtomicIndexWrite(string text)
    {
        var written = JsonNode.Parse(text) as JsonObject;
        EnsureReaderVersion(
            (canonicalLayout ? written : written?["metadata"] as JsonObject) ?? new JsonObject()
        );
        try
        {
            index.ReplaceText(text);
        }
        catch (AuthorityCommittedException error)
        {
            throw new AuthorityCommittedException(
                "Agent catalog committed before a later durability step failed.",
                error
            );
        }
    }

    [GeneratedRegex(@"^[a-zA-Z0-9_-]+\z", RegexOptions.CultureInvariant)]
    private static partial Regex AgentName();
}
