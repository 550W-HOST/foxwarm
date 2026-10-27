using System.Net;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    [Theory]
    [InlineData("", "unknown")]
    [InlineData("invalid", "unknown")]
    [InlineData("-1", "unknown")]
    [InlineData("1.5", "unknown")]
    [InlineData("9007199254740992", "unknown")]
    [InlineData("0", "<1s")]
    [InlineData("1", "~1s")]
    [InlineData("62", "~1m 2s")]
    public async Task Duration_comes_only_from_client_metadata_not_dispatch_or_report_latency(
        string elapsed,
        string expected
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var call = fixture.Exec();
        var task = await fixture.Poll();
        using var ack = await fixture.Report(task.Task, finished: true, elapsed: elapsed);
        Assert.Equal(HttpStatusCode.NoContent, ack.StatusCode);
        Assert.Contains("Duration: " + expected, (await call)!["output"]!.GetValue<string>());
    }

    [Fact]
    public async Task Background_elapsed_and_completion_duration_keep_the_actual_owner_and_strict_receipt()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "shell");
        var call = fixture.Exec(programmatic: true);
        var task = await fixture.Poll();
        using var background = await fixture.Report(task.Task, elapsed: "1");
        Assert.Equal(HttpStatusCode.NoContent, background.StatusCode);
        var running = (await call)!;
        Assert.Contains("Elapsed: ~1s", running["output"]!.GetValue<string>());
        Assert.Equal(task.Exec, running["execId"]!.GetValue<string>());
        Assert.Equal("running", running["status"]!.GetValue<string>());
        Assert.True(running["truncated"]!.GetValue<bool>());
        Assert.Null(running["content"]);
        await fixture.Manager.SelectNodeAsync(fixture.Owner, "master");
        using var completed = await fixture.Report(task.Task, finished: true, elapsed: "2");
        Assert.Equal(HttpStatusCode.NoContent, completed.StatusCode);
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(fixture.Data, "state", "sessions", fixture.Owner.Id + ".json")
            )
        )!;
        Assert.Contains("Duration: ~2s", persisted.ToJsonString());
        var wakes = fixture.Wakes;
        using var repeat = await fixture.Report(task.Task, finished: true, elapsed: "999");
        Assert.Equal(HttpStatusCode.NoContent, repeat.StatusCode);
        Assert.Equal(wakes, fixture.Wakes);
        Assert.DoesNotContain(
            "Duration: ~16m",
            (
                await File.ReadAllTextAsync(
                    Path.Combine(fixture.Data, "state", "sessions", fixture.Owner.Id + ".json")
                )
            )
        );
    }
}
