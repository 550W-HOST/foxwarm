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
        var rows = Owners().Select(owner => owner.Metadata()).ToArray();
        return Agents().Select(name =>
        {
            var manifest = AgentManifest(name); var owned = rows.Where(row => row.Agent == name).ToArray();
            return (object)new
            {
                id = name,
                inherit = AgentInherit(name),
                inheritanceChain = AgentChain(name),
                isolated = false,
                isolatedNode = (string?)null,
                sessionCount = owned.Length,
                activeSessionCount = owned.Count(row => row.Busy),
                queuedSessionCount = owned.Count(row => row.QueueLength > 0),
                memoryRoot = manifest.MemoryRoot,
                memoryFileCount = manifest.Files.Count,
                memoryLastModified = manifest.Files.Count == 0 ? (double?)null : manifest.Files.Max(file => file.ModifiedAt)
            };
        }).ToArray();
    }
}
