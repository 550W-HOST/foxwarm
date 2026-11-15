using System.Text.Json.Nodes;
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
                ActivityIndexTests.Call("second", "exec", new JsonObject { ["command"] = "true" }),
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
}
