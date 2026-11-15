using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Code;

namespace Foxwarm.Tests;

public sealed class NodeCodeServicesPathTests
{
    private static Task<JsonObject> Fs(string operation, string path, JsonObject? extra = null)
    {
        var args = new JsonObject { ["path"] = path };
        foreach (var item in extra ?? [])
            args[item.Key] = item.Value?.DeepClone();
        return NodeCodeServices.Execute("vscode-fs", operation, args);
    }

    [Fact]
    public async Task Native_and_POSIX_paths_keep_their_service_meaning()
    {
        using var temp = new TempDirectory();
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "native.txt"), "native");
        var listing = await Fs("read-directory", temp.Path);
        Assert.Contains(
            listing["entries"]!.AsArray(),
            entry => entry!["name"]!.ToString() == "native.txt"
        );
        if (OperatingSystem.IsWindows())
            return;
        Assert.Equal(2, (await Fs("stat", "/"))["type"]!.GetValue<int>());
        Assert.NotEmpty((await Fs("read-directory", "/"))["entries"]!.AsArray());
    }

    [Fact]
    public async Task Windows_service_maps_the_virtual_root_and_drive_paths()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var drive = Path.GetPathRoot(temp.Path)!;
        var rootEntries = Directory.GetFileSystemEntries(drive).Length;
        Assert.Equal(2, (await Fs("stat", "/"))["type"]!.GetValue<int>());
        var names = (await Fs("read-directory", "/"))["entries"]!
            .AsArray()
            .Select(entry => entry!["name"]!.ToString())
            .ToArray();
        Assert.Contains(drive[..2], names, StringComparer.OrdinalIgnoreCase);

        var mapped = CodeNativePaths.Transport(Path.Combine(temp.Path, "mapped.txt"));
        await Fs(
            "write-file",
            mapped,
            new()
            {
                ["contentBase64"] = Convert.ToBase64String("mapped"u8),
                ["create"] = true,
            }
        );
        Assert.Equal("mapped", await File.ReadAllTextAsync(Path.Combine(temp.Path, "mapped.txt")));
        Assert.Equal(
            "mapped",
            System.Text.Encoding.UTF8.GetString(
                Convert.FromBase64String(
                    (await Fs("read-file", mapped))["contentBase64"]!.ToString()
                )
            )
        );
        Assert.Contains(
            (await Fs("read-directory", "/" + drive[..2]))["entries"]!.AsArray(),
            entry => entry!["type"]!.GetValue<int>() >= 1
        );
        var renamed = CodeNativePaths.Transport(Path.Combine(temp.Path, "renamed.txt"));
        await Fs("rename", mapped, new() { ["newPath"] = renamed });
        Assert.True(File.Exists(Path.Combine(temp.Path, "renamed.txt")));

        var refused = await Assert.ThrowsAsync<CodeServiceException>(() =>
            Fs("delete", "/", new() { ["recursive"] = true })
        );
        Assert.Equal("NoPermissions", refused.Code);
        Assert.Equal(
            "NoPermissions",
            (
                await Assert.ThrowsAsync<CodeServiceException>(() =>
                    Fs("rename", renamed, new() { ["newPath"] = "/", ["overwrite"] = true })
                )
            ).Code
        );
        Assert.True(File.Exists(Path.Combine(temp.Path, "renamed.txt")));
        Assert.Equal(rootEntries, Directory.GetFileSystemEntries(drive).Length);

        // Native-form callers retain their previous behavior.
        Assert.Equal(
            2,
            (await Fs("stat", Path.TrimEndingDirectorySeparator(temp.Path)))["type"]!
                .GetValue<int>()
        );
    }

    [Fact]
    public async Task Windows_service_git_uses_mapped_repositories_and_rejects_the_virtual_root()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        using (var init = Process.Start(new ProcessStartInfo("git", "init -q") { WorkingDirectory = temp.Path }))
            await init!.WaitForExitAsync();
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "tracked.txt"), "x");
        var mapped = CodeNativePaths.Transport(temp.Path);
        var status = await NodeCodeServices.Execute(
            "vscode-git",
            "status",
            new() { ["workspace"] = mapped }
        );
        Assert.Equal(mapped, status["workspace"]!.ToString(), ignoreCase: true);
        Assert.Equal(mapped, status["topLevel"]!.ToString(), ignoreCase: true);
        Assert.Single(status["changes"]!.AsArray());
        var native = await NodeCodeServices.Execute(
            "vscode-git",
            "status",
            new() { ["workspace"] = temp.Path }
        );
        Assert.False(native["workspace"]!.ToString().StartsWith('/'));
        var root = await Assert.ThrowsAsync<CodeServiceException>(() =>
            NodeCodeServices.Execute("vscode-git", "status", new() { ["workspace"] = "/" })
        );
        Assert.Equal("InvalidPath", root.Code);
    }
}
