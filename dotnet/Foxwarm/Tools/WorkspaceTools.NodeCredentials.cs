namespace Foxwarm.Tools;

public sealed partial class WorkspaceTools
{
    internal static string PrivateNodeTokenPath(string raw)
    {
        if (!Path.IsPathFullyQualified(raw) || raw.Contains('\0'))
            throw new InvalidDataException("node_create_auth_token filePath must be an absolute path on Main.");
        return Path.GetFullPath(raw);
    }
}
