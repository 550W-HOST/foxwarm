using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Oversized_remote_results_use_the_execution_Node_and_captured_cwd_for_complete_retrieval()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        await f.Owner.UpdateCwdAsync("opaque://root/selected");
        var content = string.Concat(Enumerable.Range(1, 5000).Select(i => $"entry-{i:D5}\n"));
        await f.Seed("selected/input.txt", Encoding.UTF8.GetBytes(content));
        foreach (var unified in new[] { false, true })
        {
            await f.Owner.UpdateCwdAsync("opaque://root/selected");
            var result = unified
                ? await f.Call(
                    "call_tool",
                    new JsonObject
                    {
                        ["toolId"] = "node:" + f.Node + "/read",
                        ["args"] = Args("input.txt"),
                    }
                )
                : await f.Call("read", Args("input.txt"));
            Success(result);
            Assert.Equal(f.Node, result["outputFullNode"]!.GetValue<string>());
            var path = result["outputFullPath"]!.GetValue<string>();
            Assert.StartsWith(".temp/tool-output/", path);
            var saved = await File.ReadAllTextAsync(f.FilePath("selected/" + path));
            Assert.StartsWith(content, saved);
            Assert.True(ToolResponseFormatting.Format(result).Length <= 40_000);
            var read = await f.Call(
                "read",
                new JsonObject
                {
                    ["filePath"] = path,
                    ["startLine"] = 5000,
                    ["endLine"] = 5000,
                }
            );
            Success(read);
            Assert.Contains("entry-05000", read["output"]!.GetValue<string>());
            var programmatic = await f.Call(
                "run_script",
                new JsonObject
                {
                    ["code"] =
                        "return len(call_tool('node:"
                        + f.Node
                        + "/read', {'filePath':"
                        + System.Text.Json.JsonSerializer.Serialize(path)
                        + "})['content'])",
                }
            );
            Success(programmatic);
            Assert.Equal(saved.Length, programmatic["result"]!.GetValue<int>());
        }
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "tool-output")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Main_produced_results_use_the_readable_Session_Node_for_Node_only_and_bound_callers(
        bool bound
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        await f.Owner.UpdateCwdAsync("opaque://root/selected");
        var content = string.Concat(Enumerable.Range(1, 5000).Select(i => $"entry-{i:D5}\n"));
        f.Registry.Register(
            new JsonObject { ["name"] = "large_result" },
            "builtin",
            false,
            (_, _, _) =>
                Task.FromResult(
                    new JsonObject { ["output"] = content, ["resultId"] = "node-readable" }
                )
        );
        if (bound)
            await f.Manager.SetAgentIsolationAsync(
                "main",
                f.Node,
                true,
                new JsonArray(
                    new JsonObject
                    {
                        ["effect"] = "allow",
                        ["source"] = "builtin",
                        ["tool"] = "large_result",
                    },
                    new JsonObject
                    {
                        ["effect"] = "allow",
                        ["source"] = "builtin",
                        ["tool"] = "node",
                    }
                )
            );
        else
        {
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "tool-authorization.yaml"),
                "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: { current: true }\n- action: allow\n  match: { tool: { source: builtin, name: large_result } }\n- action: allow\n  match: { tool: { source: builtin, name: node } }\n- action: allow\n  match: { tool: { source: builtin, name: run_script } }\n"
            );
            f.Manager.Authorization.Invalidate();
        }
        var result = await f.Call("large_result", new JsonObject());
        Success(result);
        Assert.Equal("node-readable", result["resultId"]!.GetValue<string>());
        Assert.Equal(f.Node, result["outputFullNode"]!.GetValue<string>());
        var path = result["outputFullPath"]!.GetValue<string>();
        Assert.Equal(content, await File.ReadAllTextAsync(f.FilePath("selected/" + path)));
        Assert.Contains("opaque://root/selected", result["output"]!.GetValue<string>());
        var deniedMain = await f.Call(
            "call_tool",
            new JsonObject { ["toolId"] = "node:master/read", ["args"] = Args(path) }
        );
        Assert.NotNull(deniedMain["error"]);
        var read = await f.Call(
            "read",
            new JsonObject
            {
                ["filePath"] = path,
                ["startLine"] = 5000,
                ["endLine"] = 5000,
            }
        );
        Success(read);
        Assert.Contains("entry-05000", read["output"]!.GetValue<string>());
        var nativeRead = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return len(call_tool('node:"
                    + f.Node
                    + "/read', {'filePath':"
                    + System.Text.Json.JsonSerializer.Serialize(path)
                    + "})['content'])",
            }
        );
        Success(nativeRead);
        Assert.Equal(content.Length, nativeRead["result"]!.GetValue<int>());
        var outer = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('builtin:large_result', {})" }
        );
        Success(outer);
        Assert.Equal(f.Node, outer["outputFullNode"]!.GetValue<string>());
        var completeOuter = await File.ReadAllTextAsync(
            f.FilePath("selected/" + outer["outputFullPath"]!.GetValue<string>())
        );
        Assert.StartsWith("--- return ---\n", completeOuter);
        Assert.Contains("entry-05000", completeOuter);
        Assert.Contains("node-readable", completeOuter);
        if (bound)
            Assert.NotNull(
                (
                    await f.Call(
                        "node",
                        new JsonObject { ["action"] = "select", ["nodeId"] = f.Node }
                    )
                )["error"]
            );
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "tool-output")));
    }

    [Fact]
    public async Task Remote_guard_storage_denial_preserves_the_completed_read_without_a_false_locator()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        await f.Seed("input.txt", Encoding.UTF8.GetBytes(new string('x', 50_000)));
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules:\n- action: deny\n  match: { tool: { source: node, name: write } }\n"
        );
        f.Manager.Authorization.Invalidate();
        var result = await f.Call("read", Args("input.txt"));
        Success(result);
        Assert.NotNull(result["toolOutputGuardError"]);
        Assert.Null(result["outputFullPath"]);
        Assert.DoesNotContain(
            await f.Requests(),
            call => call["request"]?["operation"]?.GetValue<string>() == "write"
        );
    }

    [Fact]
    public async Task Readable_Main_is_retained_when_the_selected_Node_has_no_write_capability()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, "fixture/readonly"));
        f.Registry.Register(
            new JsonObject { ["name"] = "large_result" },
            "builtin",
            false,
            (_, _, _) => Task.FromResult(new JsonObject { ["output"] = new string('x', 50_000) })
        );
        var result = await f.Call("large_result", new JsonObject());
        Success(result);
        Assert.Equal("master", result["outputFullNode"]!.GetValue<string>());
        Assert.True(File.Exists(result["outputFullPath"]!.GetValue<string>()));
        Assert.DoesNotContain(
            await f.Requests(),
            call => call["operation"]!.GetValue<string>() == "filesystem"
        );
    }

    [Fact]
    public async Task Unavailable_policy_after_the_tool_effect_does_not_route_around_the_failed_check()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        f.Registry.Register(
            new JsonObject { ["name"] = "large_result" },
            "builtin",
            false,
            async (_, _, _) =>
            {
                await File.WriteAllTextAsync(policy, "version: [invalid");
                f.Manager.Authorization.Invalidate();
                return new JsonObject
                {
                    ["output"] = new string('x', 50_000),
                    ["status"] = "effect-completed",
                };
            }
        );
        var result = await f.Call("large_result", new JsonObject());
        Success(result);
        Assert.Equal("effect-completed", result["status"]!.GetValue<string>());
        Assert.NotNull(result["toolOutputGuardError"]);
        Assert.Null(result["outputFullPath"]);
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "tool-output")));
        Assert.DoesNotContain(
            await f.Requests(),
            call => call["operation"]!.GetValue<string>() == "filesystem"
        );
    }
}
