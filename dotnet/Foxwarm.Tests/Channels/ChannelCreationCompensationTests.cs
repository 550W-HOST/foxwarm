using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ChannelCreationCompensationTests
{
    [Fact]
    public async Task Denied_new_binding_removes_only_the_empty_candidate_before_retry_and_cold_admission()
    {
        if (OperatingSystem.IsWindows())
            return;
        await using var f = await ExternalChannelFixture.CreateAsync();
        f.Manager.AttachChannel("alpha:existing", f.Owner);
        var state = Path.Combine(f.Data, "state");
        var permissions = File.GetUnixFileMode(state);
        string? candidate = null;
        f.Manager.BeforeCreationPublication = id =>
        {
            candidate = id;
            File.SetUnixFileMode(state, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            return Task.CompletedTask;
        };
        try
        {
            var error = await Record.ExceptionAsync(() =>
                f.Manager.ResolveChannelAsync("alpha:failed-new")
            );
            Assert.NotNull(error);
            await AssertAbsentAsync(f.Manager, f.Data, candidate!);
            Assert.IsType<UnauthorizedAccessException>(error);
            Assert.Null(f.Manager.ChannelBinding("alpha:failed-new"));
            Assert.Null(
                JsonNode.Parse(File.ReadAllText(Path.Combine(state, "channels.json")))![
                    "channels"
                ]!["alpha:failed-new"]
            );
            Assert.False(File.Exists(Path.Combine(state, "running-exec.json")));
        }
        finally
        {
            File.SetUnixFileMode(state, permissions);
            f.Manager.BeforeCreationPublication = null;
        }
        var retry = await f.Manager.ResolveChannelAsync("alpha:failed-new");
        Assert.NotEqual(candidate, retry.Id);
        Assert.Equal(2, f.Manager.Catalog.List().Length);
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.ChannelBinding("alpha:existing")!["sessionId"])
        );
        await AssertAbsentAsync(f.Manager, f.Data, candidate!);
        await ReopenAsync(f);
        await AssertAbsentAsync(f.Manager, f.Data, candidate!);
        Assert.Equal(retry.Id, (await f.Manager.ResolveChannelAsync("alpha:failed-new")).Id);
        Assert.Equal(2, f.Manager.Catalog.List().Length);
    }

    [Fact]
    public async Task Real_QQ_denied_new_conversation_has_no_candidate_and_retry_persists_one_input()
    {
        if (OperatingSystem.IsWindows())
            return;
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        await QQBotChannelTests.Start(f, peer);
        var state = Path.Combine(f.Data, "state");
        var permissions = File.GetUnixFileMode(state);
        string? candidate = null;
        f.Manager.BeforeCreationPublication = id =>
        {
            candidate = id;
            File.SetUnixFileMode(state, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            return Task.CompletedTask;
        };
        try
        {
            peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("new-denied", "not admitted"));
            await TelegramChannelTests.Until(() =>
                peer.Sent.Any(call =>
                    SessionWait
                        .Text(call.Body["content"])!
                        .Contains("denied", StringComparison.Ordinal)
                )
            );
            Assert.NotNull(candidate);
            await AssertAbsentAsync(f.Manager, f.Data, candidate!);
            Assert.Null(f.Manager.ChannelBinding("qq:group:room"));
        }
        finally
        {
            File.SetUnixFileMode(state, permissions);
            f.Manager.BeforeCreationPublication = null;
        }
        peer.Push("GROUP_AT_MESSAGE_CREATE", QQBotPeer.Message("new-retry", "retry admitted once"));
        await TelegramChannelTests.Until(() =>
            f.Manager.ChannelBinding("qq:group:room") is not null
        );
        var retry = await f.Manager.RequiredAsync(
            SessionWait.Text(f.Manager.ChannelBinding("qq:group:room")!["sessionId"])!
        );
        await TelegramChannelTests.Until(() => retry.Entry.Snapshot().Queue.Count == 1);
        await TelegramChannelTests.Until(() =>
            JsonNode.Parse(File.ReadAllText(retry.AuthorityStore.AuthorityPath))!["queue"]!
                .AsArray()
                .Count == 1
        );
        Assert.NotEqual(candidate, retry.Id);
        Assert.Contains(
            retry.Entry.Snapshot().Queue.Single().Parts!,
            part =>
                (SessionWait.Text(part["text"]) ?? SessionWait.Text(part["system"]) ?? "").Contains(
                    "retry admitted once",
                    StringComparison.Ordinal
                )
        );
        await AssertAbsentAsync(f.Manager, f.Data, candidate!);
        Assert.Equal(2, f.Manager.Catalog.List().Length);
    }

    [Fact]
    public async Task Genuine_candidate_cleanup_failure_reports_both_errors_and_does_not_claim_success()
    {
        if (OperatingSystem.IsWindows())
            return;
        await using var f = await ExternalChannelFixture.CreateAsync();
        var state = Path.Combine(f.Data, "state");
        var faults = Path.Combine(state, "experiment-faults");
        Directory.CreateDirectory(faults);
        var permissions = File.GetUnixFileMode(state);
        string? candidate = null;
        f.Manager.BeforeCreationPublication = async id =>
        {
            candidate = id;
            await File.WriteAllTextAsync(
                Path.Combine(
                    faults,
                    SessionIdentity.ExecDirectorySegment(id) + ".create-cleanup-fail"
                ),
                "fail"
            );
            File.SetUnixFileMode(state, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        };
        try
        {
            var failure = await Assert.ThrowsAsync<AggregateException>(() =>
                f.Manager.ResolveChannelAsync("alpha:failed-cleanup")
            );
            Assert.Contains(failure.InnerExceptions, error => error is UnauthorizedAccessException);
            Assert.Contains(
                failure.InnerExceptions,
                error =>
                    error is IOException
                    && error.Message.Contains("branch cleanup failure", StringComparison.Ordinal)
            );
            Assert.Contains(candidate!, failure.Message);
            Assert.Null(f.Manager.ChannelBinding("alpha:failed-cleanup"));
            Assert.NotNull(f.Manager.Catalog.Get(candidate!));
            Assert.NotNull(f.Manager.ArchiveReader(candidate!).ReadBranch());
            Assert.False(File.Exists(Path.Combine(state, "sessions", candidate + ".json")));
            await Assert.ThrowsAsync<SessionDeletionException>(() =>
                f.Manager.GetExistingAsync(candidate!)
            );
        }
        finally
        {
            File.SetUnixFileMode(state, permissions);
            f.Manager.BeforeCreationPublication = null;
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Accepted_input_remains_usable_across_queued_and_consumed_foreground_states(
        bool consumed
    )
    {
        if (OperatingSystem.IsWindows())
            return;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) =>
            {
                await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    WeWorkTurnTests.Complete(
                        new JsonArray(TelegramHostTests.Output("preserved final"))
                    )
                );
            }
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var state = Path.Combine(f.Data, "state");
        var permissions = File.GetUnixFileMode(state);
        SessionOwner? candidate = null;
        try
        {
            // The existing creator seam makes the published-before-bind scheduling deterministic.
            // Input still crosses the real Router, mutation admission, save lane and turn runner.
            var failure = await Assert.ThrowsAsync<AggregateException>(() =>
                f.Manager.ResolveChannelAsync(
                    "alpha:accepted",
                    async () =>
                    {
                        candidate = await f.Manager.CreateAsync();
                        if (!consumed)
                            candidate.Registry.TriggerOverride = _ => Task.CompletedTask;
                        var routed = await f.Router.HandleMessageAsync(
                            new(candidate.Id, "webui"),
                            new("accepted input", "preserved-input")
                        );
                        Assert.Equal(202, routed.Status);
                        if (consumed)
                        {
                            await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
                            Assert.Empty(candidate.Entry.Snapshot().Queue);
                            Assert.True(candidate.Metadata().Busy);
                            Assert.Single(candidate.History());
                        }
                        else
                            Assert.Single(candidate.Entry.Snapshot().Queue);
                        File.SetUnixFileMode(
                            state,
                            UnixFileMode.UserRead | UnixFileMode.UserExecute
                        );
                        return candidate;
                    }
                )
            );
            Assert.Contains(failure.InnerExceptions, error => error is UnauthorizedAccessException);
            Assert.Contains(
                failure.InnerExceptions,
                error => error.Message.Contains("accepted work", StringComparison.Ordinal)
            );
            Assert.Same(candidate, await f.Manager.RequiredAsync(candidate!.Id));
            Assert.False(candidate.Entry.Retired);
            Assert.Null(f.Manager.ChannelBinding("alpha:accepted"));
            Assert.Contains(
                "accepted input",
                await File.ReadAllTextAsync(candidate.AuthorityStore.AuthorityPath)
            );
            Assert.Equal(
                1,
                candidate.Entry.Snapshot().Queue.Count
                    + candidate.History().Count(row => SessionWait.Text(row["role"]) == "user")
            );
        }
        finally
        {
            File.SetUnixFileMode(state, permissions);
            release.TrySetResult();
        }
        await provider.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
        await candidate!.DrainForegroundAsync();
        Assert.Empty(candidate.Entry.Snapshot().Queue);
        Assert.Equal(2, candidate.History().Count);
        Assert.Equal(2, candidate.Archive.ReadMessages().Count);
        Assert.Contains(
            candidate.History(),
            row => row.ToJsonString().Contains("preserved final", StringComparison.Ordinal)
        );
    }

    internal static async Task AssertAbsentAsync(SessionManager manager, string data, string id)
    {
        Assert.DoesNotContain(manager.Owners(), owner => owner.Id == id);
        Assert.Null(manager.Catalog.Get(id));
        Assert.Null(await manager.GetExistingAsync(id));
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", id + ".json")));
        var archive = manager.ArchiveReader(id);
        Assert.Null(archive.ReadBranch());
        Assert.Empty(archive.ReadMessages());
    }

    internal static async Task ReopenAsync(ExternalChannelFixture f)
    {
        f.Manager.BeginShutdown();
        await f.Manager.ManagedChannels!.DisposeAsync();
        await f.Manager.ShutdownAsync();
        await f.Manager.DisposeAsync();
        f.Manager = new SessionManager(
            f.Data,
            f.Work,
            new ResponsesClientOptions(new Uri("http://127.0.0.1:1/v1/"), "wire", "", "", "", 1024),
            f.Configuration.Models
        );
        await f.Manager.LoadMainHostAsync();
        f.Router = new(new SessionRuntime(f.Manager));
        f.Manager.InitializeChannels(f.Router, f.Configuration);
    }
}
