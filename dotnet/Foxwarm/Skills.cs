using System.Collections;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record SkillInfo(
    string Name,
    string? Description,
    string Directory,
    string MetadataPath,
    string SourceType,
    string? SourceAgent,
    string[] Resources,
    bool ResourcesTruncated,
    // The validated `run` block of a runnable skill; RunError says why a present block is not.
    SkillRun? Run = null,
    string? RunError = null,
    // Where Directory's files are read: the file system, or an Agent store.
    ISkillFiles? Files = null
)
{
    internal ISkillFiles Source => Files ?? PhysicalSkillFiles.Instance;

    internal string SourceLabel =>
        SourceType == "global" ? "global"
        : SourceType == "agent-local" ? $"agent:{SourceAgent}"
        : $"inherited:{SourceAgent}";
}

// What a skill listing shows of one skill: nothing, the skill, or the skill with its run entry.
// A projection of the caller's rules; load and run are still authorized at dispatch.
internal enum SkillAccess
{
    Hidden,
    Load,
    Run,
}

// Knowledge discovery only: entry documents are loaded on demand, never executable tool registration.
internal sealed partial class Skills(AgentCatalog agents, string globalRoot, bool masterNode = true)
{
    // Global skills about operating a Main server or a service beside it on its own machine
    // (updates, restarts, data layout, the speech service). Without a master Node (RuntimeCapabilities.MasterNode) they are neither listed nor
    // loadable nor runnable: a hosted installation is upgraded by image rollouts outside Foxwarm.
    private static readonly IReadOnlySet<string> MasterNodeSkills = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "foxwarm-maintenance",
        // Runs a speech service beside the Main server and sets the deployment's `asrService`.
        "asr-service",
    };

    /// <summary>
    /// The text of a skill document as this runtime reads it. Bundled (global) Markdown documents
    /// may hold <c>master-node</c> wrappers (<see cref="ConditionalMemory"/>), filtered for
    /// whether this runtime has a master Node; with one, the result is the document without its
    /// wrappers and hosted blocks, the same bytes the document had before it was conditioned.
    /// Agent skills are their Agent's own text and are never filtered.
    /// </summary>
    internal string Text(SkillInfo info, string path, string text) =>
        Conditioned(info, path) ? ConditionalMemory.FilterMasterNodeSource(text, masterNode) : text;

    /// <summary>The bytes of a skill file as this runtime reads it (<see cref="Text"/>).</summary>
    internal byte[] Bytes(SkillInfo info, string path, byte[] bytes)
    {
        if (!Conditioned(info, path))
            return bytes;
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        var filtered = ConditionalMemory.FilterMasterNodeSource(text, masterNode);
        return ReferenceEquals(filtered, text) ? bytes : System.Text.Encoding.UTF8.GetBytes(filtered);
    }

    internal static bool Conditioned(SkillInfo info, string path) =>
        info.SourceType == "global" && path.EndsWith(".md", StringComparison.OrdinalIgnoreCase);

    private bool Unavailable(string name, string rootType) =>
        !masterNode && rootType == "global" && MasterNodeSkills.Contains(name);

    // The Agent whose skills the skill tool reads: agentName, trimmed, else the caller's. The
    // handler and the operation plan (`skill-agent`) both use it.
    internal static string RequestedAgent(string? agentName, string callerAgent) =>
        string.IsNullOrWhiteSpace(agentName) ? callerAgent : agentName.Trim();

    private static readonly IReadOnlySet<string> Skip = new HashSet<string>(StringComparer.Ordinal)
    {
        ".git",
        "build",
        "dist",
        "memory",
        "node_modules",
        "__pycache__",
    };

    internal static void ValidateName(string name)
    {
        if (
            string.IsNullOrEmpty(name)
            || name.Split('/').Any(segment => !Segment().IsMatch(segment))
        )
            throw new InvalidDataException(
                "Invalid skill name. Use only alphanumeric characters, hyphens, underscores, and forward slashes for nested skills."
            );
    }

    // An Agent's skills are in its folder, or in the Agent store under the locators of its
    // files; global skills are always on the file system.
    private IEnumerable<(string Directory, string Type, string? Agent, ISkillFiles Files)> Roots(string agent)
    {
        foreach (var name in agents.InheritanceChain(agent).Reverse())
            yield return agents.Store is { } store
                ? (
                    store.Locator(name, "skills"),
                    name == agent ? "agent-local" : "agent-inherited",
                    name,
                    new StoreSkillFiles(store, name)
                )
                : (
                    Path.Combine(agents.SourceDirectory(name), "skills"),
                    name == agent ? "agent-local" : "agent-inherited",
                    name,
                    PhysicalSkillFiles.Instance
                );
        yield return (globalRoot, "global", null, PhysicalSkillFiles.Instance);
    }

    internal async Task<IReadOnlyList<SkillInfo>> ListAsync(string agent)
    {
        var result = new Dictionary<string, SkillInfo>(StringComparer.Ordinal);
        foreach (var root in Roots(agent))
        foreach (var name in Discover(root.Files, root.Directory).Order(StringComparer.CurrentCulture))
        {
            if (result.ContainsKey(name) || Unavailable(name, root.Type))
                continue;
            try
            {
                result[name] = await BuildAsync(name, root, false);
            }
            catch (Exception error)
                when (error
                        is IOException
                            or UnauthorizedAccessException
                            or InvalidDataException
                            or YamlDotNet.Core.YamlException
                )
            {
                Console.Error.WriteLine(
                    $"Skipping invalid skill '{name}' from {root.Type}: {error.Message}"
                );
            }
        }
        return result.Values.OrderBy(info => info.Name, StringComparer.CurrentCulture).ToArray();
    }

    internal async Task<(SkillInfo Info, string Content)> LoadAsync(string name, string agent) =>
        await FindAsync(
            name,
            agent,
            true,
            async info => (info, Text(info, "SKILL.md", await info.Source.ReadAllTextAsync(info.MetadataPath)))
        );

    // Resolution shared by load and run: Agent-local, inherited, then global; the first valid
    // match wins.
    private async Task<T> FindAsync<T>(
        string name,
        string agent,
        bool resources,
        Func<SkillInfo, Task<T>> read
    )
    {
        ValidateName(name);
        Exception? last = null;
        foreach (var root in Roots(agent))
        {
            if (
                !root.Files.DirectoryExists(Path.Combine(root.Directory, name))
                || Unavailable(name, root.Type)
            )
                continue;
            try
            {
                return await read(await BuildAsync(name, root, resources));
            }
            catch (Exception error)
                when (error
                        is IOException
                            or UnauthorizedAccessException
                            or InvalidDataException
                            or YamlDotNet.Core.YamlException
                )
            {
                last = error;
                Console.Error.WriteLine(
                    $"Skipping invalid skill '{name}' from {root.Type}: {error.Message}"
                );
            }
        }
        throw last
            ?? new InvalidDataException(
                $"Skill '{name}' not found. Searched agent-local, inherited-agent, and global skill directories for Agent '{agent}'."
            );
    }

    private static IEnumerable<string> Discover(ISkillFiles files, string root, string relative = "")
    {
        if (!files.DirectoryExists(root))
            yield break;
        foreach (var entry in files.Entries(root).Where(entry => entry.IsDirectory))
        {
            var dir = entry.FullPath;
            if (Skip.Contains(entry.Name) || entry.IsLink)
                continue;
            var name = relative.Length == 0 ? entry.Name : relative + "/" + entry.Name;
            if (files.FileExists(Path.Combine(dir, "SKILL.md")))
                yield return name;
            else
                foreach (var nested in Discover(files, dir, name))
                    yield return nested;
        }
    }

    private static async Task<SkillInfo> BuildAsync(
        string name,
        (string Directory, string Type, string? Agent, ISkillFiles Files) root,
        bool resources
    )
    {
        var files = root.Files;
        var segments = name.Split('/');
        var parent = root.Directory;
        for (var index = 0; index + 1 < segments.Length; index++)
        {
            parent = Path.Combine(parent, segments[index]);
            if (files.FileExists(Path.Combine(parent, "SKILL.md")))
                throw new InvalidDataException(
                    $"Skill '{name}' is inside skill '{string.Join('/', segments.Take(index + 1))}' and is treated as a bundled resource, not an independently loadable skill. Load the parent skill first, then read the referenced resource if needed."
                );
        }
        var dir = Path.Combine(root.Directory, name);
        var entry = Path.Combine(dir, "SKILL.md");
        if (!files.FileExists(entry))
            throw new InvalidDataException($"Skill '{name}' not found. Expected: {entry}.");
        var content = await files.ReadAllTextAsync(entry);
        var description = Description(content);
        var (run, runError) = Run(content, dir, files);
        var (listed, truncated) = resources ? Resources(files, dir) : (Array.Empty<string>(), false);
        return new SkillInfo(
            name,
            description,
            dir,
            entry,
            root.Type,
            root.Agent,
            listed,
            truncated,
            run,
            runError,
            files
        );
    }

    // The skill `name` resolves to, as load and run resolve it; the caller reads inside it.
    internal Task<SkillInfo> ResolveAsync(string name, string agent) =>
        FindAsync(name, agent, false, Task.FromResult);

    // Files under `start` (the skill directory or a directory inside it) as paths relative to
    // the skill directory: links and Skip directories are left out, and so is the root SKILL.md.
    // Stops after 200 files.
    internal static (string[] Files, bool Truncated) Resources(ISkillFiles source, string root, string? start = null)
    {
        var files = new List<string>();
        var truncated = false;
        void Walk(string current)
        {
            if (truncated)
                return;
            IReadOnlyList<SkillFileEntry> entries;
            try
            {
                entries = source.Entries(current);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"Failed to list skill resources: {error.Message}");
                return;
            }
            foreach (
                var item in entries
                    .OrderBy(info => info.IsDirectory ? 0 : 1)
                    .ThenBy(info => info.Name, StringComparer.CurrentCulture)
            )
            {
                if (item.IsLink)
                    continue;
                if (item.IsDirectory)
                {
                    if (!Skip.Contains(item.Name))
                        Walk(item.FullPath);
                    if (truncated)
                        return;
                }
                else
                {
                    var relative = Path.GetRelativePath(root, item.FullPath)
                        .Replace(Path.DirectorySeparatorChar, '/');
                    if (relative == "SKILL.md")
                        continue;
                    if (files.Count >= 200)
                    {
                        truncated = true;
                        return;
                    }
                    files.Add(relative);
                }
            }
        }
        Walk(start ?? root);
        return (files.ToArray(), truncated);
    }

    private static string? Description(string content)
    {
        var match = FrontMatter().Match(content);
        if (match.Success)
        {
            var data = FrontMatterYaml.Parse(match.Groups[1].Value);
            if (
                data is IDictionary map
                && map["description"] is string description
                && description.Length > 0
            )
                return description;
            content = content[match.Length..];
        }
        var paragraph = new List<string>();
        var fenced = false;
        foreach (var raw in content.Split('\n').Take(40))
        {
            var line = raw.Trim();
            if (line.StartsWith("```", StringComparison.Ordinal))
            {
                fenced = !fenced;
                if (paragraph.Count > 0)
                    break;
                continue;
            }
            if (fenced)
                continue;
            if (
                line.Length == 0
                || line.StartsWith('#')
                || line.StartsWith('>')
                || Regex.IsMatch(line, "^(?:[-*+]\\s|\\d+\\.\\s)")
            )
            {
                if (paragraph.Count > 0)
                    break;
                continue;
            }
            if (line.StartsWith("<!--", StringComparison.Ordinal))
                continue;
            paragraph.Add(line);
        }
        return paragraph.Count == 0 ? null : string.Join(' ', paragraph);
    }

    [GeneratedRegex("^[a-zA-Z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Segment();

    [GeneratedRegex("^---\\s*\\n([\\s\\S]*?)\\n---\\s*(?:\\n|$)", RegexOptions.CultureInvariant)]
    private static partial Regex FrontMatter();
}
