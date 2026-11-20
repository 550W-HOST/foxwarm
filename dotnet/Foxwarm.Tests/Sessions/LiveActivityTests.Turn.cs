using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class LiveActivityTests
{
    [Fact]
    public async Task A_real_turn_shows_each_running_call_of_its_batch_and_the_latest_summary_between_requests()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return;
        await using var f = await ActivityIndexTests.Fixture.Create();
        // The test runs the turn itself instead of the queued-input processor.
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var observed = new List<(string? State, string? Call, string? Tool)>();
        f.Owner.Changed += item =>
        {
            if (item.Kind != SessionEventKind.StateChanged)
                return;
            var runtime = f.Owner.RuntimeSnapshot();
            observed.Add(
                (
                    SessionWait.Text(runtime["state"]),
                    SessionWait.Text(runtime["tool"]?["id"]),
                    SessionWait.Text(runtime["activity"]?["tool"])
                )
            );
        };
        await f.InputAsync(QueueItem.UserText("Run the batch"));
        await f.TurnAsync(
            [
                ActivityIndexTests.Call(
                    "first",
                    "exec",
                    new JsonObject { ["summary"] = "First command", ["command"] = "true" }
                ),
                // A non-exec call keeps the batch sequential; adjacent execs share a parallel segment.
                ActivityIndexTests.Call(
                    "second",
                    "write",
                    new JsonObject { ["filePath"] = "note.txt", ["content"] = "x" }
                ),
                ActivityIndexTests.Call(
                    "third",
                    "exec",
                    new JsonObject { ["summary"] = "Third command", ["command"] = "true" }
                ),
            ]
        );
        var running = observed
            .Where(item => item.State == "running-tool")
            .Select(item => (item.Call, item.Tool))
            .Distinct()
            .ToArray();
        Assert.Equal(
            new (string?, string?)[]
            {
                ("first", "First command"),
                ("second", "First command"),
                ("third", "Third command"),
            },
            running
        );
        // After the batch, the next request keeps the latest summary.
        Assert.Contains(observed, item => item.State == "requesting-model" && item.Tool == "Third command");
        Assert.DoesNotContain(f.Owner.History(), row => row.ToJsonString().Contains("\"activity\""));
    }

    [Fact]
    public async Task A_parallel_exec_segment_keeps_each_call_summary_and_the_latest_one_once_identity_is_gone()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return;
        await using var f = await ActivityIndexTests.Fixture.Create();
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var running = new List<(string? Call, string? Tool)>();
        f.Owner.Changed += item =>
        {
            if (item.Kind != SessionEventKind.StateChanged)
                return;
            var runtime = f.Owner.RuntimeSnapshot();
            if (SessionWait.Text(runtime["state"]) == "running-tool")
                lock (running)
                    running.Add(
                        (
                            SessionWait.Text(runtime["tool"]?["id"]),
                            SessionWait.Text(runtime["activity"]?["tool"])
                        )
                    );
        };
        await f.InputAsync(QueueItem.UserText("Run the segment"));
        await f.TurnAsync(
            [
                ActivityIndexTests.Call(
                    "first",
                    "exec",
                    new JsonObject { ["summary"] = "First command", ["command"] = "true" }
                ),
                ActivityIndexTests.Call("second", "exec", new JsonObject { ["command"] = "true" }),
                ActivityIndexTests.Call(
                    "third",
                    "exec",
                    new JsonObject { ["summary"] = "Third command", ["command"] = "true" }
                ),
            ]
        );
        // Concurrent members share one foreground projection. While a member runs as that
        // projection, the caption is its own position; after the last-started member ends while
        // others still run, the runtime has no tool identity and the caption is the latest summary.
        var expected = new Dictionary<string, string>
        {
            ["first"] = "First command",
            ["second"] = "First command",
            ["third"] = "Third command",
        };
        Assert.NotEmpty(running);
        Assert.All(
            running,
            item =>
                Assert.Equal(item.Call is { } call ? expected[call] : "Third command", item.Tool)
        );
    }
    [Fact]
    public async Task Preparing_the_next_request_is_already_a_request_that_keeps_the_latest_summary()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return;
        await using var f = await ActivityIndexTests.Fixture.Create();
        f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await f.InputAsync(QueueItem.UserText("Run one command"));
        var seen = new List<JsonObject>();
        var chat = new ProbeChat(
            new ActivityIndexTests.ScriptedChat(
                [
                    ActivityIndexTests.Call(
                        "first",
                        "exec",
                        new JsonObject { ["summary"] = "First command", ["command"] = "true" }
                    ),
                ]
            ),
            () => seen.Add(f.Owner.RuntimeSnapshot())
        );
        var host = new LocalSessionTurnHost(
            f.Owner.Entry,
            f.Owner.Registry.Store,
            new RequestChatService(chat, f.Owner),
            new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, f.Registry)
        );
        Assert.True(await host.TryClaimBusyAsync());
        await host.AppendQueuedInputsAsync(f.Owner.Entry.WithState(state => state.Queue.ToArray()));
        await host.ChatAsync("turn");
        await host.ReleaseBusyAsync();

        // The provider is reached only after preparation; by then each request is already published.
        Assert.Equal(2, seen.Count);
        Assert.All(
            seen,
            runtime =>
            {
                Assert.Equal("requesting-model", SessionWait.Text(runtime["state"]));
                Assert.Equal("normal-turn", SessionWait.Text(runtime["active"]?["phase"]));
            }
        );
        Assert.Null(seen[0]["activity"]);
        Assert.Equal("First command", SessionWait.Text(seen[1]["activity"]?["tool"]));
    }

    private sealed class ProbeChat(IChatService inner, Action probe) : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken cancellationToken
        )
        {
            probe();
            return inner.ChatAsync(sessionId, history, cancellationToken);
        }
    }
}
