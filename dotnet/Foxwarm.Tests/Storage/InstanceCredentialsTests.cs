using Foxwarm.Storage;

namespace Foxwarm.Tests;

public sealed class InstanceCredentialsTests
{
    [Fact]
    public void Each_credential_is_created_once_owner_only_and_then_read_back()
    {
        using var temp = new TempDirectory();
        var credentials = new FileInstanceCredentials(temp.Path);
        foreach (var name in Enum.GetValues<InstanceCredentialName>())
        {
            Assert.Null(credentials.Read(name));
            var first = credentials.ReadOrCreate(name, () => "first-" + name);
            var second = credentials.ReadOrCreate(name, () => "second-" + name);
            Assert.Equal("first-" + name, first);
            Assert.Equal(first, second);
            Assert.Equal(first, new FileInstanceCredentials(temp.Path).Read(name));
            if (!OperatingSystem.IsWindows())
                Assert.Equal(
                    UnixFileMode.UserRead | UnixFileMode.UserWrite,
                    File.GetUnixFileMode(credentials.PathFor(name))
                );
        }
    }

    [Fact]
    public void Tokens_reject_invalid_utf8()
    {
        using var temp = new TempDirectory();
        var credentials = new FileInstanceCredentials(temp.Path);
        foreach (
            var name in new[]
            {
                InstanceCredentialName.HttpToken,
                InstanceCredentialName.NodePairingToken,
            }
        )
        {
            var path = credentials.PathFor(name);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, [0x41, 0xff, 0x42]);
            Assert.ThrowsAny<ArgumentException>(() => credentials.Read(name));
        }
    }
}
