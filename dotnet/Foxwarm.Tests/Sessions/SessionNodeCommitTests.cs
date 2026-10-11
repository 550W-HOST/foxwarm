using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionNodeCommitTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Agent_binding_preserves_cwd_at_the_actual_authority_commit(bool renamed)
    {
        await AssertPlacementCommitAsync(renamed, clearCwd: false);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Node_selection_and_cwd_clear_publish_together_at_the_actual_authority_commit(
        bool renamed
    )
    {
        await AssertPlacementCommitAsync(renamed, clearCwd: true);
    }

    private static async Task AssertPlacementCommitAsync(bool renamed, bool clearCwd)
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "placement", null, null);
        await owner.UpdateCwdAsync("old-directory");
        var before = owner.Entry.Snapshot();
        var fault = Path.Combine(
            data,
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment(owner.Id)
                + (renamed ? ".settings-after-rename" : ".settings-before-rename")
        );
        Directory.CreateDirectory(Path.GetDirectoryName(fault)!);
        await File.WriteAllTextAsync(fault, "fault");
        await Assert.ThrowsAnyAsync<Exception>(() =>
            owner.Entry.SaveLane.CommitNodeAsync("approved-node", clearCwd)
        );
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(data, "state", "sessions", owner.Id + ".json"))
        )!;
        Assert.Equal(
            renamed ? "approved-node" : "master",
            persisted["currentNode"]!.GetValue<string>()
        );
        Assert.Equal(
            renamed && clearCwd ? null : "old-directory",
            persisted["cwd"]?.GetValue<string>()
        );
        var current = owner.Entry.Snapshot();
        Assert.True(
            JsonNode.DeepEquals(persisted["currentNode"], current.AuthorityEnvelope["currentNode"])
        );
        Assert.True(JsonNode.DeepEquals(persisted["cwd"], current.AuthorityEnvelope["cwd"]));
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["promptCacheKey"],
                current.AuthorityEnvelope["promptCacheKey"]
            )
        );
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["persistentMemorySnapshot"],
                current.AuthorityEnvelope["persistentMemorySnapshot"]
            )
        );
    }

    [Fact]
    public async Task Remote_namespace_cwd_never_becomes_the_Main_workspace_cwd_and_placement_snapshot_stays_paired()
    {
        using var temp = new TempDirectory();
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "placement", null, null);
        await owner.Entry.SaveLane.CommitNodeAsync("remote-node");
        await owner.UpdateCwdAsync("C:\\remote\\only\\project");
        var captured = manager.ExecutionPlacement(owner);
        Assert.Equal("remote-node", captured.Node);
        Assert.Equal("C:\\remote\\only\\project", captured.Cwd);
        Assert.Equal(
            Path.Combine(temp.Path, "work"),
            manager.IdentityWorkspace(owner).Paths.ExecCwd(null)
        );
        await owner.Entry.SaveLane.CommitNodeAsync("master");
        Assert.Equal(
            Path.Combine(temp.Path, "work"),
            manager.IdentityWorkspace(owner, captured.Cwd, captured.Node).Paths.ExecCwd(null)
        );
        Assert.Null(manager.ExecutionPlacement(owner).Cwd);
    }
}
