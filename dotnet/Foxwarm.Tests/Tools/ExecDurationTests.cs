using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ExecDurationTests
{
    [Theory]
    [InlineData(250, "250ms")]
    [InlineData(1000, "1s")]
    [InlineData(62125, "1m 2.1s")]
    [InlineData(3600050, "1h 0.1s")]
    [InlineData(-1, null)]
    public void Formats_actual_process_milliseconds(double elapsed, string? expected) =>
        Assert.Equal(expected, ExecDuration.Format(elapsed));

    [Fact]
    public async Task Real_foreground_process_reports_subsecond_duration_and_wrapper_finish_not_detection_time()
    {
        using var temp = new TempDirectory();
        await using var exec = new LocalExecManager(
            temp.Path,
            _ => temp.Path,
            (_, _, _) => Task.CompletedTask
        );
        var execution = exec.ExecuteAsync(
            "owner",
            new JsonObject { ["command"] = "sleep 0.2; printf done" },
            default
        );
        while (!File.Exists(Path.Combine(temp.Path, "state", "running-exec.json"))) await Task.Delay(5);
        var meta = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(temp.Path, "state", "running-exec.json")))!["execs"]![0]!;
        var result = await execution;
        var output = result["output"]!.GetValue<string>();
        var match = Regex.Match(output, @"Duration: (\d+)ms");
        Assert.True(match.Success, output);
        Assert.InRange(int.Parse(match.Groups[1].Value), 180, 950);
        var status = JsonNode.Parse(await File.ReadAllTextAsync(meta["statusPath"]!.GetValue<string>()))!;
        var measured =
            DateTimeOffset.Parse(status["finishedAt"]!.GetValue<string>()).ToUnixTimeMilliseconds()
            - meta["startedAt"]!.GetValue<long>();
        Assert.Equal(int.Parse(match.Groups[1].Value), measured);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_background_and_recovered_completion_have_elapsed_or_truthful_unknown_duration(
        bool missingStatus
    )
    {
        using var temp = new TempDirectory();
        var completion = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await using var first = new LocalExecManager(
            temp.Path,
            _ => temp.Path,
            (_, _, _) => Task.CompletedTask
        );
        var result = await first.ExecuteAsync(
            "owner",
            new JsonObject
            {
                ["command"] = missingStatus
                    ? "sleep 1.4; kill -KILL $$"
                    : "sleep 1.4; printf background",
                ["timeout"] = 1.0,
            },
            default
        );
        Assert.Contains("Elapsed: ", result["output"]!.GetValue<string>());
        Assert.DoesNotContain("Elapsed: unknown", result["output"]!.GetValue<string>());
        // Restart uses real persisted process ownership; no guessed finish time on SIGKILL.
        await first.DisposeAsync();
        await using var recovered = new LocalExecManager(
            temp.Path,
            _ => temp.Path,
            (_, _, message) =>
            {
                completion.TrySetResult(message);
                return Task.CompletedTask;
            }
        );
        await recovered.InitializeAsync(_ => true);
        var message = await completion.Task.WaitAsync(TimeSpan.FromSeconds(8));
        if (missingStatus)
            Assert.Contains("Duration: unknown", message);
        else
            Assert.Matches(@"Duration: 1\.[4-9]s", message);
    }
}
