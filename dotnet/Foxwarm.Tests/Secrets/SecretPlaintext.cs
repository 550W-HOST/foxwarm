using System.Security.Cryptography;
using System.Text;

namespace Foxwarm.Tests;

internal static class SecretPlaintext
{
    internal static string Sha256(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    /// <summary>Fails if any file under the root contains the value as UTF-8 text.</summary>
    internal static void AssertAbsent(string root, string value)
    {
        var needle = Encoding.UTF8.GetBytes(value);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(file);
            }
            catch (IOException)
            {
                continue;
            }
            Assert.False(
                bytes.AsSpan().IndexOf(needle) >= 0,
                $"Secret value found in plaintext in {Path.GetRelativePath(root, file)}."
            );
        }
    }
}
