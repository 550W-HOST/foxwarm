using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ExecParallelTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static readonly ResponsesClientOptions Options = new(
        new Uri("http://127.0.0.1:1"),
        "wire",
        "a",
        "",
        "",
        713
    );

    private static JsonObject Call(string id) =>
        new()
        {
            ["id"] = id,
            ["name"] = "exec",
            ["args"] = new JsonObject { ["command"] = id },
        };

    [Fact]
    public async Task Actual_session_executor_keeps_async_call_attribution_independent_and_tool_activity_until_last_invocation_settles()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "calls", null, null);
        await using var mcp = new Foxwarm.McpClient(data);
        var registry = new ToolRegistry(mcp, _ => work);
        var releases = new ConcurrentDictionary<string, TaskCompletionSource>();
        var starts = new ConcurrentDictionary<string, TaskCompletionSource>();
        foreach (var id in new[] { "first", "second" })
        {
            releases[id] = Signal();
            starts[id] = Signal();
        }
        registry.Register(
            new JsonObject { ["name"] = "exec" },
            "node",
            true,
            async (current, args, _) =>
            {
                var expected = args["command"]!.GetValue<string>();
                Assert.Equal(expected, current.CurrentCallId);
                Assert.Null(current.DirectExecWorkspace);
                Assert.Equal(work, current.Files!.ToolDirectory);
                starts[expected].SetResult();
                await releases[expected].Task;
                Assert.Equal(expected, current.CurrentCallId);
                return new JsonObject { ["output"] = expected };
            }
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        tools.BeginTurn();
        using (tools.CaptureDirectExecSegment())
        {
            var first = tools.ExecuteAttributedAsync(Call("first"), CancellationToken.None);
            var second = tools.ExecuteAttributedAsync(Call("second"), CancellationToken.None);
            await Task.WhenAll(starts.Values.Select(value => value.Task));
            Assert.True(owner.ToolActive);
            Assert.Equal("", tools.CurrentCallId);
            releases["second"].SetResult();
            var secondResult = await second;
            Assert.Equal("second", secondResult.Response["output"]!.GetValue<string>());
            Assert.NotNull(secondResult.Timing);
            Assert.True(owner.ToolActive);
            Assert.False(first.IsCompleted);
            releases["first"].SetResult();
            var firstResult = await first;
            Assert.Equal("first", firstResult.Response["output"]!.GetValue<string>());
            Assert.NotNull(firstResult.Timing);
            Assert.False(owner.ToolActive);
            Assert.Equal("", tools.CurrentCallId);
        }
        Assert.Null(tools.DirectExecWorkspace);
    }

    [Fact]
    public async Task Unauthorized_call_has_no_start_attribution_timing_or_activity_and_invocation_failure_settles_its_own_counter()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "calls", null, null);
        await using var mcp = new Foxwarm.McpClient(data);
        var registry = new ToolRegistry(mcp, _ => work);
        var effects = 0;
        registry.Register(
            new JsonObject { ["name"] = "exec" },
            "node",
            true,
            (current, _, _) =>
            {
                Assert.Equal("failed", current.CurrentCallId);
                effects++;
                throw new IOException("Ordinary invocation failure.");
            }
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        tools.BeginTurn();
        await manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny"),
            CancellationToken.None
        );
        var denied = await tools.ExecuteAttributedAsync(Call("denied"), CancellationToken.None);
        Assert.Null(denied.Timing);
        Assert.False(owner.ToolActive);
        Assert.Equal(0, effects);
        await manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes("version: 1"),
            CancellationToken.None
        );
        var failed = await tools.ExecuteAttributedAsync(Call("failed"), CancellationToken.None);
        Assert.NotNull(failed.Timing);
        Assert.False(owner.ToolActive);
        Assert.Equal(1, effects);
        Assert.False(tools.PolicyUnavailable);
        Assert.Equal("", tools.CurrentCallId);
    }
}
