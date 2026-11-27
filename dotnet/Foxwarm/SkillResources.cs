namespace Foxwarm;

// One resource of a resolved skill: a file, or a directory with the resources listed under it.
internal sealed record SkillResource(
    SkillInfo Info,
    string Path,
    string FullPath,
    bool IsDirectory,
    string[] Files,
    bool Truncated
)
{
    // How results name it: the skill and the path relative to its directory, never a Main
    // server path.
    internal string Display => Info.Name + "/" + Path;
}

// One file of a skill copy: its resource path, its Main server path and its destination.
internal sealed record SkillCopyFile(string Path, string FullPath, string Target, long Bytes);

internal sealed partial class Skills
{
    // Bounds of one `skill copy` (engineering constants, no product contract): the listing cap
    // and a total size. Over either, nothing is written.
    internal const int MaxCopyFiles = 200;
    internal const long MaxCopyBytes = 64L * 1024 * 1024;

    // What `skill copy` writes: without a path the whole skill (SKILL.md and every listed
    // resource) into targetPath as a directory; a file to targetPath itself; a directory's
    // resources into targetPath, keeping their layout below it. Links, skipped names and empty
    // directories are never copied.
    internal static IReadOnlyList<SkillCopyFile> CopyPlan(SkillInfo info, string? path, string targetPath)
    {
        static string Under(string root, string relative) =>
            root.EndsWith('/') ? root + relative : root + "/" + relative;
        List<(string Path, string Target)> items;
        var truncated = false;
        if (path is null)
        {
            var (files, more) = Resources(info.Source, info.Directory);
            files = files.Where(file => !info.Withheld.Contains(file)).ToArray();
            truncated = more;
            items = [("SKILL.md", Under(targetPath, "SKILL.md")), .. files.Select(file => (file, Under(targetPath, file)))];
        }
        else
        {
            var resource = ResourcePath(info, path);
            truncated = resource.Truncated;
            items = resource.IsDirectory
                ? resource.Files.Select(file => (file, Under(targetPath, file[resource.Path.Length..]))).ToList()
                : [(resource.Path, targetPath)];
        }
        var plan = items
            .Select(item =>
            {
                var full = System.IO.Path.Combine(info.Directory, item.Path);
                return new SkillCopyFile(item.Path, full, item.Target, info.Source.Length(full));
            })
            .ToArray();
        if (truncated || plan.Length > MaxCopyFiles || plan.Sum(file => file.Bytes) > MaxCopyBytes)
            throw new InvalidDataException(
                $"Copying {(path is null ? "skill" : $"`{path}` of skill")} `{info.Name}` would exceed {MaxCopyFiles} files or {MaxCopyBytes / (1024 * 1024)} MiB; copy a subdirectory with --path instead."
            );
        return plan;
    }

    // A path inside a resolved skill, contained as the run entry is (relative, `/`-separated, no
    // empty, `.` or `..` segment, no colon or backslash, no reparse point), with no directory
    // component the resource listing skips (.git, node_modules, …). A trailing `/` names a
    // directory. The listing's 200-file cap does not limit which paths can be read. Every
    // failure gives one message, so it does not reveal which case applied.
    internal static SkillResource ResourcePath(SkillInfo info, string path)
    {
        var directory = path.EndsWith('/');
        var relative = directory ? path[..^1] : path;
        string? full = null;
        if (relative.Length > 0 && RelativeShape(relative))
        {
            var segments = relative.Split('/');
            full = Contained(info.Source, info.Directory, segments, directoryLast: false, skipNames: true);
            if (full is not null && directory)
                full = null;
            full ??= Contained(info.Source, info.Directory, segments, directoryLast: true, skipNames: true);
        }
        if (full is null || info.Withheld.Contains(relative))
            throw NotAResource(info.Name, path);
        if (!info.Source.DirectoryExists(full))
            return new SkillResource(info, relative, full, false, [], false);
        var (files, truncated) = Resources(info.Source, info.Directory, full);
        files = files.Where(file => !info.Withheld.Contains(file)).ToArray();
        // A directory without listable resources (empty, or only links and skipped names) is
        // not one either.
        if (files.Length == 0)
            throw NotAResource(info.Name, path);
        return new SkillResource(info, relative + "/", full, true, files, truncated);
    }

    internal static InvalidDataException NotAResource(string skill, string path) =>
        new($"`{path}` is not a resource of skill `{skill}`.");
}
