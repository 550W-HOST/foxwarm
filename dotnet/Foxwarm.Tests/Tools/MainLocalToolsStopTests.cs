using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class MainLocalToolsTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Self_stop_retains_its_receipt_and_fences_later_batch_or_nested_work(
        bool nested
    )
    {
        await using var f = await Fixture.Create();
        var work = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        var skipped = Path.Combine(work, "after-self-stop");
        var stop = new JsonObject
        {
            ["id"] = "stop",
            ["name"] = "stop_session",
            ["args"] = new JsonObject { ["sessionId"] = f.Owner.Id },
        };
        var write = new JsonObject
        {
            ["id"] = "write",
            ["name"] = "write",
            ["args"] = new JsonObject { ["filePath"] = skipped, ["content"] = "forbidden" },
        };
        var calls = new[] { stop, write };
        if (nested)
            calls =
            [
                new JsonObject
                {
                    ["id"] = "script",
                    ["name"] = "run_script",
                    ["args"] = new JsonObject
                    {
                        ["code"] =
                            "receipt = call_tool('stop_session', {'sessionId': "
                            + JsonSerializer.Serialize(f.Owner.Id)
                            + "})\nprint('STOP_RECEIPT', receipt)\ncall_tool('write', {'filePath': "
                            + JsonSerializer.Serialize(skipped)
                            + ", 'content': 'forbidden'})\nreturn True\n",
                    },
                },
                write,
            ];
        var host = new LocalSessionTurnHost(
            f.Owner.Entry,
            f.Owner.Registry.Store,
            new StopCallsChat(calls),
            f.Tools
        );
        Assert.True(await host.TryClaimBusyAsync());
        Assert.IsAssignableFrom<OperationCanceledException>(
            await Record.ExceptionAsync(() => host.ChatAsync("self-stop"))
        );
        Assert.False(File.Exists(skipped));
        var row = Assert.Single(f.Owner.History(), row => row["role"]?.ToString() == "tool");
        var responses = row["parts"]!
            .AsArray()
            .Select(part => part!["functionResponse"]!)
            .ToArray();
        Assert.Equal(2, responses.Length);
        Assert.Equal(
            "tool_call_cancelled",
            responses[1]["response"]!["error"]!["type"]!.GetValue<string>()
        );
        Assert.True(responses[1]["response"]!["canceled"]!.GetValue<bool>());
        if (nested)
        {
            var outer = responses[0];
            Assert.Contains("STOP_RECEIPT", outer["response"]!["stdout"]!.GetValue<string>());
            Assert.Contains(f.Owner.Id, outer["response"]!["stdout"]!.GetValue<string>());
            var subcall = Assert.Single(outer["__meta"]!["toolScriptSubCalls"]!.AsArray());
            Assert.Equal("stop_session", subcall!["name"]!.GetValue<string>());
            Assert.Equal("completed", subcall["status"]!.GetValue<string>());
            Assert.Equal("failed", outer["response"]!["status"]!.GetValue<string>());
        }
        else
        {
            Assert.Null(responses[0]["response"]!["error"]);
            Assert.Contains(f.Owner.Id, responses[0]["response"]!["output"]!.GetValue<string>());
        }
        await host.FinalizeStoppedAsync();
        Assert.False(f.Owner.Entry.Snapshot().Stopping);
    }

    [Fact]
    public async Task Self_stop_does_not_fence_an_independent_owner_bound_script_timer()
    {
        await using var f = await Fixture.Create();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.Timers.BeforeDelivery = async _ =>
        {
            reached.TrySetResult();
            await release.Task;
        };
        f.Manager.Timers.Start();
        var path = Path.Combine(
            f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory,
            "timer-after-stop"
        );
        var timer = await f.Manager.ExecuteTimerToolAsync(
            f.Owner,
            "create_timer",
            new JsonObject
            {
                ["action"] = "toolscript",
                ["afterSeconds"] = .03,
                ["script"] = new JsonObject
                {
                    ["code"] = "return call_tool('write', args)",
                    ["args"] = new JsonObject { ["filePath"] = path, ["content"] = "independent" },
                },
            },
            default
        );
        Assert.Null(timer["error"]);
        var host = new LocalSessionTurnHost(
            f.Owner.Entry,
            f.Owner.Registry.Store,
            new StopCallsChat([
                new JsonObject
                {
                    ["id"] = "stop",
                    ["name"] = "stop_session",
                    ["args"] = new JsonObject { ["sessionId"] = f.Owner.Id },
                },
            ]),
            f.Tools
        );
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(await host.TryClaimBusyAsync());
            Assert.IsAssignableFrom<OperationCanceledException>(
                await Record.ExceptionAsync(() => host.ChatAsync("self-stop-with-timer"))
            );
            Assert.True(f.Owner.Entry.Snapshot().Stopping);
            release.TrySetResult();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var timerId = timer["timer"]!["id"]!.GetValue<string>();
            while (f.Manager.Timers.List(f.Owner.Id).Any(row => row?["id"]?.ToString() == timerId))
                await Task.Delay(10, deadline.Token);
            Assert.Equal("independent", await File.ReadAllTextAsync(path));
            Assert.True(f.Owner.Entry.Snapshot().Stopping);
            await host.FinalizeStoppedAsync();
        }
        finally
        {
            release.TrySetResult();
        }
    }

    private sealed class StopCallsChat(JsonObject[] calls) : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) =>
            Task.FromResult(
                new ChatResult(
                    new JsonObject
                    {
                        ["role"] = "model",
                        ["parts"] = new JsonArray(
                            calls
                                .Select(call =>
                                    (JsonNode)new JsonObject { ["functionCall"] = call.DeepClone() }
                                )
                                .ToArray()
                        ),
                    }
                )
            );
    }
}
