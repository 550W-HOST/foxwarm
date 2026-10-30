using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Theory]
    [InlineData("stop")]
    [InlineData("move")]
    [InlineData("delete")]
    [InlineData("shutdown")]
    public async Task Reachable_lifecycle_revokes_before_return_and_drains_owned_child(string operation)
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(new JsonObject { ["hold"] = true, ["descendant"] = true });
        var running = f.RunAsync();
        await f.ReadyAsync();
        var token = f.Lines("inputs.jsonl")[0]["token"]!.GetValue<string>();
        Assert.NotNull(f.Main.Manager.RuntimeCredentials.Authenticate(token[7..]));
        // The one-second credential renews while the same foreground run remains live.
        await Task.Delay(1600);
        Assert.NotNull(f.Main.Manager.RuntimeCredentials.Authenticate(token[7..]));
        if (operation == "stop") await new SessionRuntime(f.Main.Manager).StopAsync(f.Owner.Id);
        if (operation == "move") await f.Main.Manager.MoveIdentityAsync(f.Main.Target, new JsonObject { ["sessionId"] = f.Owner.Id, ["newSessionId"] = "renamed" });
        if (operation == "delete")
        {
            var result = await f.Main.Manager.DeleteAsync(f.Owner.Id);
            Assert.Equal("busy", result["status"]!.GetValue<string>());
        }
        if (operation == "shutdown") await f.Main.Manager.ShutdownAsync();
        await running;
        await AssertRevokedAsync(f, token);
        Assert.False(f.Owner.Processing);
        var childPid = int.Parse(await File.ReadAllTextAsync(Path.Combine(f.Cwd, "descendant.pid")));
        if (File.Exists($"/proc/{childPid}/stat")) Assert.Contains(") Z ", await File.ReadAllTextAsync($"/proc/{childPid}/stat"));
        Assert.Equal("interrupted", f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["status"]!.GetValue<string>());
        Assert.Empty(Directory.GetDirectories(Path.Combine(f.Main.Data, "state", "runtime-runs")));
        if (operation == "move") Assert.Equal("renamed", f.Owner.Id);
        if (operation == "delete")
        {
            await f.Main.Manager.DeleteAsync(f.Owner.Id);
            Assert.Null(f.Main.Manager.Find(f.Owner.Id));
        }
    }

    [Fact]
    public async Task Crash_preserves_unaccepted_queue_and_Continue_sends_new_input_without_unknown_replay()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(new JsonObject { ["crash"] = true });
        await f.RunAsync("unknown input");
        Assert.NotNull(f.Owner.Entry.LastBackgroundProcessorFailure);
        var first = f.Lines("inputs.jsonl")[0];
        Assert.Equal("interrupted", f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["status"]!.GetValue<string>());
        await AssertRevokedAsync(f, first["token"]!.GetValue<string>());
        await f.PeerAsync(new JsonObject());
        await new SessionRuntime(f.Main.Manager).ContinueAsync(f.Owner.Id);
        var continued = f.Lines("inputs.jsonl")[1];
        Assert.True(continued["resumed"]!.GetValue<bool>());
        Assert.DoesNotContain("unknown input", continued["input"]!.ToJsonString());
        Assert.Contains("Continue from the existing conversation", continued["input"]!.ToJsonString());
        Assert.Equal("complete", f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["status"]!.GetValue<string>());
        await Assert.ThrowsAsync<SessionContinuationUnavailableException>(() => new SessionRuntime(f.Main.Manager).ContinueAsync(f.Owner.Id));
        await File.WriteAllTextAsync(Path.Combine(f.Cwd, "peer.json"), "{\"hold\":true}");
        File.Delete(Path.Combine(f.Cwd, "ready"));
        var running = f.RunAsync("held");
        await f.ReadyAsync();
        await f.Owner.Registry.Ingress.EnqueueAsync(f.Owner.Id, QueueItem.UserText("later input"));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        await new SessionRuntime(f.Main.Manager).StopAsync(f.Owner.Id);
        await running;
        // Stop's ordinary finalization appends queued input to Main history; no second CLI input was sent.
        Assert.Equal(3, f.Lines("inputs.jsonl").Length);
        var clear = await f.Main.Manager.ClearAsync(f.Owner);
        Assert.True(clear.Cleared);
        Assert.Equal("new", f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task Startup_recovery_does_not_replay_unknown_input_and_old_process_credentials_do_not_return()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(new JsonObject { ["hold"] = true });
        var running = f.RunAsync("unknown before shutdown");
        await f.ReadyAsync();
        await f.Owner.Registry.Ingress.EnqueueAsync(f.Owner.Id, QueueItem.UserText("still in Main queue"));
        var token = f.Lines("inputs.jsonl")[0]["token"]!.GetValue<string>();
        await f.Main.Manager.ShutdownAsync();
        await running;
        Assert.True(f.Owner.Entry.Snapshot().Busy); // lifecycle interruption retains the existing busy checkpoint
        await using var reopened = new SessionManager(f.Main.Data, f.Main.Work, new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "", "", "", 100), new ModelConfiguration(f.Main.Data).Models);
        await reopened.LoadMainHostAsync();
        var owner = await reopened.RequiredAsync("external");
        Assert.False(owner.Metadata().Busy);
        Assert.Single(owner.Entry.Snapshot().Queue);
        Assert.Equal("interrupted", owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["status"]!.GetValue<string>());
        Assert.Null(reopened.RuntimeCredentials.Authenticate(token[7..]));
        Assert.Single(f.Lines("inputs.jsonl"));
    }

    [Fact]
    public async Task Credentials_are_process_local_exact_owner_run_and_renewable_only_while_current()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var now = DateTimeOffset.UtcNow;
        var current = true;
        var store = new SessionRuntimeCredentialStore(() => now);
        var first = store.Issue(f.Owner, TimeSpan.FromHours(1), () => current);
        Assert.Null(store.Authenticate("wrong"));
        Assert.Same(first, store.Authenticate(first.Token));
        now += TimeSpan.FromMinutes(50);
        Assert.True(first.Renew());
        now += TimeSpan.FromMinutes(50);
        Assert.Same(first, store.Authenticate(first.Token));
        current = false;
        Assert.False(first.Renew());
        Assert.Null(store.Authenticate(first.Token));
        current = true;
        store.Retire(first);
        var successor = store.Issue(f.Owner, TimeSpan.FromSeconds(1), () => true);
        Assert.NotEqual(first.Token, successor.Token);
        Assert.Null(store.Authenticate(first.Token));
        now += TimeSpan.FromSeconds(2);
        Assert.Null(store.Authenticate(successor.Token));
        Assert.False(successor.Renew());
        var other = store.Issue(f.Main.Target, TimeSpan.FromHours(1), () => true);
        Assert.Same(f.Main.Target, other.Owner);
        Assert.NotEqual(first.SessionId, other.SessionId);
        store.Close();
        Assert.Null(store.Authenticate(other.Token));
        Assert.Null(new SessionRuntimeCredentialStore().Authenticate(other.Token));
        await AssertRevokedAsync(f, "Bearer " + InboundMcpFixture.Alpha);
        await AssertRevokedAsync(f, "Bearer " + InboundMcpFixture.Admin);
    }
}
