using System.Text;

namespace Foxwarm.Sessions;

/// <summary>
/// The Agent catalog over an Agent store (hosted mode). It replaces the directory lifecycle:
/// the store's root rows are the members (an Agent exists exactly when its root does, as a
/// directory decides it in file mode), creating an Agent writes its metadata and then creates
/// the root with its memory directory and initial files in one step, deleting removes the root
/// with every file, and the identity-move memory copy is a row copy. There are no preparation
/// directories, no symbolic links to preserve and no framework-copy migration. An identity
/// owned creation keeps its proof as the Agent's <see cref="IdentityProofFileName"/> file, so
/// recovery tells an Agent it created from one it didn't exactly as in file mode.
/// </summary>
internal sealed partial class AgentCatalog
{
    /// <summary>The Agent store, when the Agents' files are in one; null for Agent folders.</summary>
    internal IAgentStore? Store => store;

    /// <summary>Whether Agents have physical folders (false over an Agent store).</summary>
    internal bool PhysicalFolders => store is null;

    private static KeyValuePair<string, byte[]>[] StoreInitialFiles(
        string? initialMemory,
        string? initialSoul,
        string? preparationName
    )
    {
        var files = new List<KeyValuePair<string, byte[]>>();
        if (preparationName is not null)
            files.Add(new(IdentityProofFileName, Encoding.UTF8.GetBytes(preparationName)));
        if (initialMemory is not null)
            files.Add(new("memory/MEMORY.md", Encoding.UTF8.GetBytes(initialMemory)));
        if (initialSoul is not null)
            files.Add(new("memory/SOUL.md", Encoding.UTF8.GetBytes(initialSoul)));
        return files.ToArray();
    }

    // Whether the Agent's own directory exists: its folder, or its store root.
    internal bool DirectoryExists(string name) =>
        store is not null ? store.AgentExists(name) : Directory.Exists(SourceDirectory(name));

    // Whether an Agent of this name can't be created because something holds its place: a
    // directory or file at its folder path, or its store root.
    internal bool DirectoryReserved(string name)
    {
        if (store is not null)
            return store.AgentExists(name);
        var directory = SourceDirectory(name);
        return Directory.Exists(directory) || File.Exists(directory);
    }

    // Where an Agent's files are, for operator diagnostics: the folder, or the store locator.
    internal string FolderLocation(string name) =>
        store is not null ? store.Locator(name, "") : SourceDirectory(name);

    // The roots `${agent.dir}` and `${agent.memoryDir}` of tool rules stand for: the Agent's
    // folder and its memory directory, or over a store the store paths `<agent>` and
    // `<agent>/memory`, which store path facts (AgentStorePaths.Endpoint) are compared with.
    internal string AuthorizationAgentRoot(string name) =>
        store is not null ? StoreRoot(name) : AgentDirectory(name);

    internal string AuthorizationMemoryRoot(string name) =>
        store is not null ? StoreRoot(name) + "/memory" : MemoryDirectory(name);

    private string StoreRoot(string name)
    {
        if (!Exists(name))
            throw new InvalidDataException($"Agent '{name}' does not exist.");
        return name;
    }

    private string[] StoreIdentityCleanup(IAgentStore store, string name, string? preparationName)
    {
        if (!store.AgentExists(name))
            return [];
        var root = store.Locator(name, "");
        if (preparationName is null)
            return [root];
        return StoreProofMatches(store, name, preparationName)
            ? [root]
            : throw new AgentIdentityCleanupException([root]);
    }

    private static bool StoreProofMatches(IAgentStore store, string name, string proof)
    {
        try
        {
            var content = store.ReadAsync(name, IdentityProofFileName, CancellationToken.None)
                .GetAwaiter()
                .GetResult();
            return content.Bytes.AsSpan().SequenceEqual(Encoding.UTF8.GetBytes(proof));
        }
        catch (Exception error) when (error is IOException)
        {
            return false;
        }
    }

    private async Task CompleteStoreIdentityOwnedAsync(IAgentStore store, string name, string preparationName)
    {
        var root = store.Locator(name, "");
        if (!store.AgentExists(name))
            throw new AgentIdentityCleanupException([root]);
        var marker = store.Stat(name, IdentityProofFileName);
        if (marker is null)
            return; // Alias commit makes proof removal idempotent.
        if (marker.IsDirectory || !StoreProofMatches(store, name, preparationName))
            throw new AgentIdentityCleanupException([store.Locator(name, IdentityProofFileName)]);
        await store.DeleteAsync(name, IdentityProofFileName, false, marker.Generation, CancellationToken.None);
    }

    /// <summary>
    /// Copies one Agent's memory into another's, replacing files of the same name: the
    /// one-time inherited memory of a new Agent. Without memory, nothing is copied.
    /// </summary>
    internal async Task CopyIdentityMemoryAsync(string sourceAgent, string targetAgent)
    {
        if (store is null)
        {
            CopyIdentityMemory(sourceAgent, targetAgent);
            return;
        }
        if (store.Stat(sourceAgent, "memory") is not { IsDirectory: true })
            return;
        await store.CopyTreeAsync(sourceAgent, "memory", targetAgent, "memory", CancellationToken.None);
    }

    // The main Agent over a store: its root and memory, with the template memory when the
    // memory directory is empty. The framework-copy migration has no store counterpart.
    private async Task BootstrapStoreMainMemoryAsync(IAgentStore store, string packageDirectory)
    {
        var templates = Path.Combine(packageDirectory, "templates", "main", "memory");
        var files = Directory
            .EnumerateFiles(templates)
            .Order(StringComparer.Ordinal)
            .Select(template => new KeyValuePair<string, byte[]>(
                "memory/" + Path.GetFileName(template),
                File.ReadAllBytes(template)
            ))
            .ToArray();
        if (!store.AgentExists("main"))
        {
            try
            {
                await store.CreateAgentAsync("main", ["memory"], files, CancellationToken.None);
                return;
            }
            catch (AgentFileConflictException) when (store.AgentExists("main")) { }
        }
        if (store.Stat("main", "memory") is { IsDirectory: true } && store.List("main", "memory").Count > 0)
            return;
        foreach (var (path, content) in files)
            try
            {
                await store.WriteAsync("main", path, content, 0, CancellationToken.None);
            }
            catch (AgentFileConflictException) { }
    }
}
