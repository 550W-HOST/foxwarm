using System.Text.Json.Nodes;
using Foxwarm.Code;

namespace Foxwarm.Tests;

public sealed class CodeFileOperationsTests
{
    // JSON serialization normalizes the managed Int64 and Linux Double values
    // exactly as the HTTP filesystem API does.
    private static double Number(JsonNode value) =>
        JsonNode.Parse(value.ToJsonString())!.GetValue<double>();

    [Fact]
    public async Task File_and_directory_metadata_are_available_on_the_native_host()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "literal%20 space 雪.txt");
        await File.WriteAllBytesAsync(path, [0, 255, 17]);
        var modified = new DateTime(2024, 2, 3, 4, 5, 6, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(path, modified);

        var file = CodeFileOperations.StatFile(path);
        Assert.Equal(1, file["type"]!.GetValue<int>());
        Assert.Equal(3UL, file["size"]!.GetValue<ulong>());
        Assert.True(Number(file["ctime"]!) > 0);
        Assert.Equal(
            new DateTimeOffset(modified).ToUnixTimeMilliseconds(),
            Number(file["mtime"]!)
        );
        var directory = CodeFileOperations.StatFile(temp.Path);
        Assert.Equal(2, directory["type"]!.GetValue<int>());
        Assert.True(Number(directory["ctime"]!) > 0);
        if (OperatingSystem.IsMacOS() || OperatingSystem.IsWindows())
            Assert.Equal(0UL, directory["size"]!.GetValue<ulong>());
    }

    [Fact]
    public async Task Unix_links_follow_targets_and_keep_link_and_owner_readonly_metadata()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "readonly");
        await File.WriteAllTextAsync(path, "target");
        File.SetLastWriteTimeUtc(path, new DateTime(2023, 2, 3, 4, 5, 6, DateTimeKind.Utc));
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.GroupWrite);
        var link = Path.Combine(temp.Path, "link");
        File.CreateSymbolicLink(link, path);
        var directoryLink = Path.Combine(temp.Path, "directory-link");
        Directory.CreateSymbolicLink(directoryLink, temp.Path);
        try
        {
            var stat = CodeFileOperations.StatFile(link);
            Assert.Equal(65, stat["type"]!.GetValue<int>());
            Assert.Equal(6UL, stat["size"]!.GetValue<ulong>());
            Assert.Equal(1, stat["permissions"]!.GetValue<int>());
            Assert.Equal(
                Number(CodeFileOperations.StatFile(path)["mtime"]!),
                Number(stat["mtime"]!)
            );
            Assert.Equal(
                "target",
                System.Text.Encoding.UTF8.GetString(
                    await CodeFileOperations.ReadFileAsync(link, CancellationToken.None)
                )
            );
            Assert.Equal(66, CodeFileOperations.StatFile(directoryLink)["type"]!.GetValue<int>());
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            Assert.Null(CodeFileOperations.StatFile(link)["permissions"]);
        }
        finally
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            Directory.Delete(directoryLink);
        }
    }

    [Fact]
    public void Unix_missing_targets_and_broken_links_are_not_reported_as_directories()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var missing = Path.Combine(temp.Path, "missing");
        var link = Path.Combine(temp.Path, "broken");
        File.CreateSymbolicLink(link, missing);
        foreach (var path in new[] { missing, link })
        {
            var error = Assert.Throws<CodeServiceException>(() => CodeFileOperations.StatFile(path));
            Assert.Equal("FileNotFound", error.Code);
        }
        var entries = CodeFileOperations.ReadDirectory(temp.Path)["entries"]!.AsArray();
        Assert.Equal(
            0,
            entries.Single(entry => entry!["name"]!.GetValue<string>() == "broken")![
                "type"
            ]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task Native_file_operations_support_create_write_read_rename_and_delete()
    {
        using var temp = new TempDirectory();
        var directory = Path.Combine(temp.Path, "directory 雪");
        Assert.True(CodeFileOperations.CreateDirectory(directory)["success"]!.GetValue<bool>());
        var path = Path.Combine(directory, "file.bin");
        using var content = new MemoryStream([0, 255, 17]);
        var result = await CodeFileOperations.WriteFileAsync(
            path, content, true, false, CancellationToken.None
        );
        Assert.Equal(1, result["stat"]!["type"]!.GetValue<int>());
        Assert.Equal(
            new byte[] { 0, 255, 17 },
            await CodeFileOperations.ReadFileAsync(path, CancellationToken.None)
        );
        var renamed = Path.Combine(directory, "renamed.bin");
        CodeFileOperations.Rename(path, renamed, false);
        Assert.False(File.Exists(path));
        Assert.True(File.Exists(renamed));
        Assert.Single(CodeFileOperations.ReadDirectory(directory)["entries"]!.AsArray());
        CodeFileOperations.Delete(renamed, false);
        CodeFileOperations.Delete(directory, true);
        Assert.False(Directory.Exists(directory));
    }
}
