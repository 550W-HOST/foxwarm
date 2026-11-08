namespace Foxwarm.Tools;

public sealed partial class WorkspaceTools
{
    internal static string PrivateNodeTokenPath(string raw, string tool)
    {
        if (!Path.IsPathFullyQualified(raw) || raw.Contains('\0'))
            throw new InvalidDataException(tool + " filePath must be an absolute path on master.");
        return Path.GetFullPath(raw);
    }
}
