using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentDeletionTests
{
    [Fact]
    public async Task Removal_waits_for_accepted_creation_then_selects_it_and_rejects_new_create_child_fork_and_move_without_serializing_other_Agents()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await manager.CreateAgentAsync("target");
        await manager.CreateAgentAsync("other");
        var target = await manager.RequiredAsync("target/main");
        var other = await manager.RequiredAsync("other/main");
        var reached = Signal();
        var release = Signal();
        var claimed = Signal();
        manager.BeforeCreationPublication = async id =>
        {
            if (id == "target/accepted")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        manager.BeforeAgentDeletionStage = (_, stage) =>
        {
            if (stage == "claimed")
                claimed.TrySetResult();
            return Task.CompletedTask;
        };
        var accepted = manager.CreateNamedAsync("target", "accepted", null, null);
        Task<string[]>? deletion = null;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            deletion = manager.DeleteAgentFromCommandAsync("target");
            await claimed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(deletion.IsCompleted);
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
                manager.CreateNamedAsync("target", "late", null, null)
            );
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
                manager.CreateChildAsync(other, "late", "target", null, null, null)
            );
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
                manager.ForkAsync(target, "late")
            );
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
                manager.MoveIdentityAsync(
                    other,
                    new() { ["newAgentName"] = "target", ["newSessionId"] = "late" }
                )
            );
            var unrelated = await manager
                .CreateNamedAsync("other", "unrelated", null, null)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotNull(manager.Catalog.Get(unrelated.Id));
            release.TrySetResult();
            var captured = await accepted.WaitAsync(TimeSpan.FromSeconds(5));
            var deleted = await deletion.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Contains(captured.Id, deleted);
            Assert.Contains(target.Id, deleted);
            Assert.True(captured.Entry.Retired);
            Assert.NotNull(manager.Catalog.Get(other.Id));
            Assert.False(Directory.Exists(Path.Combine(Data(temp.Path), "agents", "target")));
        }
        finally
        {
            release.TrySetResult();
            await accepted;
            if (deletion is not null)
                await deletion;
        }
    }

    [Fact]
    public async Task Accepted_incoming_move_settles_before_snapshot_and_final_folder_boundary_rejects_late_admission()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await manager.CreateAgentAsync("target", createMainSession: false);
        await manager.CreateAgentAsync("origin");
        await manager.CreateAgentAsync("other");
        var moving = await manager.RequiredAsync("origin/main");
        var other = await manager.RequiredAsync("other/main");
        var reached = Signal();
        var release = Signal();
        var claimed = Signal();
        manager.BeforeIdentityStage = async (_, stage) =>
        {
            if (stage == "before-target-persistence")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var finalChecked = false;
        manager.BeforeAgentDeletionStage = async (_, stage) =>
        {
            if (stage == "claimed")
                claimed.TrySetResult();
            if (stage != "directory")
                return;
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
                manager.CreateNamedAsync("target", "late", null, null)
            );
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
                manager.MoveIdentityAsync(
                    other,
                    new() { ["newAgentName"] = "target", ["newSessionId"] = "late" }
                )
            );
            await manager.CreateNamedAsync("other", "final-unrelated", null, null);
            finalChecked = true;
        };
        var move = manager.MoveIdentityAsync(
            moving,
            new() { ["newAgentName"] = "target", ["newSessionId"] = "incoming" }
        );
        Task<string[]>? deletion = null;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            deletion = manager.DeleteAgentAsync("target");
            await claimed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(deletion.IsCompleted);
            release.TrySetResult();
            await move.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(
                new[] { "target/incoming" },
                await deletion.WaitAsync(TimeSpan.FromSeconds(5))
            );
            Assert.True(finalChecked);
            Assert.NotNull(manager.Catalog.Get("other/main"));
            Assert.NotNull(manager.Catalog.Get("other/final-unrelated"));
            Assert.Null(manager.Catalog.Resolve("origin/main")["sessionId"]);
        }
        finally
        {
            release.TrySetResult();
            await move;
            if (deletion is not null)
                await deletion;
        }
    }

    [Fact]
    public async Task Cold_catalog_members_are_selected_and_deleted_Archive_and_ID_reservations_survive_reopen()
    {
        using var temp = new TempDirectory();
        string[] expected;
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            await manager.CreateAgentAsync("target");
            var second = await manager.CreateNamedAsync("target", "cold", null, null);
            await ForkClearLifecycleTests.AppendAsync(
                second,
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["text"] = "archived cold evidence" }
                    ),
                }
            );
            manager.ChangePresentation(catalog => catalog.Archive(second.Id, true));
            Assert.True(manager.Catalog.Get(second.Id)!["archived"]!.GetValue<bool>());
            expected = manager.Catalog.List().Select(row => row["id"]!.ToString()).ToArray();
        }
        await using (var cold = Manager(temp.Path))
        {
            await cold.LoadAsync();
            Assert.Empty(cold.Owners());
            Assert.Equal(expected, await cold.DeleteAgentFromCommandAsync("target"));
        }
        await using var reopened = Manager(temp.Path);
        await reopened.LoadAsync();
        Assert.Empty(reopened.Owners());
        Assert.Empty(reopened.Catalog.List());
        Assert.Contains(
            "archived cold evidence",
            reopened.ArchiveReader("target/cold").ReadMessages().Single().Message.ToJsonString()
        );
        await reopened.CreateAgentAsync("target", createMainSession: false);
        await Assert.ThrowsAnyAsync<InvalidDataException>(() =>
            reopened.CreateNamedAsync("target", "cold", null, null)
        );
        Assert.False(File.Exists(Authority(temp.Path, "target/cold")));
    }
}
