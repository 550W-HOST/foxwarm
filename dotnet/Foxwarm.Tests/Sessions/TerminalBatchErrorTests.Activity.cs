using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed partial class TerminalBatchErrorTests
{
    [Fact]
    public async Task Tool_activity_tracks_actual_dispatch_and_Stop_settles_the_complete_batch()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) =>
                await Respond(
                    stream,
                    new JsonArray(
                        Call("first", "read", new() { ["filePath"] = "input.txt" }),
                        Call("exec-a", "exec", new() { ["command"] = "sleep 1" }),
                        Call("exec-b", "exec", new() { ["command"] = "sleep 1" }),
                        Call("unstarted", "read", new() { ["filePath"] = "input.txt" })
                    )
                )
        );
        await using var f = await ScriptFixture.Create(suppliedOptions: Options(peer.BaseUri));
        Directory.CreateDirectory(f.Work);
        await File.WriteAllTextAsync(Path.Combine(f.Work, "input.txt"), "first result");
        var activity = new ConcurrentQueue<JsonObject>();
        var bothStarted = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        f.Owner.Changed += entry =>
        {
            if (
                entry.Data is not JsonObject data
                || SessionWait.Text(data["type"]) != "tool-call-state"
            )
                return;
            activity.Enqueue(data);
            var snapshot = f.Owner.ToolCallActivitySnapshot();
            if (snapshot["runningCallIds"]!.AsArray().Count == 2)
                bothStarted.TrySetResult(snapshot);
        };
        await f.Owner.Entry.SaveLane.AdmitAsync(QueueItem.UserText("run batch"), SaveKind.Strict);
        var processing = f.Owner.Registry.Runner.ProcessQueueAsync(f.Owner.Id);
        var running = await bothStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(
            new[] { "exec-a", "exec-b" },
            running["runningCallIds"]!.AsArray().Select(id => id!.ToString()).Order()
        );
        Assert.DoesNotContain(f.Owner.History(), row => SessionWait.Text(row["role"]) == "tool");
        await f.Owner.Registry.Control.StopAsync(f.Owner.Id);
        await processing.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Empty(f.Owner.ToolCallActivitySnapshot()["runningCallIds"]!.AsArray());
        var events = activity.ToArray();
        Assert.Equal(6, events.Length);
        Assert.Equal(
            Enumerable.Range(1, 6).Select(i => (long)i),
            events.Select(e => e["sequence"]!.GetValue<long>())
        );
        Assert.Equal("first", events[0]["callId"]!.ToString());
        Assert.Equal("running", events[0]["status"]!.ToString());
        Assert.Equal("first", events[1]["callId"]!.ToString());
        Assert.Equal("finished", events[1]["status"]!.ToString());
        Assert.DoesNotContain(events, e => e["callId"]!.ToString() == "unstarted");
        var result = Assert.Single(
            f.Owner.History(),
            row => SessionWait.Text(row["role"]) == "tool"
        );
        Assert.Equal(4, result["parts"]!.AsArray().Count);
        Assert.Contains("first result", result.ToJsonString());
        Assert.Equal(
            "tool_call_cancelled",
            result["parts"]![3]!["functionResponse"]!["response"]!["error"]!["type"]!.ToString()
        );
    }
}
