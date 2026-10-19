using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentDeletionTests
{
    [Fact]
    public async Task WebUI_preflights_orphan_inheritance_and_nonWebUI_bindings_then_clears_children_queued_work_and_only_own_metadata()
    {
        using var temp = new TempDirectory();
        var data = Data(temp.Path);
        Directory.CreateDirectory(Path.Combine(data, "state"));
        foreach (var name in new[] { "target", "other" })
            Directory.CreateDirectory(Path.Combine(data, "agents", name));
        await File.WriteAllTextAsync(Path.Combine(data, "state", "agents.json"),
            "{\"target\":{\"extension\":42},\"orphan\":{\"inherit\":\"target\",\"opaque\":true},\"other\":{\"opaque\":17}}");
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var target = await manager.CreateNamedAsync("target", "member", null, null);
        var second = await manager.CreateNamedAsync("target", "second", null, null);
        var (child, _) = await manager.CreateChildAsync(target, "child", "other", null, null, null);
        var (grand, _) = await manager.CreateChildAsync(child, "grand", null, null, null, null);
        var childJson = await File.ReadAllTextAsync(Authority(temp.Path, child.Id));
        var inherited = await Assert.ThrowsAsync<InvalidOperationException>(() => manager.DeleteAgentAsync("target"));
        Assert.Contains("inherited by: orphan", inherited.Message);
        Assert.False(Directory.Exists(Path.Combine(data, "agents", "orphan")));
        Assert.NotNull(manager.Catalog.Get(target.Id));
        Directory.CreateDirectory(Path.Combine(data, "agents", "orphan"));
        await manager.SetAgentInheritAsync("orphan", null);
        manager.AttachChannel("telegram:fixture", target);
        var attached = await Assert.ThrowsAsync<InvalidOperationException>(() => manager.DeleteAgentAsync("target"));
        Assert.Contains("non-WebUI", attached.Message);
        Assert.False(target.Entry.Retired);
        Assert.False(second.Entry.Retired);
        manager.DetachChannel("telegram:fixture");
        manager.AttachChannel("webui:fixture", target);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        await target.Entry.SaveLane.AdmitAsync(QueueItem.UserText("queued idle input"), SaveKind.Strict);
        Assert.Single(target.Entry.Snapshot().Queue);
        Assert.False(target.Metadata().Busy);
        var topology = 0;
        manager.TopologyChanged += () => topology++;
        var expected = manager.Catalog.List().Where(row => row["agent"]!.ToString() == "target").Select(row => row["id"]!.ToString()).ToArray();
        Assert.Equal(expected, await manager.DeleteAgentAsync("target"));
        Assert.True(topology > 0);
        Assert.Empty(target.Entry.Snapshot().Queue);
        Assert.Null(manager.ChannelBinding("webui:fixture"));
        Assert.Null(manager.Catalog.Get(child.Id)!["parentSessionId"]);
        Assert.Equal(grand.Metadata().ParentSessionId, child.Id);
        Assert.Equal(childJson, await File.ReadAllTextAsync(Authority(temp.Path, child.Id)));
        Assert.Null(manager.AgentMetadata["target"]);
        Assert.True(manager.AgentMetadata["orphan"]!["opaque"]!.GetValue<bool>());
        Assert.Equal(17, manager.AgentMetadata["other"]!["opaque"]!.GetValue<int>());
    }

    [Fact]
    public async Task Sequential_command_unlink_failure_keeps_previous_deletes_and_exact_owner_partial_cleanup_without_cross_caller_retry()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await manager.CreateAgentAsync("target");
        await manager.CreateNamedAsync("target", "second", null, null);
        var ids = manager.Catalog.List().Select(row => row["id"]!.ToString()).ToArray();
        var old = await manager.RequiredAsync(ids[1]);
        var path = Authority(temp.Path, ids[1]);
        var held = path + ".held";
        manager.BeforeDeleteStage = (stage, id) =>
        {
            if (id == ids[1] && stage == "json-unlink")
            {
                File.Move(path, held);
                Directory.CreateDirectory(path);
            }
            return Task.CompletedTask;
        };
        try
        {
            var error = await Assert.ThrowsAsync<SessionDeletionException>(() => manager.DeleteAgentFromCommandAsync("target"));
            Assert.Equal("SESSION_TREE_DELETE_PARTIAL", error.Code);
            Assert.Equal("json-unlink", error.Details["failedStage"]!.ToString());
            Assert.Null(manager.Catalog.Get(ids[0]));
            Assert.NotNull(manager.Catalog.Get(ids[1]));
            Assert.True(old.Entry.Retired);
            Assert.True(Directory.Exists(manager.AgentDirectory("target")));
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() => old.Entry.SaveLane.SaveStrictAsync());
            var wrongCaller = await Assert.ThrowsAsync<SessionDeletionException>(() => manager.DeleteAsync(ids[1]));
            Assert.Equal("SESSION_DELETE_RETRY_MISMATCH", wrongCaller.Code);
            await Assert.ThrowsAnyAsync<InvalidDataException>(() => manager.CreateNamedAsync("target", ids[1].Split('/')[1], null, null));
        }
        finally
        {
            manager.BeforeDeleteStage = null;
            Directory.Delete(path);
            File.Move(held, path);
        }
        Assert.Equal(new[] { ids[1] }, await manager.DeleteAgentFromCommandAsync("target"));
        Assert.Null(manager.Find(ids[1]));
        Assert.False(File.Exists(path));
        Assert.Empty(manager.Catalog.List());
        await manager.CreateAgentAsync("target", createMainSession: false);
        Assert.True(Directory.Exists(manager.AgentDirectory("target")));
    }

    [Theory]
    [InlineData("directory")]
    [InlineData("metadata")]
    public async Task Final_cleanup_failures_leave_actual_earlier_effects_and_release_only_the_Agent_admission(string stage)
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        await manager.CreateAgentAsync("base");
        await manager.CreateAgentAsync("target", inherit: "base");
        var directory = manager.AgentDirectory("target");
        var index = Path.Combine(Data(temp.Path), "state", "agents.json");
        var selected = stage == "directory" ? directory : index;
        var held = selected + ".held";
        manager.BeforeAgentDeletionStage = async (_, current) =>
        {
            if (stage != current)
                return;
            if (stage == "directory")
            {
                Directory.Move(selected, held);
                await File.WriteAllTextAsync(selected, "synthetic owned obstruction");
            }
            else
            {
                File.Move(selected, held);
                Directory.CreateDirectory(selected);
            }
        };
        try
        {
            await Assert.ThrowsAnyAsync<IOException>(() => manager.DeleteAgentAsync("target"));
            Assert.Null(manager.Catalog.Get("target/main"));
            Assert.Equal("base", manager.AgentMetadata["target"]!["inherit"]!.ToString());
            Assert.Equal(stage == "directory", Directory.Exists(held));
            Assert.NotNull(await manager.CreateNamedAsync("base", "unrelated", null, null));
        }
        finally
        {
            manager.BeforeAgentDeletionStage = null;
            if (stage == "directory")
            {
                File.Delete(selected);
                Directory.Move(held, selected);
            }
            else
            {
                Directory.Delete(selected);
                File.Move(held, selected);
            }
        }
        if (stage == "metadata")
        {
            Assert.False(Directory.Exists(directory));
            await manager.CreateAgentAsync("target", createMainSession: false);
        }
        Assert.Empty(await manager.DeleteAgentAsync("target"));
        Assert.Null(manager.AgentMetadata["target"]);
    }
}
