using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    [Fact]
    public async Task Deleted_direct_children_release_quota_while_retained_authority_requires_explicit_restoration()
    {
        using var temp = new TempDirectory();
        var agents = new AgentCatalog(
            temp.Path,
            Path.Combine(temp.Path, "agents"),
            canonicalLayout: true,
            treeLimits: () => (16, 1)
        );
        await agents.CreateAsync("parent");
        for (var i = 0; i < 3; i++)
        {
            var name = "child" + i;
            await agents.CreateAsync(
                name,
                createdBy: "parent",
                rules: Rules("""[{"action":"deny","tool":"skill"}]""")
            );
            await agents.RemoveDeletedAsync(name, retainMetadata: true, beforeStage: null);
        }
        Assert.Equal(
            3,
            agents
                .MetadataSnapshot()
                .Count(pair => SessionWait.Text(pair.Value?["createdBy"]) == "parent")
        );
        await agents.CreateAsync("replacement", createdBy: "parent");
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            agents.CreateAsync("limited", createdBy: "parent")
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            agents.CreateAsync("child0", restoreRetained: true)
        );
        await agents.RemoveDeletedAsync("replacement", retainMetadata: true, beforeStage: null);
        await agents.CreateAsync("child0", restoreRetained: true);
        Assert.Equal("parent", agents.CreatedBy("child0"));
        Assert.Single(agents.MetadataSnapshot()["child0"]!["rules"]!.AsArray());
    }

    [Fact]
    public async Task Restoration_requires_live_creator_ancestors_and_cleanup_cannot_break_retained_descendants()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "agents.json"),
            """
            {"parent":{"rules":[{"tool":"skill","action":"deny"}]},
             "child":{"createdBy":"parent","rules":[]},
             "grand":{"createdBy":"child","rules":[]}}
            """
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            temp.Path,
            paths.AgentsRoot,
            options,
            HostModels.ForTest(options),
            hostPaths: paths
        );
        await manager.LoadAsync();
        var before = manager.AgentMetadata.ToJsonString();
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.RestoreRetainedAgentAsync("child")
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.CleanupRetainedAgentAsync("parent")
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.CleanupRetainedAgentAsync("child")
        );
        Assert.Equal(before, manager.AgentMetadata.ToJsonString());
        Assert.DoesNotContain("child", manager.Agents());
        await manager.RestoreRetainedAgentAsync("parent");
        await manager.RestoreRetainedAgentAsync("child");
        var owner = await manager.CreateNamedAsync("child", "new-lifetime", null, null);
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new("skill", "builtin", "skill", new JsonObject { ["action"] = "list" }),
                null,
                default
            )
        );
        await manager.CleanupRetainedAgentAsync("grand");
        Assert.Null(manager.AgentMetadata["grand"]);
        Assert.NotNull(manager.AgentMetadata["child"]);
        Assert.NotNull(manager.AgentMetadata["parent"]);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.CleanupRetainedAgentAsync("parent")
        );
    }
}
