using System.Collections;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using YamlDotNet.Serialization;

namespace Foxwarm;

internal sealed record SkillInfo(string Name, string? Description, string Directory, string MetadataPath,
    string SourceType, string? SourceAgent, string[] Resources, bool ResourcesTruncated)
{
    internal string SourceLabel => SourceType == "global" ? "global" : SourceType == "agent-local" ? $"agent:{SourceAgent}" : $"inherited:{SourceAgent}";
}

// Knowledge discovery only: entry documents are loaded on demand, never executable tool registration.
internal sealed partial class Skills(AgentCatalog agents, string globalRoot)
{
    private static readonly HashSet<string> Skip = new(StringComparer.Ordinal) { ".git", "build", "dist", "memory", "node_modules", "__pycache__" };
    internal static void ValidateName(string name)
    {
        if (string.IsNullOrEmpty(name) || name.Split('/').Any(segment => !Segment().IsMatch(segment)))
            throw new InvalidDataException("Invalid skill name. Use only alphanumeric characters, hyphens, underscores, and forward slashes for nested skills.");
    }
    private IEnumerable<(string Directory, string Type, string? Agent)> Roots(string agent)
    {
        foreach (var name in agents.InheritanceChain(agent).Reverse())
            yield return (Path.Combine(agents.SourceDirectory(name), "skills"), name == agent ? "agent-local" : "agent-inherited", name);
        yield return (globalRoot, "global", null);
    }
    internal async Task<IReadOnlyList<SkillInfo>> ListAsync(string agent)
    {
        var result = new Dictionary<string, SkillInfo>(StringComparer.Ordinal);
        foreach (var root in Roots(agent))
            foreach (var name in Discover(root.Directory).Order(StringComparer.CurrentCulture))
            {
                if (result.ContainsKey(name)) continue;
                try { result[name] = await BuildAsync(name, root, false); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or YamlDotNet.Core.YamlException)
                { Console.Error.WriteLine($"Skipping invalid skill '{name}' from {root.Type}: {error.Message}"); }
            }
        return result.Values.OrderBy(info => info.Name, StringComparer.CurrentCulture).ToArray();
    }
    internal async Task<(SkillInfo Info, string Content)> LoadAsync(string name, string agent)
    {
        ValidateName(name);
        Exception? last = null;
        foreach (var root in Roots(agent))
        {
            if (!Directory.Exists(Path.Combine(root.Directory, name))) continue;
            try
            {
                var info = await BuildAsync(name, root, true);
                return (info, await File.ReadAllTextAsync(info.MetadataPath));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or YamlDotNet.Core.YamlException)
            { last = error; Console.Error.WriteLine($"Skipping invalid skill '{name}' from {root.Type}: {error.Message}"); }
        }
        throw last ?? new InvalidDataException($"Skill '{name}' not found. Searched agent-local, inherited-agent, and global skill directories for Agent '{agent}'.");
    }
    private static IEnumerable<string> Discover(string root, string relative = "")
    {
        if (!Directory.Exists(root)) yield break;
        foreach (var dir in Directory.EnumerateDirectories(root))
        {
            if (Skip.Contains(Path.GetFileName(dir)) || (File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) continue;
            var name = relative.Length == 0 ? Path.GetFileName(dir) : relative + "/" + Path.GetFileName(dir);
            if (File.Exists(Path.Combine(dir, "SKILL.md"))) yield return name;
            else foreach (var nested in Discover(dir, name)) yield return nested;
        }
    }
    private static async Task<SkillInfo> BuildAsync(string name, (string Directory, string Type, string? Agent) root, bool resources)
    {
        var segments = name.Split('/'); var parent = root.Directory;
        for (var index = 0; index + 1 < segments.Length; index++)
        {
            parent = Path.Combine(parent, segments[index]);
            if (File.Exists(Path.Combine(parent, "SKILL.md")))
                throw new InvalidDataException($"Skill '{name}' is inside skill '{string.Join('/', segments.Take(index + 1))}' and is treated as a bundled resource, not an independently loadable skill. Load the parent skill first, then read the referenced resource if needed.");
        }
        var dir = Path.Combine(root.Directory, name); var entry = Path.Combine(dir, "SKILL.md");
        if (!File.Exists(entry)) throw new InvalidDataException($"Skill '{name}' not found. Expected: {entry}.");
        var description = Description(await File.ReadAllTextAsync(entry));
        var (files, truncated) = resources ? Resources(dir) : (Array.Empty<string>(), false);
        return new SkillInfo(name, description, dir, entry, root.Type, root.Agent, files, truncated);
    }
    private static (string[] Files, bool Truncated) Resources(string root)
    {
        var files = new List<string>(); var truncated = false;
        void Walk(string current)
        {
            if (truncated) return;
            FileSystemInfo[] entries;
            try { entries = new DirectoryInfo(current).GetFileSystemInfos(); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            { Console.Error.WriteLine($"Failed to list skill resources: {error.Message}"); return; }
            foreach (var item in entries.OrderBy(info => info is DirectoryInfo ? 0 : 1).ThenBy(info => info.Name, StringComparer.CurrentCulture))
            {
                if ((item.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                if (item is DirectoryInfo)
                {
                    if (!Skip.Contains(item.Name)) Walk(item.FullName);
                    if (truncated) return;
                }
                else
                {
                    var relative = Path.GetRelativePath(root, item.FullName).Replace(Path.DirectorySeparatorChar, '/');
                    if (relative == "SKILL.md") continue;
                    if (files.Count >= 200) { truncated = true; return; }
                    files.Add(relative);
                }
            }
        }
        Walk(root); return (files.ToArray(), truncated);
    }
    private static string? Description(string content)
    {
        var match = FrontMatter().Match(content);
        if (match.Success)
        {
            var data = new DeserializerBuilder().Build().Deserialize<object>(match.Groups[1].Value);
            if (data is IDictionary map && map["description"] is string description && description.Length > 0) return description;
            content = content[match.Length..];
        }
        var paragraph = new List<string>(); var fenced = false;
        foreach (var raw in content.Split('\n').Take(40))
        {
            var line = raw.Trim();
            if (line.StartsWith("```", StringComparison.Ordinal)) { fenced = !fenced; if (paragraph.Count > 0) break; continue; }
            if (fenced) continue;
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith('>') || Regex.IsMatch(line, "^(?:[-*+]\\s|\\d+\\.\\s)"))
            { if (paragraph.Count > 0) break; continue; }
            if (line.StartsWith("<!--", StringComparison.Ordinal)) continue;
            paragraph.Add(line);
        }
        return paragraph.Count == 0 ? null : string.Join(' ', paragraph);
    }
    [GeneratedRegex("^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)] private static partial Regex Segment();
    [GeneratedRegex("^---\\s*\\n([\\s\\S]*?)\\n---\\s*(?:\\n|$)", RegexOptions.CultureInvariant)] private static partial Regex FrontMatter();
}
