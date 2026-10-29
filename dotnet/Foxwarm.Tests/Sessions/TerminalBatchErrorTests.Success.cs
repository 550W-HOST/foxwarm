using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed partial class TerminalBatchErrorTests
{
    [Theory]
    [InlineData("wait")]
    [InlineData("finish")]
    public async Task Handled_script_errors_and_nonzero_exec_results_preserve_successful_terminal_controls(string after)
    {
        string targetId = "";
        await using var peer = new ScriptedResponsesSequenceServer(1, async (_, stream, _) =>
            await Respond(stream, new JsonArray(
                Call("handled", "run_script", new()
                {
                    ["code"] = "try:\n    call_tool('read', {'filePath':'missing.txt'})\nexcept Exception:\n    pass\nreturn {'error':'handled'}",
                }),
                Call("nonzero", "exec", new() { ["command"] = "exit 7" }),
                Call("terminal", "send_to_session", new()
                {
                    ["sessionId"] = targetId,
                    ["message"] = "delivered once",
                    ["afterSend"] = after,
                })
            )));
        await using var f = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        var target = await f.Manager.CreateNamedAsync("main", "recipient", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        targetId = target.Id;
        await f.Owner.Entry.SaveLane.AdmitAsync(QueueItem.UserText("send after handled results"), SaveKind.Strict);
        await f.Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, peer.RequestCount);
        Assert.Single(target.Entry.Snapshot().Queue);
        Assert.Equal(after == "wait", f.Owner.WaitSnapshot() is not null);
        var parts = f.Owner.History().Last()["parts"]!.AsArray();
        Assert.All(parts, part => Assert.Null(part!["functionResponse"]!["response"]!["error"]));
        var script = parts[0]!["functionResponse"]!["response"]!;
        Assert.Equal("completed", SessionWait.Text(script["status"]));
        Assert.NotNull(script["result"]!["error"]);
        Assert.Contains("Exit code: 7", parts[1]!.ToJsonString());
        Assert.False(SessionContinuation.IsIncomplete(f.Owner.History()));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Successful_waits_coalesce_and_a_reply_queued_before_arming_is_consumed(bool fastReply)
    {
        string[] targetIds = [];
        ScriptFixture f = null!;
        await using var peer = new ScriptedResponsesSequenceServer(fastReply ? 2 : 1, async (index, stream, request) =>
        {
            if (index == 1)
            {
                Assert.Contains("fast queued reply", request.Body);
                Assert.Null(f.Owner.WaitSnapshot());
            }
            await Respond(stream, index == 1 ? new JsonArray(Final()) : new JsonArray(targetIds.Select((id, i) =>
                (JsonNode)Call("send-" + i, "send_to_session", new()
                {
                    ["sessionId"] = id,
                    ["message"] = "coalesced handoff",
                    ["afterSend"] = "wait",
                })).ToArray()));
        });
        await using var fixture = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        f = fixture;
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        targetIds = [first.Id, second.Id];
        first.Registry.TriggerOverride = _ => Task.CompletedTask;
        second.Registry.TriggerOverride = _ =>
        {
            if (fastReply)
            {
                Assert.Null(f.Owner.WaitSnapshot());
                // Settle the real reverse delivery before the sender can arm its batch wait.
                f.Manager.SendAsync(second, f.Owner.Id, "fast queued reply").WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
            }
            return Task.CompletedTask;
        };
        f.Owner.Registry.TriggerOverride = _ => f.Owner.StartProcessing();
        await f.Owner.Entry.SaveLane.AdmitAsync(QueueItem.UserText("hand off both"), SaveKind.Strict);
        await f.Owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(10));
        await f.Owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(fastReply ? 2 : 1, peer.RequestCount);
        if (!fastReply)
            Assert.Equal(targetIds, SessionWait.Strings(f.Owner.WaitSnapshot()!["waitAnySessions"]));
        Assert.Single(first.Entry.Snapshot().Queue);
        Assert.Single(second.Entry.Snapshot().Queue);
        Assert.Equal(!fastReply, f.Owner.WaitSnapshot() is not null);
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
    }

    [Theory]
    [InlineData("wait")]
    [InlineData("finish")]
    public async Task Stop_after_suppressed_handoff_leaves_the_paired_exchange_available_to_Continue(string after)
    {
        string targetId = "";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(3, async (index, stream, _) =>
        {
            if (index == 1)
            {
                entered.TrySetResult();
                await release.Task;
                return;
            }
            await Respond(stream, index == 2 ? new JsonArray(Final()) : new JsonArray(
                Call("terminal", "send_to_session", new()
                {
                    ["sessionId"] = targetId,
                    ["message"] = "once before Stop",
                    ["afterSend"] = after,
                }),
                Call("failure", "read", new() { ["filePath"] = "missing.txt" })
            ));
        });
        await using var f = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        var target = await f.Manager.CreateNamedAsync("main", "recipient", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        targetId = target.Id;
        try
        {
            await f.Owner.Entry.SaveLane.AdmitAsync(QueueItem.UserText("continue errors"), SaveKind.Strict);
            var turn = f.Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await f.Owner.Registry.Control.StopAsync(f.Owner.Id).WaitAsync(TimeSpan.FromSeconds(10));
            release.TrySetResult();
            await turn.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(SessionContinuation.IsIncomplete(f.Owner.History()));
            Assert.Null(f.Owner.WaitSnapshot());
            Assert.Single(target.Entry.Snapshot().Queue);
            await new SessionRuntime(f.Manager).ContinueAsync(f.Owner.Id).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(3, peer.RequestCount);
            Assert.False(SessionContinuation.IsIncomplete(f.Owner.History()));
            Assert.Single(target.Entry.Snapshot().Queue);
        }
        finally
        {
            release.TrySetResult();
        }
    }
}
