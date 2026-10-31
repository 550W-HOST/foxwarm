using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Theory]
    [InlineData("malformed")]
    [InlineData("plugins")]
    [InlineData("extraTool")]
    [InlineData("partialCrash")]
    public async Task Invalid_protocol_and_observable_configuration_conflicts_interrupt_without_replay_or_late_publication(
        string fault
    )
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(
            new JsonObject { [fault] = true }
        );
        await f.RunAsync();
        Assert.NotNull(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(
            "interrupted",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
        await AssertRevokedAsync(f, f.Lines("inputs.jsonl")[0]["token"]!.GetValue<string>());
        Assert.Empty(f.Owner.DraftSnapshot());
        Assert.Empty(Directory.GetDirectories(Path.Combine(f.Main.Data, "state", "runtime-runs")));
        var history = f.Owner.Entry.Snapshot().History.Materialize();
        Assert.DoesNotContain(history, row => SessionWait.Text(row["role"]) == "tool");
        if (fault == "partialCrash")
        {
            var partial = Assert.Single(
                history,
                row => row["__meta"]?["runtimePartial"]?.GetValue<bool>() == true
            );
            Assert.Equal("Hello 🦊", partial["parts"]![0]!["text"]!.GetValue<string>());
        }
        else
            Assert.DoesNotContain(
                history,
                row => SessionWait.Text(row["__meta"]?["runtime"]) == "claude-code"
            );
    }

    [Fact]
    public async Task Missing_transcript_requires_restore_or_Clear_and_never_silently_starts_fresh()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        await f.RunAsync();
        var transcript = f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
            "transcript"
        ]!.GetValue<string>();
        File.Delete(transcript);
        await f.RunAsync("must stay in Main history");
        Assert.IsType<ClaudeRuntimeException>(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Single(f.Lines("inputs.jsonl"));
        Assert.Contains(
            f.Owner.Entry.Snapshot().History.Materialize(),
            row =>
                row["parts"]!
                    .AsArray()
                    .Any(part =>
                        SessionWait
                            .Text(part?["text"])
                            ?.Contains("must stay in Main history", StringComparison.Ordinal)
                        == true
                    )
        );
        Assert.True((await f.Main.Manager.ClearAsync(f.Owner)).Cleared);
        await f.RunAsync("new context");
        Assert.Equal(2, f.Lines("inputs.jsonl").Length);
        Assert.False(f.Lines("inputs.jsonl")[1]["resumed"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Main_owned_background_Exec_outlives_CLI_Stop_and_keeps_its_normal_completion()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var output = Path.Combine(f.Main.Work, "background-effect");
        await f.PeerAsync(
            new JsonObject
            {
                ["hold"] = true,
                ["calls"] = new JsonArray(
                    NodeCall(
                        "exec",
                        new JsonObject
                        {
                            ["command"] = "sleep 2; printf completed > '" + output + "'",
                            ["timeout"] = 1,
                        }
                    )
                ),
            }
        );
        var running = f.RunAsync();
        await f.ReadyAsync();
        await new SessionRuntime(f.Main.Manager).StopAsync(f.Owner.Id);
        await running;
        var completed = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        using var watcher = new FileSystemWatcher(f.Main.Work, "background-effect")
        {
            EnableRaisingEvents = true,
        };
        void Check()
        {
            if (File.Exists(output) && new FileInfo(output).Length == 9)
                completed.TrySetResult();
        }
        watcher.Created += (_, _) => Check();
        watcher.Changed += (_, _) => Check();
        Check();
        if (!completed.Task.IsCompleted)
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("completed", await File.ReadAllTextAsync(output));
        Assert.Single(f.Lines("inputs.jsonl"));
        Assert.Equal(
            "interrupted",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Known_pre_submission_launcher_failure_retains_unsent_input_for_an_explicit_retry()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var path = Environment.GetEnvironmentVariable("PATH");
        var emptyBin = Path.Combine(f.Temp.Path, "empty-bin");
        Directory.CreateDirectory(emptyBin);
        try
        {
            Environment.SetEnvironmentVariable("PATH", emptyBin);
            await f.RunAsync("not submitted");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
        Assert.NotNull(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(
            "new",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "inputs.jsonl")));
        await new SessionRuntime(f.Main.Manager).ContinueAsync(f.Owner.Id);
        Assert.Single(f.Lines("inputs.jsonl"));
        Assert.Contains("not submitted", f.Lines("inputs.jsonl")[0]["input"]!.ToJsonString());
        Assert.Equal(
            "complete",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Native_EndConversation_and_empty_success_finish_without_business_tool_replay_or_another_model_loop()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(
            new JsonObject { ["empty"] = true }
        );
        await f.RunAsync();
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(
            "complete",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
        Assert.False(f.Owner.BuildDto()["externalRuntime"]!["canContinue"]!.GetValue<bool>());
        var history = f.Owner.Entry.Snapshot().History.Materialize();
        Assert.DoesNotContain(
            history,
            row =>
                SessionWait.Text(row["role"]) == "tool"
                || row["parts"]!.AsArray().Any(part => part?["functionCall"] is not null)
        );
        Assert.Single(f.Lines("inputs.jsonl"));
        await Assert.ThrowsAsync<SessionContinuationUnavailableException>(() =>
            new SessionRuntime(f.Main.Manager).ContinueAsync(f.Owner.Id)
        );
    }
}
