using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class LifecycleTransitionTests
{
    [Fact]
    public async Task Accepted_child_publication_survives_parent_move_and_cold_task_completion()
    {
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (context, _) =>
            {
                var reply = new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["status"] = "completed",
                    ["content"] = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "output_text",
                            ["text"] = "accepted assignment settled",
                        }
                    ),
                };
                await context.Send(ResponsesPrefixCommitTests.Done(0, reply));
                await context.Send(ResponsesPrefixCommitTests.Completed(reply));
            }
        );
        using var fixture = new Fixture(peer.Uri);
        string taskId;
        string childId;
        await using (var manager = fixture.Manager())
        {
            await manager.LoadAsync();
            var parent = await manager.CreateNamedAsync("main", "parent", null, null);
            taskId = (
                await manager.Tasks.ExecuteAsync(
                    new JsonObject { ["action"] = "create", ["title"] = "cross-lifecycle task" },
                    parent.Id
                )
            ).Payload["task"]!["id"]!.GetValue<string>();
            var reached = Signal();
            var release = Signal();
            manager.BeforeCreationPublication = async id =>
            {
                if (id == "parent_child")
                {
                    reached.TrySetResult();
                    await release.Task;
                }
            };
            var creating = manager.Tasks.CreateAttachedChildAsync(
                taskId,
                parent.Id,
                async () =>
                    (
                        await manager.CreateChildAsync(
                            parent,
                            "child",
                            null,
                            null,
                            null,
                            null,
                            taskId: taskId
                        )
                    ).Child,
                "accepted child work"
            );
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            try
            {
                await manager.MoveIdentityAsync(
                    parent,
                    new JsonObject { ["newSessionId"] = "moved-parent" }
                );
            }
            finally
            {
                release.TrySetResult();
            }
            var attached = await creating;
            Assert.True(attached.AssignmentDelivered, attached.Warning);
            childId = attached.Child.Id;
            Assert.Equal("moved-parent", attached.Child.Metadata().ParentSessionId);
            Assert.Single(attached.Child.Entry.Snapshot().Queue);
            await manager.MoveIdentityAsync(
                attached.Child,
                new JsonObject { ["newSessionId"] = "moved-child" }
            );
            await manager.ClearAsync(parent);
        }
        await using (var reopened = fixture.Manager())
        {
            await reopened.LoadAsync();
            var parent = await reopened.RequiredAsync("parent");
            var child = await reopened.RequiredAsync(childId);
            Assert.Equal("moved-parent", parent.Id);
            Assert.Equal("moved-child", child.Id);
            Assert.Equal(parent.Id, child.Metadata().ParentSessionId);
            await child.DrainForegroundAsync();
            Assert.Single(
                child.Entry.Snapshot().History,
                row => row.ToJsonString().Contains("accepted child work", StringComparison.Ordinal)
            );
            var completed = await reopened.Tasks.ExecuteAsync(
                new JsonObject
                {
                    ["action"] = "complete",
                    ["taskId"] = taskId,
                    ["result"] = "cold completion",
                },
                child.Id
            );
            Assert.Null(completed.Payload["warning"]);
            Assert.Equal(1, completed.Payload["sentNotifications"]!.GetValue<int>());
            Assert.Contains(
                "cold completion",
                Assert.Single(parent.Entry.Snapshot().Queue).Parts![0].ToJsonString()
            );
            Assert.True((await reopened.ClearAsync(child)).Cleared);
            await reopened.SendAsync(parent, child.Id, "surviving passive input", trigger: false);
            Assert.False(Assert.Single(child.Entry.Snapshot().Queue).Trigger);
            Assert.Equal(
                "deleted",
                (await reopened.DeleteAsync(parent.Id))["status"]!.GetValue<string>()
            );
            Assert.Null(child.Metadata().ParentSessionId);
            Assert.Single(child.Entry.Snapshot().Queue);
        }
        await using (var reopened = fixture.Manager())
        {
            await reopened.LoadAsync();
            Assert.Null(await reopened.GetExistingAsync("parent"));
            var child = await reopened.RequiredAsync("moved-child");
            Assert.Null(child.Metadata().ParentSessionId);
            Assert.Single(child.Entry.Snapshot().Queue);
        }
    }

    [Fact]
    public async Task Committed_clear_then_move_fork_and_delete_never_resurrects_captured_input_on_reopen()
    {
        using var fixture = new Fixture();
        string forkId;
        await using (var manager = fixture.Manager())
        {
            await manager.LoadAsync();
            var parent = await manager.CreateNamedAsync("main", "parent", null, null);
            var source = await manager.CreateNamedAsync("main", "source", null, null);
            await ForkClearLifecycleTests.AppendAsync(parent, Text("retained old audit"));
            await manager.SendAsync(source, parent.Id, "discarded accepted input", trigger: false);
            fixture.WriteStage = (id, stage) =>
            {
                if (id != parent.Id || stage != AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                    return;
                fixture.WriteStage = null;
                throw new IOException("Owned committed clear failure.");
            };
            await Assert.ThrowsAsync<AuthorityCommittedException>(() => manager.ClearAsync(parent));
            Assert.Empty(parent.Entry.Snapshot().Queue);
            Assert.Empty(parent.Entry.Snapshot().History);
            await manager.SendAsync(source, parent.Id, "retained later input", trigger: false);
            await manager.MoveIdentityAsync(parent, new JsonObject { ["newSessionId"] = "moved" });
            var fork = await manager.ForkAsync(parent, "cut");
            forkId = fork.Id;
            Assert.Empty(fork.Entry.Snapshot().Queue);
            Assert.DoesNotContain(
                fork.Entry.Snapshot().History,
                row => row.ToJsonString().Contains("retained old audit", StringComparison.Ordinal)
            );
            await manager.DeleteAsync(fork.Id);
        }
        await using (var reopened = fixture.Manager())
        {
            await reopened.LoadAsync();
            var parent = await reopened.RequiredAsync("parent");
            Assert.Equal("moved", parent.Id);
            Assert.Empty(parent.Entry.Snapshot().History);
            Assert.Contains(
                "retained later input",
                Assert.Single(parent.Entry.Snapshot().Queue).Parts![0].ToJsonString()
            );
            Assert.Single(parent.Archive.ReadMessages());
            Assert.Null(await reopened.GetExistingAsync(forkId));
            Assert.NotNull(reopened.ArchiveReader(forkId).ReadBranch());
        }
    }

    [Fact]
    public async Task Recursive_delete_revalidates_after_accepted_unpublished_fork_without_orphaning_it()
    {
        using var fixture = new Fixture();
        await using var manager = fixture.Manager();
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var reached = Signal();
        var release = Signal();
        manager.BeforeCreationPublication = async id =>
        {
            if (id == "parent_cut")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var creating = manager.ForkAsync(parent, "cut");
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var deleting = manager.DeleteAsync(parent.Id, recursive: true);
        try
        {
            Assert.False(deleting.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        var child = await creating;
        var deleted = await deleting;
        Assert.Equal("deleted", deleted["status"]!.GetValue<string>());
        Assert.Null(await manager.GetExistingAsync(parent.Id));
        Assert.Null(await manager.GetExistingAsync(child.Id));
        Assert.NotNull(child.Archive.ReadBranch());
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            child.Entry.SaveLane.SaveStrictAsync()
        );
    }

    [Fact]
    public async Task Failed_inflight_fork_compensates_its_branch_after_parent_move()
    {
        using var fixture = new Fixture();
        await using var manager = fixture.Manager();
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        await ForkClearLifecycleTests.AppendAsync(parent, Text("parent prefix"));
        var parentBytes = parent.Archive.ReadMessages().Single().MessageJson;
        var id = "parent_cut";
        var reached = Signal();
        var release = Signal();
        fixture.CanonicalStage = async (current, _, _) =>
        {
            if (current != id)
                return;
            reached.TrySetResult();
            await release.Task;
        };
        fixture.WriteStage = (current, stage) =>
        {
            if (current == id && stage == AtomicJsonWriteStage.BeforeRename)
            {
                fixture.WriteStage = null;
                throw new IOException("Owned fork precommit failure.");
            }
        };
        var creating = manager.ForkAsync(parent, "cut");
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            await manager.MoveIdentityAsync(parent, new JsonObject { ["newSessionId"] = "moved" });
        }
        finally
        {
            release.TrySetResult();
        }
        var error = await Record.ExceptionAsync(() => creating);
        Assert.Null(manager.Find(id));
        Assert.Null(manager.ArchiveReader(id).ReadBranch());
        Assert.IsType<IOException>(error);
        Assert.Empty(manager.ArchiveReader(id).ReadMessages());
        Assert.Equal(parentBytes, parent.Archive.ReadMessages().Single().MessageJson);
        Assert.Equal(id, (await manager.CreateNamedAsync("main", id, null, null)).Id);
    }

    private static JsonObject Text(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed class Fixture(Uri? endpoint = null) : IDisposable
    {
        private readonly TempDirectory temp = new();
        private string Data => Path.Combine(temp.Path, "data");
        internal Action<string, AtomicJsonWriteStage>? WriteStage;
        internal Func<string, int, CancellationToken, Task>? CanonicalStage;

        internal SessionManager Manager()
        {
            var options = new ResponsesClientOptions(
                endpoint ?? new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            var manager = new SessionManager(
                Data,
                Path.Combine(temp.Path, "work"),
                options,
                HostModels.ForTest(options),
                authorityStageHook: (id, stage) => WriteStage?.Invoke(id, stage),
                canonicalCommitBarrier: (id, commit, token) => CanonicalStage?.Invoke(id, commit, token) ?? Task.CompletedTask
            );
            manager.TopologyChanged += () =>
            {
                foreach (var owner in manager.Owners())
                    owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            };
            return manager;
        }

        public void Dispose() => temp.Dispose();
    }
}
