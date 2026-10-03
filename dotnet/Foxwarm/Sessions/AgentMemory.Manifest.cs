using System.Text.Json.Nodes;
namespace Foxwarm.Sessions;

internal sealed record AgentMemoryFile(string Path, string AbsolutePath, long Size, double ModifiedAt);
internal sealed record AgentMemoryManifest(string MemoryRoot, IReadOnlyList<AgentMemoryFile> Files);

internal sealed partial class AgentMemory
{
    internal AgentMemoryManifest Manifest(string agent)
    {
        var root = agents.MemoryDirectory(agent); var files = new List<AgentMemoryFile>();
        void Walk(string directory, int depth)
        {
            if (depth > 12 || files.Count >= 2000 || !Directory.Exists(directory)) return;
            foreach (var entry in new DirectoryInfo(directory).GetFileSystemInfos().OrderBy(item => item.Name, StringComparer.CurrentCulture))
            {
                if (files.Count >= 2000) break;
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                if (entry is DirectoryInfo) Walk(entry.FullName, depth + 1);
                else if (entry is FileInfo file && file.Name.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                    files.Add(new(Path.GetRelativePath(root, file.FullName).Replace(Path.DirectorySeparatorChar, '/'), file.FullName,
                        file.Length, (file.LastWriteTimeUtc.Ticks - DateTime.UnixEpoch.Ticks) / 10000.0));
            }
        }
        Walk(root, 0);
        var priorities = new Dictionary<string, int>(StringComparer.Ordinal) { ["00_SYSTEM.md"] = 0, ["MEMORY.md"] = 1, ["SOUL.md"] = 2, ["USER.md"] = 3 };
        return new(root, files.OrderBy(file => file.Path.StartsWith("archive/", StringComparison.Ordinal) ? 1 : 0)
            .ThenBy(file => file.Path.Count(character => character == '/'))
            .ThenBy(file => priorities.GetValueOrDefault(file.Path, 100)).ThenBy(file => file.Path, StringComparer.CurrentCulture).ToArray());
    }
}

internal sealed partial class SessionManager
{
    internal AgentMemoryManifest AgentManifest(string name) => memory.Manifest(name);
    internal object[] AgentRegistry()
    {
        var counts = Catalog.AgentActivityCounts(); var local = LocalProjections(); var persisted = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in local.Select(row => SessionCatalog.Text(row["id"])!).Chunk(200)) foreach (var row in Catalog.GetMany(chunk)) persisted[SessionCatalog.Text(row["id"])!] = row;
        foreach (var row in local)
        {
            var current = Metadata(row); var previous = persisted.GetValueOrDefault(current.Id) is { } old ? Metadata(old) : null;
            var count = counts.GetValueOrDefault(current.Agent);
            counts[current.Agent] = (count.Total + (previous is null ? 1 : 0), count.Active + (current.Busy ? 1 : 0) - (previous?.Busy == true ? 1 : 0), count.Queued + (current.QueueLength > 0 ? 1 : 0) - (previous?.QueueLength > 0 ? 1 : 0));
        }
        return Agents().Select(name =>
        {
            var manifest = AgentManifest(name); var owned = counts.GetValueOrDefault(name);
            return (object)new
            {
                id = name,
                inherit = AgentInherit(name),
                inheritanceChain = AgentChain(name),
                isolated = AgentIsolated(name),
                isolatedNode = RecordedIsolationNode(name),
                sessionCount = owned.Total,
                activeSessionCount = owned.Active,
                queuedSessionCount = owned.Queued,
                memoryRoot = manifest.MemoryRoot,
                memoryFileCount = manifest.Files.Count,
                memoryLastModified = manifest.Files.Count == 0 ? (double?)null : manifest.Files.Max(file => file.ModifiedAt)
            };
        }).ToArray();
    }
}
