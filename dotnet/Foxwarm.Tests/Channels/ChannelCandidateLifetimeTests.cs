using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ChannelCandidateLifetimeTests
{
    [Fact]
    public async Task Restored_permissions_allow_explicit_same_host_cleanup_with_retained_archive()
    {
        if (OperatingSystem.IsWindows())
            return;
        await using var f = await ExternalChannelFixture.CreateAsync();
        var state = Path.Combine(f.Data, "state");
        var sessions = Path.Combine(state, "sessions");
        var stateMode = File.GetUnixFileMode(state);
        var sessionsMode = File.GetUnixFileMode(sessions);
        string? candidate = null;
        f.Manager.BeforeCreationPublication = id =>
        {
            candidate = id;
            File.SetUnixFileMode(state, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            File.SetUnixFileMode(sessions, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            return Task.CompletedTask;
        };
        try
        {
            var failure = await Assert.ThrowsAsync<AggregateException>(() =>
                f.Manager.ResolveChannelAsync("alpha:manual-cleanup")
            );
            Assert.Equal(2, failure.InnerExceptions.Count);
            Assert.All(
                failure.InnerExceptions,
                error => Assert.IsType<UnauthorizedAccessException>(error)
            );
            Assert.Null(f.Manager.ChannelBinding("alpha:manual-cleanup"));
            Assert.NotNull(f.Manager.Catalog.Get(candidate!));
            Assert.True(File.Exists(Path.Combine(sessions, candidate + ".json")));
            await Assert.ThrowsAsync<SessionDeletionException>(() =>
                f.Manager.RequiredAsync(candidate!)
            );
        }
        finally
        {
            File.SetUnixFileMode(sessions, sessionsMode);
            File.SetUnixFileMode(state, stateMode);
            f.Manager.BeforeCreationPublication = null;
        }
        var result = await f.Manager.DeleteAsync(candidate!);
        Assert.Equal("deleted", SessionWait.Text(result["status"]));
        Assert.True(result["continuedSameHost"]!.GetValue<bool>());
        Assert.Null(f.Manager.Catalog.Get(candidate!));
        Assert.False(File.Exists(Path.Combine(sessions, candidate + ".json")));
        Assert.Null(await f.Manager.GetExistingAsync(candidate!));
        Assert.NotNull(f.Manager.ArchiveReader(candidate!).ReadBranch());
        await ChannelCreationCompensationTests.ReopenAsync(f);
        Assert.Null(await f.Manager.GetExistingAsync(candidate!));
        Assert.NotNull(f.Manager.ArchiveReader(candidate!).ReadBranch());
    }

    [Fact]
    public async Task Accepted_child_preserves_usable_parent_relationship_and_prevents_unrelated_reuse()
    {
        if (OperatingSystem.IsWindows())
            return;
        await using var f = await ExternalChannelFixture.CreateAsync();
        f.Manager.TopologyChanged += () =>
        {
            foreach (var owner in f.Manager.Owners())
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        };
        var state = Path.Combine(f.Data, "state");
        var permissions = File.GetUnixFileMode(state);
        SessionOwner? candidate = null;
        SessionOwner? child = null;
        try
        {
            var failure = await Assert.ThrowsAsync<AggregateException>(() =>
                f.Manager.ResolveChannelAsync(
                    "alpha:accepted-child",
                    async () =>
                    {
                        candidate = await f.Manager.CreateAsync();
                        var accepted = await f.Manager.CreateChildAsync(
                            candidate,
                            "accepted",
                            null,
                            null,
                            "accepted child task",
                            null
                        );
                        child = accepted.Child;
                        Assert.True(accepted.Delivered);
                        Assert.Single(child.Entry.Snapshot().Queue);
                        Assert.Empty(candidate.Entry.Snapshot().Queue);
                        Assert.Empty(candidate.History());
                        File.SetUnixFileMode(
                            state,
                            UnixFileMode.UserRead | UnixFileMode.UserExecute
                        );
                        return candidate;
                    }
                )
            );
            Assert.Contains(failure.InnerExceptions, error => error is UnauthorizedAccessException);
            Assert.Contains(failure.InnerExceptions, error => error is InvalidOperationException);
            Assert.Same(candidate, await f.Manager.RequiredAsync(candidate!.Id));
            Assert.False(candidate.Entry.Retired);
            Assert.NotNull(candidate.Archive.ReadBranch());
            Assert.Null(f.Manager.ChannelBinding("alpha:accepted-child"));
            Assert.Equal(
                candidate.Id,
                SessionWait.Text(f.Manager.Catalog.Get(child!.Id)!["parentSessionId"])
            );
            Assert.Equal(
                candidate.Id,
                SessionWait.Text(child.Entry.Snapshot().AuthorityEnvelope["parentSessionId"])
            );
            Assert.Equal(
                candidate.Id,
                SessionWait.Text(
                    JsonNode.Parse(
                        await File.ReadAllTextAsync(child.AuthorityStore.AuthorityPath)
                    )!["parentSessionId"]
                )
            );
        }
        finally
        {
            File.SetUnixFileMode(state, permissions);
        }
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.CreateNamedAsync("main", candidate!.Id, "unrelated replacement", null)
        );
        await f.Manager.SendAsync(child!, "<parent>", "report intended for original parent");
        Assert.Same(candidate, await f.Manager.RequiredAsync(candidate!.Id));
        Assert.Single(candidate.Entry.Snapshot().Queue);
        Assert.Single(child!.Entry.Snapshot().Queue);
        await ChannelCreationCompensationTests.ReopenAsync(f);
        var coldParent = await f.Manager.RequiredAsync(candidate.Id);
        var coldChild = await f.Manager.RequiredAsync(child.Id);
        Assert.Equal(
            candidate.Id,
            SessionWait.Text(coldChild.Entry.Snapshot().AuthorityEnvelope["parentSessionId"])
        );
        Assert.Single(coldChild.Entry.Snapshot().Queue);
        Assert.Single(coldParent.Entry.Snapshot().Queue);
    }
}
