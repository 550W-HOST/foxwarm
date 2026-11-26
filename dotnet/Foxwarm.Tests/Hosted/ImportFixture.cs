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
        foreach (var directory in Directory.EnumerateDirectories(root, "*", SearchOption.AllDirectories))
            result[Path.GetRelativePath(root, directory) + "/"] = Mode(directory);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            using var stream = File.OpenRead(file);
            result[Path.GetRelativePath(root, file)] =
                Convert.ToHexStringLower(SHA256.HashData(stream)) + " " + new FileInfo(file).Length + " " + Mode(file);
        }
        return result;
    }

    private static string Mode(string path) =>
        OperatingSystem.IsWindows() ? "" : File.GetUnixFileMode(path).ToString("D");
}
