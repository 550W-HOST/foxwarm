using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task First_launch_recovery_preserves_valid_new_authority_and_explicitly_continues_known_input(
        bool consumed
    )
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(startHttpServer: !consumed);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var path = Path.Combine(f.Main.Data, "state", "sessions", "external.json");
        string? crashAuthority = null;
        async Task CaptureAsync()
        {
            crashAuthority = await File.ReadAllTextAsync(path);
            SessionAuthorityDocument.Parse(crashAuthority, f.Owner.Id);
            entered.TrySetResult();
            await release.Task;
        }
        if (consumed)
        {
            // Main has not started its HTTP listener yet: a real preflight failure follows queue consumption.
            f.Owner.Registry.OnTurnFailure = async (_, _) => await CaptureAsync();
        }
        else
            f.Owner.Registry.OnTurnStarting = async _ =>
            {
                await CaptureAsync();
                throw new SessionTurnShutdownException();
            };
        var running = f.RunAsync("known unsubmitted first input");
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var raw = JsonNode.Parse(crashAuthority!)!;
            Assert.True(raw["busy"]!.GetValue<bool>());
            Assert.Equal("new", raw["externalRuntime"]!["status"]!.GetValue<string>());
            Assert.Null(raw["externalRuntime"]!["sessionId"]);
            f.Main.Manager.BeginShutdown();
        }
        finally
        {
            release.TrySetResult();
        }
        await running;
        await f.Main.Manager.ShutdownAsync();
        await File.WriteAllTextAsync(path, crashAuthority!);
        await using var reopened = new SessionManager(
            f.Main.Data,
            f.Main.Work,
            new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "", "", "", 100),
            new ModelConfiguration(f.Main.Data).Models
        );
        await reopened.LoadMainHostAsync();
        var owner = await reopened.RequiredAsync("external");
        Assert.False(owner.Metadata().Busy);
        Assert.Equal(
            "new",
            owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
        Assert.Null(owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["sessionId"]);
        Assert.True(owner.BuildDto()["externalRuntime"]!["canContinue"]!.GetValue<bool>());
        Assert.Equal(consumed ? 0 : 1, owner.Entry.Snapshot().Queue.Count);
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "inputs.jsonl")));
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var server = new HttpServer(
            [],
            0,
            InboundMcpFixture.Admin,
            null,
            reopened,
            f.Main.Terminals,
            webUiEnabled: false
        );
        try
        {
            await server.App.StartAsync();
            await new SessionRuntime(reopened).ContinueAsync(owner.Id);
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.Single(f.Lines("inputs.jsonl"));
            Assert.False(f.Lines("inputs.jsonl")[0]["resumed"]!.GetValue<bool>());
            Assert.Contains(
                "known unsubmitted first input",
                f.Lines("inputs.jsonl")[0]["input"]!.ToJsonString()
            );
            Assert.Equal(
                "complete",
                owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                    "status"
                ]!.GetValue<string>()
            );
        }
        finally
        {
            await server.InboundMcp.DisposeAsync();
            await server.App.StopAsync();
            await server.App.DisposeAsync();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Fatal_policy_unavailability_retires_the_foreground_and_leaves_a_queued_successor_unconsumed(
        bool queuedSuccessor
    )
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        JsonObject Write(string filename) =>
            new()
            {
                ["args"] = new JsonObject
                {
                    ["toolId"] = "node:master/write",
                    ["args"] = new JsonObject
                    {
                        ["filePath"] = Path.Combine(f.PeerDirectory, filename),
                        ["content"] = "effect",
                    },
                },
            };
        await f.PeerAsync(
            new JsonObject
            {
                ["pauseBeforeCalls"] = true,
                ["pauseAfterFirstCall"] = true,
                ["calls"] = new JsonArray(Write("first-effect"), Write("second-effect")),
            }
        );
        var running = f.RunAsync();
        await f.WaitForFileAsync("before-calls");
        if (queuedSuccessor)
            await f.Owner.Registry.Ingress.EnqueueAsync(
                f.Owner.Id,
                QueueItem.UserText("later queued unit")
            );
        await File.WriteAllTextAsync(
            Path.Combine(f.Main.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules: null\n"
        );
        f.Main.Manager.Authorization.Invalidate();
        await File.WriteAllTextAsync(Path.Combine(f.PeerDirectory, "allow-calls"), "go");
        using var observation = new CancellationTokenSource();
        var firstReply = f.WaitForFileAsync("after-first-call", observation.Token);
        await Task.WhenAny(running, firstReply);
        await f.Main.PolicyAsync("version: 1\ndefaultAction: allow\n");
        await File.WriteAllTextAsync(Path.Combine(f.PeerDirectory, "policy-restored"), "go");
        observation.Cancel();
        try
        {
            await firstReply;
        }
        catch (OperationCanceledException) { }
        await running;
        Assert.IsType<ToolAuthorizationUnavailableException>(
            f.Owner.Entry.LastBackgroundProcessorFailure
        );
        Assert.True(f.Owner.Registry.HostFor(f.Owner.Id).RuntimeTools.PolicyUnavailable);
        Assert.False(f.Owner.Entry.HasProcessor);
        Assert.Equal(
            "interrupted",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
        Assert.Single(f.Lines("inputs.jsonl"));
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "first-effect")));
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "second-effect")));
        Assert.Equal(queuedSuccessor ? 1 : 0, f.Owner.Entry.Snapshot().Queue.Count);
        var token = f.Lines("inputs.jsonl")[0]["token"]!.GetValue<string>();
        await AssertRevokedAsync(f, token);
        var history = f.Owner.Entry.Snapshot().History.Materialize();
        Assert.Contains(
            history,
            row =>
                SessionWait.Text(row["role"]) == "tool"
                && row.ToJsonString().Contains(ToolAuthorizationUnavailableException.Code)
        );
        Assert.DoesNotContain(history, row => row.ToJsonString().Contains("Hello"));
        if (queuedSuccessor)
        {
            await f.PeerAsync(new JsonObject { ["calls"] = new JsonArray(Write("second-effect")) });
            await new SessionRuntime(f.Main.Manager).ContinueAsync(f.Owner.Id);
            Assert.True(File.Exists(Path.Combine(f.PeerDirectory, "second-effect")));
            Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "first-effect")));
            Assert.Equal(2, f.Lines("inputs.jsonl").Length);
            Assert.Contains(
                "later queued unit",
                f.Lines("inputs.jsonl")[1]["input"]!.ToJsonString()
            );
        }
    }

    [Fact]
    public async Task Ordinary_policy_denial_is_a_nonfatal_tool_result()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(
            new JsonObject
            {
                ["calls"] = new JsonArray(
                    Call(
                        "write_memory",
                        new JsonObject { ["filePath"] = "denied.md", ["content"] = "no" }
                    )
                ),
            }
        );
        await f.Main.PolicyAsync("version: 1\ndefaultAction: deny\n");
        await f.RunAsync();
        Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.True(f.Lines("results.jsonl")[0]["result"]!["isError"]!.GetValue<bool>());
        Assert.Equal(
            "complete",
            f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                "status"
            ]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Root_exit_drains_inherited_pipes_without_losing_buffered_final_records(
        bool crash
    )
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(
            new JsonObject
            {
                ["descendant"] = true,
                ["crash"] = crash,
                ["exitAfterResult"] = true,
            }
        );
        await f.RunAsync("owned root exit").WaitAsync(TimeSpan.FromSeconds(8));
        Assert.False(f.Owner.Entry.HasProcessor);
        Assert.False(f.Owner.Metadata().Busy);
        var status = f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
            "status"
        ]!.GetValue<string>();
        Assert.Equal(crash ? "interrupted" : "complete", status);
        if (crash)
            Assert.IsType<ClaudeRuntimeException>(f.Owner.Entry.LastBackgroundProcessorFailure);
        else
        {
            Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
            Assert.Contains(
                f.Owner.Entry.Snapshot().History.Materialize(),
                row => row["parts"]!.ToJsonString().Contains("Hello")
            );
        }
        var pid = int.Parse(
            await File.ReadAllTextAsync(Path.Combine(f.PeerDirectory, "descendant.pid"))
        );
        var proc = "/proc/" + pid + "/stat";
        Assert.True(!File.Exists(proc) || (await File.ReadAllTextAsync(proc)).Split(' ')[2] == "Z");
        await AssertRevokedAsync(f, f.Lines("inputs.jsonl")[0]["token"]!.GetValue<string>());
    }
}
