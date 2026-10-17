using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionCreationNodeDefaultTests
{
    [Fact]
    public async Task Omitted_selection_follows_existing_same_Agent_main_without_cwd_or_online_requirement()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        await using var manager = new SessionManager(Path.Combine(temp.Path, "data"), Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await manager.LoadAsync();
        await manager.CreateAgentAsync("named", false);
        var first = await manager.CreateNamedAsync("named", "before-main", null, null);
        Assert.Equal("master", manager.CurrentNode(first));
        Assert.Null(manager.Catalog.Get("named/main"));
        Assert.Null(manager.Find("named/main"));
        var main = await manager.CreateNamedAsync("named", "main", null, null, initialNode: "offline");
        await main.UpdateCwdAsync("remote-only-directory");
        Assert.False(manager.Nodes.Online("offline"));
        var following = await manager.CreateNamedAsync("named", "following", null, null);
        Assert.Equal("offline", manager.CurrentNode(following));
        Assert.Null(following.Entry.Snapshot().AuthorityEnvelope["cwd"]);
        var explicitMaster = await manager.CreateNamedAsync("named", "explicit", null, null, initialNode: "master");
        Assert.Equal("master", manager.CurrentNode(explicitMaster));
        var child = await manager.CreateChildAsync(explicitMaster, "child", null, null, null, null);
        Assert.Equal("master", manager.CurrentNode(child.Child));
        var fork = await manager.CreateChildAsync(explicitMaster, "fork", null, null, null, null, fork: true);
        Assert.Equal("master", manager.CurrentNode(fork.Child));
        await manager.CreateNamedAsync("main", "main", null, null, initialNode: "offline");
        Assert.Equal("master", manager.CurrentNode(await manager.CreateNamedAsync("main", "excluded", null, null)));
        manager.Nodes.Registry.Create("bound");
        await manager.CreateAgentAsync("isolated", false, isolatedNode: "bound");
        Assert.Equal("bound", manager.CurrentNode(await manager.CreateNamedAsync("isolated", "selected", null, null, initialNode: "master")));
        await manager.MoveIdentityAsync(main, new JsonObject { ["newSessionId"] = "renamed-main" });
        Assert.Equal("alias", manager.Catalog.Resolve("named/main")["kind"]!.GetValue<string>());
        Assert.Equal("offline", manager.CurrentNode(await manager.CreateNamedAsync("named", "alias-follower", null, null)));
    }
}
