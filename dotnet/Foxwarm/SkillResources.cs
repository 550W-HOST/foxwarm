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

internal sealed partial class Skills
{
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
            full = Contained(info.Directory, segments, directoryLast: false, skipNames: true);
            if (full is not null && directory)
                full = null;
            full ??= Contained(info.Directory, segments, directoryLast: true, skipNames: true);
        }
        if (full is null)
            throw NotAResource(info.Name, path);
        if (!Directory.Exists(full))
            return new SkillResource(info, relative, full, false, [], false);
        var (files, truncated) = Resources(info.Directory, full);
        // A directory without listable resources (empty, or only links and skipped names) is
        // not one either.
        if (files.Length == 0)
            throw NotAResource(info.Name, path);
        return new SkillResource(info, relative + "/", full, true, files, truncated);
    }

    internal static InvalidDataException NotAResource(string skill, string path) =>
        new($"`{path}` is not a resource of skill `{skill}`.");
}
