using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class AtomicFileReplaceTests
{
    [Theory]
    [InlineData(FileShare.ReadWrite | FileShare.Delete, true)]
    [InlineData(FileShare.Read, false)]
    public void Replacing_an_open_destination_depends_on_whether_its_reader_allows_deletion(
        FileShare sharing,
        bool replaced
    )
    {
        using var temp = new TempDirectory();
        var destination = Path.Combine(temp.Path, "registry.json");
        var temporary = destination + ".tmp";
        File.WriteAllText(destination, "old");
        File.WriteAllText(temporary, "new");
        using (
            var reader = new FileStream(destination, FileMode.Open, FileAccess.Read, sharing)
        )
        {
            if (OperatingSystem.IsWindows() && !replaced)
                Assert.Throws<IOException>(() => AtomicFileReplace.Replace(temporary, destination));
            else
                AtomicFileReplace.Replace(temporary, destination);
            // The reader keeps the contents it opened.
            using var text = new StreamReader(reader);
            Assert.Equal("old", text.ReadToEnd());
        }
        var expected = !OperatingSystem.IsWindows() || replaced;
        Assert.Equal(expected ? "new" : "old", File.ReadAllText(destination));
        Assert.Equal(!expected, File.Exists(temporary));
    }
}
