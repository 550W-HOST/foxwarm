using System.Text;
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
    private JsonObject metadata = new();
    private readonly HashSet<string> known = new(StringComparer.Ordinal) { "main" };

    public AgentCatalog(
        string dataRoot,
        string workspaceRoot,
        string? recoveringOwnedAgent = null,
        bool canonicalLayout = false
    )
    {
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
                        "Retained C# Agent data requires its original workspace. Supply the existing FOXWARM_EXPERIMENT_TOOL_ROOT override; no files were relocated."
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
        Directory.CreateDirectory(agentRoot);
        if ((File.GetAttributes(agentRoot) & FileAttributes.ReparsePoint) != 0)
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
        string? initialSoul = null
    )
    {
        ValidateName(name);
        if (name == "main")
            throw new InvalidDataException("The main Agent already exists.");
        await createGate.WaitAsync();
        var directory = Path.Combine(agentRoot, name);
        var createdDirectory = false;
        var committed = false;
        try
        {
            if (Exists(name) || Directory.Exists(directory) || File.Exists(directory))
                throw new InvalidDataException(
                    $"Agent '{name}' already exists or its directory is reserved."
                );
            ValidateInheritance(name, inherit);
            Directory.CreateDirectory(directory);
            createdDirectory = true;
            Directory.CreateDirectory(Path.Combine(directory, "memory"));
            if (initialMemory is not null)
                await File.WriteAllTextAsync(
                    Path.Combine(directory, "memory", "MEMORY.md"),
                    initialMemory
                );
            if (initialSoul is not null)
                await File.WriteAllTextAsync(
                    Path.Combine(directory, "memory", "SOUL.md"),
                    initialSoul
                );
            var next = List()
                .Where(existing => existing != "main")
                .Append(name)
                .Order(StringComparer.Ordinal)
                .ToArray();
            var nextMetadata = MetadataSnapshot();
            if (inherit is not null)
                nextMetadata[name] = new JsonObject { ["inherit"] = inherit };
            var payload = Payload(next, nextMetadata);
            AtomicIndexWrite(indexPath, payload.ToJsonString());
            committed = true;
            lock (stateGate)
            {
                if (!canonicalLayout)
                    known.Add(name);
                if (inherit is not null)
                    metadata[name] = new JsonObject { ["inherit"] = inherit };
            }
        }
        catch (AuthorityCommittedException)
        {
            lock (stateGate)
            {
                if (!canonicalLayout)
                    known.Add(name);
                if (inherit is not null)
                    metadata[name] = new JsonObject { ["inherit"] = inherit };
            }
            throw;
        }
        catch
        {
            if (createdDirectory && !committed)
                Directory.Delete(directory, recursive: true);
            throw;
        }
        finally
        {
            createGate.Release();
        }
    }

    private static void AtomicIndexWrite(string path, string text)
    {
        var parent = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(parent);
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        var renamed = false;
        try
        {
            using (
                var file = new FileStream(
                    temporary,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                )
            )
            {
                var bytes = new UTF8Encoding(false).GetBytes(text);
                file.Write(bytes);
                file.Flush(true);
            }
            File.Move(temporary, path, overwrite: true);
            renamed = true;
            _ = LinuxAtomicJsonFile.LinuxDirectorySync.Sync(parent);
        }
        catch (Exception error)
        {
            if (!renamed)
            {
                try
                {
                    File.Delete(temporary);
                }
                catch { }
                throw;
            }
            throw new AuthorityCommittedException(
                "Agent catalog committed before a later durability step failed.",
                error
            );
        }
    }

    [GeneratedRegex("^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex AgentName();
}
