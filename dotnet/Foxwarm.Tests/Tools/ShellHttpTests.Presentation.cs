using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    private static SessionToolExecutor PresentationTools(Fixture fixture, Foxwarm.McpClient mcp)
    {
        var definitions = ToolScriptToolDefinitions.Definitions();
        foreach (var definition in WorkspaceTools.Definitions())
            definitions.Add(definition?.DeepClone());
        var work = Path.Combine(fixture.Temp.Path, "work");
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            _ => work,
            fixture.Manager.Nodes,
            fixture.Manager.NodeProviders
        );
        return new(new WorkspaceTools(work), fixture.Owner, fixture.Manager, registry);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Ordinary_foreground_direct_and_unified_calls_send_only_readable_output_to_the_model(
        bool powershell,
        bool unified
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start(register: !powershell);
        if (powershell)
        {
            using var registered = await fixture.Request(
                "register",
                Encoding.UTF8.GetBytes(@"C:\shell"),
                new() { ["X-Foxwarm-Shell-Dialect"] = "powershell" }
            );
            Assert.Equal(HttpStatusCode.NoContent, registered.StatusCode);
            fixture.Connection = registered.Headers.GetValues("X-Foxwarm-Connection").Single();
        }
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "shell");
        await using var mcp = new Foxwarm.McpClient(fixture.Data);
        var tools = PresentationTools(fixture, mcp);
        var args = new JsonObject { ["command"] = "echo sample" };
        var call = new JsonObject
        {
            ["id"] = "shell-result",
            ["name"] = unified ? "call_tool" : "exec",
            ["args"] = unified
                ? new JsonObject { ["toolId"] = "node:shell/exec", ["args"] = args }
                : args,
        };
        var execution = tools.ExecuteAsync(call, default);
        var task = await fixture.Poll();
        using var reported = await fixture.Report(
            task.Task,
            finished: true,
            sample: Encoding.UTF8.GetBytes("sample\n"),
            exit: "7",
            elapsed: "2"
        );
        Assert.Equal(HttpStatusCode.NoContent, reported.StatusCode);
        var result = Assert.IsType<JsonObject>(await execution);
        Assert.Equal("output", Assert.Single(result).Key);
        var output = result["output"]!.GetValue<string>();
        Assert.StartsWith("sample\n", output);
        Assert.Contains("Exit code: 7", output);
        Assert.Contains("Duration: ~2s", output);
        Assert.Contains("Total output bytes: 7", output);
        Assert.Equal(output, ToolResponseFormatting.Format(result));
        var history = new JsonObject[]
        {
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["functionCall"] = call }),
            },
            new()
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "shell-result",
                            ["name"] = unified ? "call_tool" : "exec",
                            ["response"] = result,
                        },
                    }
                ),
            },
        };
        var wire = ResponsesRequestSerializer.ConvertHistory(history, "a/wire");
        var reply = Assert.Single(
            wire.OfType<JsonObject>(),
            row => SessionWait.Text(row["type"]) == "function_call_output"
        );
        Assert.Equal(output, reply["output"]!.GetValue<string>());
        Assert.False(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, task.Exec));
        Assert.False(fixture.Manager.Nodes.SupportsExternal("shell"));
    }

    [Fact]
    public async Task ToolScript_nested_exec_keeps_structured_completion_and_raw_content()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "shell");
        await using var mcp = new Foxwarm.McpClient(fixture.Data);
        var tools = PresentationTools(fixture, mcp);
        var execution = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "run_script",
                ["args"] = new JsonObject
                {
                    ["code"] = "return call_tool('node:shell/exec', {'command': 'printf sample'})",
                },
            },
            default
        );
        var task = await fixture.Poll();
        const string content = "  sample\n\n";
        using var reported = await fixture.Report(
            task.Task,
            finished: true,
            sample: Encoding.UTF8.GetBytes(content),
            exit: "7"
        );
        Assert.Equal(HttpStatusCode.NoContent, reported.StatusCode);
        var script = (await execution)!;
        Assert.Null(script["error"]);
        Assert.Equal("completed", SessionWait.Text(script["status"]));
        var result = script["result"]!;
        Assert.Equal("completed", SessionWait.Text(result["status"]));
        Assert.Equal(task.Exec, SessionWait.Text(result["execId"]));
        Assert.Equal(7, result["exitCode"]!.GetValue<int>());
        Assert.Equal(Encoding.UTF8.GetByteCount(content), result["totalBytes"]!.GetValue<long>());
        Assert.Equal(Encoding.UTF8.GetByteCount(content), result["sizeBytes"]!.GetValue<long>());
        Assert.False(result["truncated"]!.GetValue<bool>());
        Assert.Equal(content, SessionWait.Text(result["content"]));
        Assert.Contains("Exit code: 7", SessionWait.Text(result["output"]));
        Assert.Null(result["logPath"]);
        Assert.False(fixture.Manager.Nodes.ExecClaims.Has(fixture.Owner, task.Exec));
    }
}
