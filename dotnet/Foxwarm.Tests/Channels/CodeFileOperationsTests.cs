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
        Assert.Equal(new DateTimeOffset(modified).ToUnixTimeMilliseconds(), Number(file["mtime"]!));
        var directory = CodeFileOperations.StatFile(temp.Path);
        Assert.Equal(2, directory["type"]!.GetValue<int>());
        Assert.True(Number(directory["ctime"]!) > 0);
        if (OperatingSystem.IsWindows())
            Assert.Equal(0UL, directory["size"]!.GetValue<ulong>());
    }

    [Fact]
    public async Task Windows_virtual_root_is_a_drive_directory_without_native_mutation()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var drive = Path.GetPathRoot(temp.Path)!;
        var before = Directory.GetFileSystemEntries(drive).Length;
        var root = CodeNativePaths.Native("/");
        Assert.True(CodeNativePaths.IsVirtualRoot(root));
        Assert.Equal(drive, CodeNativePaths.Native("/" + char.ToLowerInvariant(drive[0]) + ":"));
        Assert.Throws<CodeServiceException>(() => CodeNativePaths.NativeDirectory("/"));
        Assert.Equal("/", CodeNativePaths.Transport("/"));

        Assert.Equal(2, CodeFileOperations.StatFile(root)["type"]!.GetValue<int>());
        var names = CodeFileOperations
            .ReadDirectory(root)["entries"]!
            .AsArray()
            .Select(entry => entry!["name"]!.ToString())
            .ToArray();
        Assert.Contains(drive[..2], names, StringComparer.OrdinalIgnoreCase);
        Assert.All(names, name => Assert.Matches("^[A-Za-z]:$", name));

        var file = Path.Combine(temp.Path, "kept.txt");
        await File.WriteAllTextAsync(file, "kept");
        Assert.Equal(
            "FileIsADirectory",
            (
                await Assert.ThrowsAsync<CodeServiceException>(() =>
                    CodeFileOperations.ReadFileAsync(root, CancellationToken.None)
                )
            ).Code
        );
        using var input = new MemoryStream([1]);
        Assert.Equal(
            "FileIsADirectory",
            (
                await Assert.ThrowsAsync<CodeServiceException>(() =>
                    CodeFileOperations.WriteFileAsync(
                        root,
                        input,
                        true,
                        true,
                        CancellationToken.None
                    )
                )
            ).Code
        );
        Assert.Equal(
            "FileExists",
            Assert.Throws<CodeServiceException>(() => CodeFileOperations.CreateDirectory(root)).Code
        );
        Assert.Equal(
            "NoPermissions",
            Assert.Throws<CodeServiceException>(() => CodeFileOperations.Delete(root, true)).Code
        );
        Assert.Equal(
            "NoPermissions",
            Assert.Throws<CodeServiceException>(() =>
                CodeFileOperations.Rename(root, file, true)
            ).Code
        );
        Assert.Equal(
            "NoPermissions",
            Assert.Throws<CodeServiceException>(() =>
                CodeFileOperations.Rename(file, root, true)
            ).Code
        );
        Assert.Equal("kept", await File.ReadAllTextAsync(file));
        Assert.Equal(before, Directory.GetFileSystemEntries(drive).Length);
    }

    [Fact]
    public void Posix_root_remains_the_real_filesystem_root()
    {
        if (OperatingSystem.IsWindows())
            return;
        Assert.False(CodeNativePaths.IsVirtualRoot("/"));
        Assert.False(CodeNativePaths.IsMapped("/"));
        Assert.Equal("/", CodeNativePaths.NativeDirectory("/"));
        Assert.Equal(2, CodeFileOperations.StatFile("/")["type"]!.GetValue<int>());
        Assert.NotEmpty(CodeFileOperations.ReadDirectory("/")["entries"]!.AsArray());
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
            await Task.Delay(1100);
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            var writable = CodeFileOperations.StatFile(link);
            Assert.Null(writable["permissions"]);
            Assert.True(Number(writable["ctime"]!) > Number(stat["ctime"]!));
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
            var error = Assert.Throws<CodeServiceException>(() =>
                CodeFileOperations.StatFile(path)
            );
            Assert.Equal("FileNotFound", error.Code);
        }
        var file = Path.Combine(temp.Path, "file");
        File.WriteAllText(file, "content");
        var nonDirectoryLink = Path.Combine(temp.Path, "non-directory-link");
        File.CreateSymbolicLink(nonDirectoryLink, Path.Combine(file, "child"));
        var nonDirectory = Assert.Throws<CodeServiceException>(() =>
            CodeFileOperations.StatFile(nonDirectoryLink)
        );
        Assert.Equal("FileNotADirectory", nonDirectory.Code);
        var entries = CodeFileOperations.ReadDirectory(temp.Path)["entries"]!.AsArray();
        Assert.Equal(
            0,
            entries.Single(entry => entry!["name"]!.GetValue<string>() == "broken")![
                "type"
            ]!.GetValue<int>()
        );
    }

    [Fact]
    public async Task Unix_special_files_are_not_admitted_as_regular_Code_files()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var pipe = Path.Combine(temp.Path, "pipe");
        using (var process = System.Diagnostics.Process.Start("mkfifo", new[] { pipe })!)
        {
            await process.WaitForExitAsync();
            Assert.Equal(0, process.ExitCode);
        }
        Assert.Equal(0, CodeFileOperations.StatFile(pipe)["type"]!.GetValue<int>());
        var link = Path.Combine(temp.Path, "pipe-link");
        File.CreateSymbolicLink(link, pipe);
        Assert.Equal(64, CodeFileOperations.StatFile(link)["type"]!.GetValue<int>());
        var error = await Assert.ThrowsAsync<CodeServiceException>(() =>
            CodeFileOperations.ReadFileAsync(pipe, CancellationToken.None)
        );
        Assert.Equal("FileIsADirectory", error.Code);
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
            path,
            content,
            true,
            false,
            CancellationToken.None
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
