using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

/// <summary>One-host Agent directory and metadata owner. main keeps the pre-Agent workspace root.</summary>
internal sealed partial class AgentCatalog
{
    private readonly string workspaceRoot;
    private readonly string agentRoot;
    private readonly string indexPath;
    private readonly SemaphoreSlim createGate = new(1, 1);
    private readonly object stateGate = new();
    private JsonObject metadata = new();
    private readonly HashSet<string> known = new(StringComparer.Ordinal) { "main" };

    public AgentCatalog(string dataRoot, string workspaceRoot)
    {
        this.workspaceRoot = Path.GetFullPath(workspaceRoot);
        agentRoot = Path.Combine(this.workspaceRoot, "agents");
        indexPath = Path.Combine(Path.GetFullPath(dataRoot), "state", "agents.json");
        Directory.CreateDirectory(agentRoot);
        if ((File.GetAttributes(agentRoot) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Agent directory root cannot be a symbolic link.");
        if (File.Exists(indexPath))
        {
            var index = JsonNode.Parse(File.ReadAllText(indexPath)) as JsonObject
                ?? throw new InvalidDataException("Agent catalog must be an object.");
            var version = index["version"]?.GetValue<int>();
            if (version is not (1 or 2) || index.Count != (version == 1 ? 2 : 3) || index["agents"] is not JsonArray list
                || version == 2 && index["metadata"] is not JsonObject)
                throw new InvalidDataException("Unsupported Agent catalog format.");
            if (version == 2) metadata = (JsonObject)index["metadata"]!.DeepClone();
            foreach (var item in list)
            {
                var name = item?.GetValue<string>() ?? throw new InvalidDataException("Invalid Agent catalog entry.");
                ValidateName(name);
                if (name == "main" || !known.Add(name)) throw new InvalidDataException("Duplicate Agent catalog entry.");
            }
        }
        foreach (var name in known.Where(name => name != "main"))
        {
            var directory = Path.Combine(agentRoot, name);
            if (!Directory.Exists(directory) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0
                || !Directory.Exists(Path.Combine(directory, "memory")))
                throw new InvalidDataException($"Agent '{name}' directory or memory folder is missing or invalid.");
        }
        // A crash before catalog rename may leave a new directory. Do not silently adopt
        // or delete it: operator inspection is safer than merging Agent lifetimes.
        foreach (var directory in Directory.EnumerateDirectories(agentRoot))
            if (!known.Contains(Path.GetFileName(directory)))
                throw new InvalidDataException("Unindexed Agent directory; creation may have been interrupted.");
    }

    public static void ValidateName(string name)
    {
        if (!AgentName().IsMatch(name)) throw new InvalidDataException("Agent name must use only letters, numbers, hyphens and underscores.");
    }

    public bool Exists(string name) { lock (stateGate) return known.Contains(name); }
    public string[] List() { lock (stateGate) return known.Order(StringComparer.Ordinal).ToArray(); }
    public string AgentDirectory(string name)
    {
        if (!Exists(name)) throw new InvalidDataException($"Agent '{name}' does not exist.");
        return name == "main" ? workspaceRoot : Path.Combine(agentRoot, name);
    }
    public string MemoryDirectory(string name) => Path.Combine(AgentDirectory(name), "memory");
    public string FrameworkSystemPath => Path.Combine(agentRoot, "00_SYSTEM.md");
    public string MainFallbackSystemPath => Path.Combine(workspaceRoot, "memory", "00_SYSTEM.md");

    public async Task CreateAsync(string name, string? initialMemory = null, string? inherit = null)
    {
        ValidateName(name);
        if (name == "main") throw new InvalidDataException("The main Agent already exists.");
        await createGate.WaitAsync();
        var directory = Path.Combine(agentRoot, name);
        var createdDirectory = false;
        var committed = false;
        try
        {
            if (Exists(name) || Directory.Exists(directory) || File.Exists(directory))
                throw new InvalidDataException($"Agent '{name}' already exists or its directory is reserved.");
            ValidateInheritance(name, inherit);
            Directory.CreateDirectory(directory);
            createdDirectory = true;
            Directory.CreateDirectory(Path.Combine(directory, "memory"));
            if (initialMemory is not null)
                await File.WriteAllTextAsync(Path.Combine(directory, "memory", "MEMORY.md"), initialMemory);
            var next = List().Where(existing => existing != "main").Append(name).Order(StringComparer.Ordinal).ToArray();
            var nextMetadata = MetadataSnapshot();
            if (inherit is not null) nextMetadata[name] = new JsonObject { ["inherit"] = inherit };
            var payload = Payload(next, nextMetadata);
            AtomicIndexWrite(indexPath, payload.ToJsonString());
            committed = true;
            lock (stateGate) { known.Add(name); if (inherit is not null) metadata[name] = new JsonObject { ["inherit"] = inherit }; }
        }
        catch
        {
            if (createdDirectory && !committed)
            {
                // If an authority rename happened but its directory sync failed, the
                // index now owns the directory; removing it would orphan that catalog.
                if (File.Exists(indexPath))
                {
                    try
                    {
                        var root = JsonNode.Parse(File.ReadAllText(indexPath)) as JsonObject;
                        if (root?["agents"] is JsonArray names && names.Any(item => item?.GetValue<string>() == name))
                            committed = true;
                    }
                    catch (System.Text.Json.JsonException) { /* Preserve the directory if authority is ambiguous. */ committed = true; }
                }
                if (!committed) Directory.Delete(directory, recursive: true);
            }
            if (committed) lock (stateGate) { known.Add(name); if (inherit is not null) metadata[name] = new JsonObject { ["inherit"] = inherit }; }
            throw;
        }
        finally { createGate.Release(); }
    }

    private static void AtomicIndexWrite(string path, string text)
    {
        var parent = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(parent);
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        var renamed = false;
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
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
            if (!renamed) { try { File.Delete(temporary); } catch { } throw; }
            throw new AuthorityCommittedException("Agent catalog committed before a later durability step failed.", error);
        }
    }

    [GeneratedRegex("^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex AgentName();
}
