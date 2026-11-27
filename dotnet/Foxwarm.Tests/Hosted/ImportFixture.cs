using System.Security.Cryptography;

namespace Foxwarm.Tests.Hosted;

/// <summary>Builds file installations for <see cref="HostedImportTests"/> and checks they stay unchanged.</summary>
internal static partial class ImportFixture
{
    /// <summary>
    /// Every file under <paramref name="root"/> with its SHA-256, size and mode, plus every
    /// directory, so an import that wrote, created or removed anything in the source differs.
    /// </summary>
    internal static SortedDictionary<string, string> TreeHashes(string root)
    {
        var result = new SortedDictionary<string, string>(StringComparer.Ordinal);
        Walk(new DirectoryInfo(root));
        void Walk(DirectoryInfo parent)
        {
            foreach (var entry in parent.GetFileSystemInfos())
            {
                var path = Path.GetRelativePath(root, entry.FullName);
                if (entry.LinkTarget is { } target)
                    result[path] = "link " + target;
                else if (entry is DirectoryInfo directory)
                {
                    result[path + "/"] = Mode(entry.FullName);
                    Walk(directory);
                }
                else
                {
                    using var stream = File.OpenRead(entry.FullName);
                    result[path] = Convert.ToHexStringLower(SHA256.HashData(stream)) + " " + stream.Length + " " + Mode(entry.FullName);
                }
            }
        }
        return result;
    }

    private static string Mode(string path) =>
        OperatingSystem.IsWindows() ? "" : File.GetUnixFileMode(path).ToString("D");
}
