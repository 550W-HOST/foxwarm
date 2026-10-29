using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class MainLocalToolsTests
{
    [Fact]
    public async Task Direct_unified_and_native_programmatic_consumers_keep_their_distinct_output_values()
    {
        await using var f = await Fixture.Create();
        var output = string.Concat(Enumerable.Range(1, 5000).Select(i => $"entry-{i:D5}\n"));
        var native = new JsonObject { ["output"] = output, ["resultId"] = "result-42" };
        f.Registry.Register(
            new JsonObject { ["name"] = "large_result" },
            "builtin",
            false,
            (_, _, _) => Task.FromResult((JsonObject)native.DeepClone())
        );
        foreach (var unified in new[] { false, true })
        {
            var result = unified
                ? await f.Call(
                    "call_tool",
                    new JsonObject
                    {
                        ["toolId"] = "builtin:large_result",
                        ["args"] = new JsonObject(),
                    }
                )
                : await f.Call("large_result", new JsonObject());
            Assert.Null(result["error"]);
            Assert.Equal("result-42", result["resultId"]!.GetValue<string>());
            Assert.Equal("master", result["outputFullNode"]!.GetValue<string>());
            Assert.True(ToolResponseFormatting.Format(result).Length <= 40_000);
            var path = result["outputFullPath"]!.GetValue<string>();
            Assert.Equal(output, await File.ReadAllTextAsync(path));
            var read = await f.Call(
                "call_tool",
                new JsonObject
                {
                    ["toolId"] = "node:master/read",
                    ["args"] = new JsonObject
                    {
                        ["filePath"] = path,
                        ["startLine"] = 5000,
                        ["endLine"] = 5000,
                    },
                }
            );
            Assert.Null(read["error"]);
            Assert.Contains("entry-05000", read["output"]!.GetValue<string>());
        }
        var script = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "value = call_tool('builtin:large_result', {})\nreturn {'length': len(value['output']), 'resultId': value['resultId'], 'guarded': 'outputTruncated' in value}",
            }
        );
        Assert.Null(script["error"]);
        Assert.Equal(output.Length, script["result"]!["length"]!.GetValue<int>());
        Assert.Equal("result-42", script["result"]!["resultId"]!.GetValue<string>());
        Assert.False(script["result"]!["guarded"]!.GetValue<bool>());
        var outer = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('builtin:large_result', {})" }
        );
        Assert.Null(outer["error"]);
        Assert.True(ToolResponseFormatting.FormatToolScriptExecution(outer).Length <= 40_000);
        var originalPresentation = await File.ReadAllTextAsync(
            outer["outputFullPath"]!.GetValue<string>()
        );
        Assert.StartsWith("--- return ---\n", originalPresentation);
        Assert.Contains("result-42", originalPresentation);
        Assert.Contains("entry-05000", originalPresentation);
        Assert.Equal(output, native["output"]!.GetValue<string>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Saving_failure_does_not_replace_the_completed_tool_status(bool toolFailed)
    {
        await using var f = await Fixture.Create();
        var root = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        await File.WriteAllTextAsync(Path.Combine(root, ".temp"), "not a directory");
        var effects = 0;
        f.Registry.Register(
            new JsonObject { ["name"] = "large_effect" },
            "builtin",
            false,
            (_, _, _) =>
            {
                effects++;
                return Task.FromResult(
                    new JsonObject
                    {
                        ["output"] = new string('x', 50_000),
                        ["status"] = "effect-completed",
                        ["error"] = toolFailed ? "original effect error" : null,
                    }
                );
            }
        );
        var result = await f.Call("large_effect", new JsonObject());
        Assert.Equal(1, effects);
        Assert.Equal(toolFailed, result["error"] is not null);
        Assert.Equal("effect-completed", result["status"]!.GetValue<string>());
        Assert.NotNull(result["toolOutputGuardError"]);
        Assert.Null(result["outputFullPath"]);
        Assert.True(ToolResponseFormatting.Format(result).Length <= 40_000);
    }
}
