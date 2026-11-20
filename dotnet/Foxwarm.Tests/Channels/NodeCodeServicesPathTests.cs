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
        var presented = new JsonObject { ["workspace"] = "C:/repo", ["topLevel"] = "c:/repo/sub" };
        CodeNativePaths.TransportWorkspace(presented);
        Assert.Equal("/C:/repo", presented["workspace"]!.ToString());
        Assert.Equal("/C:/repo/sub", presented["topLevel"]!.ToString());
        var root = await Assert.ThrowsAsync<CodeServiceException>(() =>
            NodeCodeServices.Execute("vscode-git", "status", new() { ["workspace"] = "/" })
        );
        Assert.Equal("InvalidPath", root.Code);

        using var temp = new TempDirectory();
        using (
            var init = Process.Start(
                new ProcessStartInfo("git", "init -q") { WorkingDirectory = temp.Path }
            )
        )
            await init!.WaitForExitAsync();
        using var probe = Process.Start(
            new ProcessStartInfo("git", "rev-parse --show-toplevel")
            {
                WorkingDirectory = temp.Path,
                RedirectStandardOutput = true,
            }
        );
        // An MSYS Git prints /c/... instead of the drive path that Git for Windows prints.
        if ((await probe!.StandardOutput.ReadToEndAsync()).StartsWith('/'))
            return;
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
    }

    [Fact]
    public async Task Windows_service_terminal_accepts_mapped_drive_folders_and_keeps_native_root()
    {
        if (!OperatingSystem.IsWindows() || !Foxwarm.Terminal.TerminalNative.IsSupported)
            return;
        using var temp = new TempDirectory();
        // CreateProcess does not search PATH, so name the shell as the CLI e2e fixtures do.
        var shell = Path.Combine(
            Environment.SystemDirectory,
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        );
        var previousShell = Environment.GetEnvironmentVariable("FOXWARM_NODE_PTY_SHELL");
        Environment.SetEnvironmentVariable("FOXWARM_NODE_PTY_SHELL", shell);
        try
        {
            await AssertTerminalPaths(temp.Path);
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_NODE_PTY_SHELL", previousShell);
        }
    }

    private static async Task AssertTerminalPaths(string folder)
    {
        await using var service = new NodePtyService(folder);
        var owner = new object();

        async Task<string> Cwd(string requested)
        {
            JsonObject? response = null;
            await service.Dispatch(
                "create",
                new JsonObject { ["cwd"] = requested },
                owner,
                value =>
                {
                    response = value;
                    return Task.CompletedTask;
                }
            );
            return response!["terminal"]!["cwd"]!.ToString();
        }

        var mapped = CodeNativePaths.Transport(folder);
        Assert.Equal(mapped, await Cwd(mapped), ignoreCase: true);
        Assert.Equal(folder, await Cwd(folder), ignoreCase: true);
        Assert.Equal(Path.GetPathRoot(Environment.CurrentDirectory), await Cwd("/"));
    }
}
