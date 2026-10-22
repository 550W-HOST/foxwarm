using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class MainLocalToolsTests
{
    [Theory]
    [InlineData("write", 448)]
    [InlineData("edit", 448)]
    [InlineData("apply_patch", 448)]
    [InlineData("write", 384)]
    [InlineData("edit", 384)]
    [InlineData("apply_patch", 384)]
    public async Task Ordinary_updates_preserve_permissions_and_existing_hardlinks_through_symlinks(
        string operation,
        int mode
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var root = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        var target = Path.Combine(root, "target.txt");
        var alias = Path.Combine(root, "hardlink.txt");
        var link = Path.Combine(root, "link.txt");
        await File.WriteAllTextAsync(target, "before\n");
        File.SetUnixFileMode(target, (UnixFileMode)mode);
        using (var process = Process.Start("ln", new[] { target, alias })!)
        {
            await process.WaitForExitAsync();
            Assert.Equal(0, process.ExitCode);
        }
        File.CreateSymbolicLink(link, "target.txt");

        var result = await f.Call(operation, UpdateArguments(operation, "link.txt"));

        Assert.Null(Error(result));
        Assert.Equal((UnixFileMode)mode, File.GetUnixFileMode(target));
        Assert.Equal("after\n", await File.ReadAllTextAsync(target));
        Assert.Equal("after\n", await File.ReadAllTextAsync(alias));
        Assert.Equal("target.txt", new FileInfo(link).LinkTarget);
    }

    [Fact]
    public async Task Exclusive_write_collisions_leave_regular_and_dangling_links_untouched()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var root = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        await File.WriteAllTextAsync(Path.Combine(root, "existing.txt"), "before\n");
        File.CreateSymbolicLink(Path.Combine(root, "dangling.txt"), "missing.txt");
        foreach (var path in new[] { "existing.txt", "dangling.txt" })
        {
            var result = await f.Call(
                "write",
                new JsonObject { ["filePath"] = path, ["content"] = "never" }
            );
            Assert.Equal("file_exists", Error(result));
        }
        Assert.Equal("before\n", await File.ReadAllTextAsync(Path.Combine(root, "existing.txt")));
        Assert.Equal("missing.txt", new FileInfo(Path.Combine(root, "dangling.txt")).LinkTarget);
        Assert.False(File.Exists(Path.Combine(root, "missing.txt")));
    }

    [Fact]
    public async Task Failed_later_patch_operation_retains_the_completed_in_place_update()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var root = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        var path = Path.Combine(root, "script.sh");
        await File.WriteAllTextAsync(path, "before\n");
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var result = await f.Call(
            "apply_patch",
            new JsonObject
            {
                ["input"] = "*** Begin Patch\n*** Update File: script.sh\n@@\n-before\n+after\n*** Update File: missing.txt\n@@\n-before\n+after\n*** Add File: never.txt\n+never\n*** End Patch",
            }
        );
        Assert.Equal("patch_failed", Error(result));
        Assert.Contains("Operations already applied", result["error"]!["message"]!.GetValue<string>());
        Assert.Contains("1 remaining operation(s) were not applied.", result["error"]!["message"]!.GetValue<string>());
        Assert.Equal("after\n", await File.ReadAllTextAsync(path));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(path));
        Assert.False(File.Exists(Path.Combine(root, "never.txt")));
    }

    [Theory]
    [InlineData("write")]
    [InlineData("edit")]
    [InlineData("apply_patch")]
    public async Task Ordinary_updates_authorize_the_physical_symlink_target_before_effects(string operation)
    {
        await using var f = await Fixture.Create();
        var root = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        var outside = Path.Combine(f.Temp.Path, "outside.txt");
        await File.WriteAllTextAsync(outside, "before\n");
        File.CreateSymbolicLink(Path.Combine(root, "link.txt"), outside);
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: deny\nrules:\n- id: own-files\n  action: allow\n  match:\n    tool: {source: node, name: '*'}\n    path: {allWithin: '${agent.dir}'}\n"
            ),
            default
        );

        var result = await f.Call(operation, UpdateArguments(operation, "link.txt"));

        Assert.Equal("tool_authorization_denied", Error(result));
        Assert.Equal("before\n", await File.ReadAllTextAsync(outside));
        Assert.Equal(outside, new FileInfo(Path.Combine(root, "link.txt")).LinkTarget);
    }

    private static JsonObject UpdateArguments(string operation, string path) => operation switch
    {
        "write" => new JsonObject { ["filePath"] = path, ["content"] = "after\n", ["overwrite"] = true },
        "edit" => new JsonObject { ["filePath"] = path, ["oldText"] = "before", ["newText"] = "after" },
        _ => new JsonObject { ["input"] = $"*** Begin Patch\n*** Update File: {path}\n@@\n-before\n+after\n*** End Patch" },
    };
}
