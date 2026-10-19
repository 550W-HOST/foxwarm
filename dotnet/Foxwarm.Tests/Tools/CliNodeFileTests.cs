using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class CliNodeFileTests
{
    [Fact]
    public async Task Cli_content_writes_follow_links_while_Main_keeps_its_own_authorized_atomic_owner()
    {
        using var temp = new TempDirectory();
        var target = Path.Combine(temp.Path, "target.txt");
        var link = Path.Combine(temp.Path, "link.txt");
        await File.WriteAllTextAsync(target, "before");
        File.CreateSymbolicLink(link, target);
        var cli = new NodeFileTools(new NodePaths(temp.Path));
        var result = await cli.Execute(
            "write",
            new JsonObject
            {
                ["filePath"] = link,
                ["content"] = "after",
                ["overwrite"] = true,
            },
            "main",
            null,
            false
        );
        Assert.Equal("after", await File.ReadAllTextAsync(target));
        Assert.NotNull(new FileInfo(link).LinkTarget);
        Assert.Equal(
            link,
            result["__foxwarmResolvedToolPaths"]![0]!["resolved"]!.GetValue<string>()
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            cli.Execute(
                "write",
                new JsonObject { ["filePath"] = link, ["content"] = "forbidden" },
                "main",
                null,
                false
            )
        );
        Assert.Equal("after", await File.ReadAllTextAsync(target));
        var validations = 0;
        Assert.True(
            await FileToolWrite.WriteAtomic(link, "main-after", true, () => validations++, default)
        );
        Assert.Equal(1, validations);
        Assert.Equal("main-after", await File.ReadAllTextAsync(target));
        Assert.NotNull(new FileInfo(link).LinkTarget);
    }

    [Fact]
    public async Task Shared_exact_match_keeps_Main_literal_replacement_and_Cli_Source_tokens_distinct()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "input.txt");
        await File.WriteAllTextAsync(path, "before:old:after");
        var cli = new NodeFileTools(new NodePaths(temp.Path));
        await cli.Execute(
            "edit",
            new JsonObject
            {
                ["filePath"] = path,
                ["oldText"] = "old",
                ["newText"] = "$$-$&-$`-$'-$1",
            },
            "main",
            null,
            false
        );
        Assert.Equal("before:$-old-before:-:after-$1:after", await File.ReadAllTextAsync(path));
        Assert.Equal(
            "before:$$-$&-$`-$'-$1:after",
            ExactReplacement.Apply("before:old:after", "old", "$$-$&-$`-$'-$1").Updated
        );
    }

    [Fact]
    public async Task Partial_patch_effects_remain_on_disk_without_a_success_sidecar_and_transfer_replaces_final_link()
    {
        using var temp = new TempDirectory();
        var paths = new NodePaths(temp.Path);
        var cli = new NodeFileTools(paths);
        var target = Path.Combine(temp.Path, "target.txt");
        var link = Path.Combine(temp.Path, "link.txt");
        await File.WriteAllTextAsync(target, "unchanged");
        File.CreateSymbolicLink(link, target);
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            cli.Execute(
                "apply_patch",
                new JsonObject
                {
                    ["input"] =
                        "*** Begin Patch\n*** Add File: first.txt\n+first-without-newline\n*** Update File: missing.txt\n-old\n+new\n*** Add File: never.txt\n+never\n*** End Patch",
                },
                "main",
                temp.Path,
                false
            )
        );
        Assert.Equal(
            "first-without-newline",
            await File.ReadAllTextAsync(Path.Combine(temp.Path, "first.txt"))
        );
        Assert.False(File.Exists(Path.Combine(temp.Path, "never.txt")));
        Assert.Contains(
            "Operations already applied (these changes are already on disk):",
            error.Message
        );
        Assert.Contains("1 remaining operation(s) were not applied.", error.Message);
        var receipt = await new NodeFileTransfer(paths).Write(
            link,
            "main",
            Convert.ToBase64String("replacement"u8),
            true,
            false
        );
        Assert.Null(new FileInfo(link).LinkTarget);
        Assert.Equal("unchanged", await File.ReadAllTextAsync(target));
        Assert.Equal("replacement", await File.ReadAllTextAsync(link));
        Assert.True(receipt["overwritten"]!.GetValue<bool>());
    }

    [Fact]
    public void Environment_proxy_precedence_bypass_and_presentation_do_not_add_platform_defaults()
    {
        var environment = new Dictionary<string, string>
        {
            ["http_proxy"] = "http://lower:password@proxy.invalid:3128",
            ["HTTP_PROXY"] = "http://upper.invalid",
            ["ALL_PROXY"] = "http://all.invalid",
            ["no_proxy"] = ".internal:80,exact.invalid,*suffix.invalid",
        };
        string? Env(string key) => environment.GetValueOrDefault(key);
        Assert.Equal(
            "proxy.invalid",
            MasterProxy.Resolve(new Uri("ws://public.invalid/node_ws"), Env)!.Host
        );
        Assert.DoesNotContain(
            "password",
            MasterProxy.Safe(MasterProxy.Resolve(new Uri("ws://public.invalid"), Env)!)
        );
        Assert.Null(MasterProxy.Resolve(new Uri("ws://service.internal"), Env));
        Assert.Null(MasterProxy.Resolve(new Uri("ws://exact.invalid"), Env));
        Assert.Equal(
            "proxy.invalid",
            MasterProxy.Resolve(new Uri("ws://service.internal:81"), Env)!.Host
        );
        environment["npm_config_http_proxy"] = "http://npm.invalid";
        Assert.Equal("npm.invalid", MasterProxy.Resolve(new Uri("ws://public.invalid"), Env)!.Host);
        environment.Clear();
        Assert.Null(MasterProxy.Resolve(new Uri("wss://public.invalid"), Env));
    }
}
