using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    [Fact]
    public async Task Selected_administrator_Agent_command_stops_real_provider_in_same_request_and_old_owner_cannot_resurrect_authority()
    {
        var reached = Signal();
        var release = Signal();
        await using var peer = new ConcurrentPeer(1, async (_, stream, _) =>
        {
            reached.TrySetResult();
            await release.Task;
            try { await SendAsync(stream, "late cancelled response"); }
            catch (IOException) { }
        });
        await using var f = await FixtureAsync(peer.Uri);
        await f.Manager.CreateAgentAsync("target");
        var target = await f.Manager.RequiredAsync("target/main");
        var events = new List<SessionRuntimeEvent>();
        f.Manager.Changed += events.Add;
        try
        {
            await target.Registry.Ingress.EnqueueAsync(target.Id, QueueItem.UserText("pending provider work"));
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await target.Entry.SaveLane.AdmitAsync(QueueItem.UserText("captured queued work"), SaveKind.Strict);
            var blocked = await Assert.ThrowsAsync<InvalidOperationException>(() => f.Manager.DeleteAgentAsync("target"));
            Assert.Contains("active sessions", blocked.Message);
            Assert.True(target.Metadata().Busy);
            Assert.Single(target.Entry.Snapshot().Queue);
            var result = await f.Router.HandleMessageAsync(new(target.Id, "webui"),
                new("/agent delete target --confirm", null)).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(200, result.Status);
            Assert.True(target.Entry.Retired);
            Assert.False(target.Processing);
            Assert.Empty(target.Entry.Snapshot().Queue);
            Assert.Contains(events, item => item.Kind == SessionEventKind.CommandReply && item.Data!.ToJsonString().Contains("Deleted 1 session(s)"));
            Assert.Null(f.Manager.Catalog.Get(target.Id));
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() => AppendAsync(target, Text("late old host completion")));
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() => target.AuthorityStore.CommitAsync(target.Entry.Snapshot(), SaveKind.Strict));
            Assert.False(File.Exists(Path.Combine(f.Data, "state", "sessions", target.Id + ".json")));
        }
        finally { release.TrySetResult(); }
    }

    [Fact]
    public async Task Busy_Agent_command_settles_real_exec_tool_pair_and_cwd_without_killing_its_independent_process()
    {
        using var effects = new TempDirectory();
        var ready = Path.Combine(effects.Path, "ready");
        var release = Path.Combine(effects.Path, "release");
        var completed = Path.Combine(effects.Path, "completed");
        var command = OperatingSystem.IsWindows()
            ? $"New-Item -ItemType Directory changed | Out-Null; Set-Location changed; Set-Content -LiteralPath '{ready}' -Value ready; while (!(Test-Path -LiteralPath '{release}')) {{ Start-Sleep -Milliseconds 20 }}; Set-Content -NoNewline -LiteralPath '{completed}' -Value settled"
            : $"mkdir changed && cd changed && touch '{ready}'; while [ ! -f '{release}' ]; do sleep 0.02; done; printf settled > '{completed}'";
        await using var peer = new ConcurrentPeer(1, (_, stream, _) => SendAsync(stream, call: ProviderCall("exec",
            new() { ["command"] = command, ["timeout"] = 60 })));
        await using var f = await FixtureAsync(peer.Uri);
        await f.Manager.CreateAgentAsync("target");
        var target = await f.Manager.RequiredAsync("target/main");
        f.Manager.AttachChannel("telegram:commands", target);
        try
        {
            await target.Registry.Ingress.EnqueueAsync(target.Id, QueueItem.UserText("run controlled exec"));
            await TelegramChannelTests.Until(() => File.Exists(ready));
            var replies = await CommandAsync(f, "/agent delete target --confirm").WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Contains("Deleted 1 session(s)", replies.Single());
            Assert.True(target.Entry.Retired);
            Assert.False(target.Processing);
            var tool = target.History().Single(row => row["role"]!.ToString() == "tool");
            Assert.Contains("execId", tool.ToJsonString());
            Assert.DoesNotContain("SESSION_DELETE_IN_PROGRESS", tool.ToJsonString());
            Assert.EndsWith("changed", target.Entry.Snapshot().AuthorityEnvelope["cwd"]!.ToString());
            Assert.False(File.Exists(completed));
            await File.WriteAllTextAsync(release, "release owned process");
            await TelegramChannelTests.Until(() => File.Exists(completed));
            Assert.Equal("settled", await File.ReadAllTextAsync(completed));
            Assert.False(File.Exists(Path.Combine(f.Data, "state", "sessions", target.Id + ".json")));
            Assert.Null(f.Manager.ChannelBinding("telegram:commands"));
        }
        finally
        {
            await File.WriteAllTextAsync(release, "release owned process");
            await TelegramChannelTests.Until(() => File.Exists(completed));
        }
    }
}
