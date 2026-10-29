using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    [Fact]
    public async Task Delegated_session_creation_and_parent_changes_follow_resolved_creator_subtrees()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var grand = await ChildAgent(f, "grand", child);
        var sibling = await ChildAgent(f, "sibling");
        var otherParent = await f.Manager.CreateNamedAsync("child", "other-parent", null, null);
        foreach (var target in new[] { "main", "sibling" })
        {
            Denied(await f.ToolAsync("create_session", new JsonObject { ["agentName"] = target, ["sessionName"] = "forbidden" }, child));
            Denied(await f.ToolAsync("create_child_session", new JsonObject { ["agentName"] = target, ["suffix"] = "forbidden" }, child));
            Assert.Null(f.Manager.Catalog.Get(target + "/forbidden"));
        }
        foreach (var target in new[] { "child", "grand" })
        {
            Successful(await f.ToolAsync("create_session", new JsonObject { ["agentName"] = target, ["sessionName"] = "allowed" }, child));
            Successful(await f.ToolAsync("create_child_session", new JsonObject { ["agentName"] = target, ["suffix"] = "worker" }, child));
        }
        foreach (var parent in new[] { f.Owner.Id, sibling.Id })
        {
            Denied(await f.ToolAsync("create_session", new JsonObject { ["agentName"] = "child", ["sessionName"] = "bad-parent", ["parentSessionId"] = parent }, child));
            Denied(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["sessionId"] = otherParent.Id, ["parentSessionId"] = parent }, child));
        }
        foreach (var parent in new[] { otherParent.Id, grand.Id })
        {
            Successful(await f.ToolAsync("create_session", new JsonObject { ["agentName"] = "child", ["sessionName"] = "parent-" + parent.Split('/')[0], ["parentSessionId"] = parent }, child));
            Successful(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = parent }, child));
            Assert.Equal(parent, child.Metadata().ParentSessionId);
        }
        var alias = grand.Id;
        await f.Manager.MoveIdentityAsync(grand, new JsonObject { ["newSessionId"] = "renamed-parent" });
        Successful(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = alias }, child));
        Assert.Equal(grand.Id, child.Metadata().ParentSessionId);
        Successful(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = null }, child));
        Assert.Null(child.Metadata().ParentSessionId);
        // A model in a top-level Agent retains arbitrary existing parent and cross-Agent creation paths.
        Successful(await f.ToolAsync("create_session", new JsonObject { ["agentName"] = "sibling", ["sessionName"] = "top-level", ["parentSessionId"] = grand.Id }));
        Successful(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = sibling.Id }));
        Denied(await f.ToolAsync("move_session", new JsonObject { ["newAgentName"] = "main", ["newSessionId"] = "escape" }, child));
        Denied(await f.ToolAsync("move_session", new JsonObject { ["sessionId"] = grand.Id, ["newAgentName"] = "sibling", ["newSessionId"] = "escape" }, child));
        Successful(await f.ToolAsync("move_session", new JsonObject { ["newSessionId"] = "renamed", ["parentSessionId"] = grand.Id }, child));
        Assert.Equal("child", child.Agent);
        Successful(await f.ToolAsync("move_session", new JsonObject { ["newAgentName"] = "sibling", ["newSessionId"] = "moved-top-level" }));
        Assert.Equal("sibling", f.Owner.Agent);
        // Administration can still explicitly create a child outside the selected parent's Agent tree.
        var administrative = await f.Manager.CreateChildAsync(child, "admin-child", "sibling", null, null, null, userInitiated: true);
        Assert.Equal("sibling", administrative.Child.Agent);
    }

    [Fact]
    public async Task Timer_creation_and_updates_validate_effective_owner_defaults_and_retained_targets()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var grand = await ChildAgent(f, "grand", child);
        var sibling = await ChildAgent(f, "sibling");
        JsonObject Creation(string? agent = null, string? owner = null)
        {
            var args = new JsonObject { ["afterSeconds"] = 3600, ["message"] = "later", ["newSession"] = true };
            if (agent is not null) args["agentName"] = agent;
            if (owner is not null) args["sessionId"] = owner;
            return args;
        }
        Denied(await f.ToolAsync("create_timer", Creation("main"), child));
        Denied(await f.ToolAsync("create_timer", Creation("sibling"), child));
        Denied(await f.ToolAsync("create_timer", Creation(owner: sibling.Id), child));
        Assert.Empty(f.Manager.Timers.List(child.Id));
        Assert.Empty(f.Manager.Timers.List(sibling.Id));
        var created = await f.ToolAsync("create_timer", Creation("grand", sibling.Id), child);
        Successful(created);
        Assert.Equal("grand", SessionWait.Text(created!["timer"]!["agentName"]));
        var id = SessionWait.Text(created["timer"]!["id"])!;
        Successful(await f.ToolAsync("update_timer", new JsonObject { ["timerId"] = id, ["sessionId"] = sibling.Id, ["message"] = "retained descendant target" }, child));
        Denied(await f.ToolAsync("update_timer", new JsonObject { ["timerId"] = id, ["sessionId"] = sibling.Id, ["agentName"] = "main" }, child));
        Assert.Equal("grand", SessionWait.Text(f.Manager.Timers.Get(id, sibling.Id)["agentName"]));
        // Changing an existing timer must inspect its retained target even when the patch omits agentName/newSession.
        var foreign = await f.ToolAsync("create_timer", Creation("sibling"));
        Successful(foreign);
        var foreignId = SessionWait.Text(foreign!["timer"]!["id"])!;
        Denied(await f.ToolAsync("update_timer", new JsonObject { ["timerId"] = foreignId, ["sessionId"] = f.Owner.Id, ["message"] = "must not change" }, child));
        Assert.Equal("later", SessionWait.Text(f.Manager.Timers.Get(foreignId, f.Owner.Id)["message"]));
        // Enabling fresh creation on an ordinary foreign-owner timer resolves that owner's Agent.
        var ordinary = await f.ToolAsync("create_timer", new JsonObject { ["sessionId"] = sibling.Id, ["afterSeconds"] = 3600, ["message"] = "ordinary" });
        Successful(ordinary);
        Denied(await f.ToolAsync("update_timer", new JsonObject { ["timerId"] = ordinary!["timer"]!["id"]!.DeepClone(), ["sessionId"] = sibling.Id, ["newSession"] = true }, child));
        // Firing uses the stored resolved destination, not the selected owner's Agent or a new caller identity.
        var delivered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.TimerSessionName = _ => "fired";
        f.Manager.Timers.Diagnostic = (_, error) => { if (error is not null) delivered.TrySetException(error); };
        f.Manager.BeforeCreationPublication = id => { if (id == "grand/fired") delivered.TrySetResult(); return Task.CompletedTask; };
        var firing = await f.ToolAsync("create_timer", new JsonObject { ["sessionId"] = sibling.Id, ["agentName"] = "grand", ["afterSeconds"] = 0.1, ["message"] = "descendant", ["newSession"] = true }, child);
        Successful(firing);
        await delivered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotNull(await f.Manager.GetExistingAsync("grand/fired"));
    }

    [Fact]
    public async Task Inheritance_limits_and_deletion_keep_creator_authority_and_legacy_isolation()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var grand = await ChildAgent(f, "grand", child);
        var sibling = await ChildAgent(f, "sibling");
        Successful(await f.ToolAsync("set_agent_inherit", new JsonObject { ["agentName"] = "grand", ["inheritAgentName"] = "main" }, child));
        Denied(await f.ToolAsync("set_agent_inherit", new JsonObject { ["agentName"] = "grand", ["inheritAgentName"] = "sibling" }, child));
        Assert.Equal("main", f.Manager.AgentInherit("grand"));
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Manager.DeleteAgentAsync("child"));
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Manager.DeleteAgentFromCommandAsync("child"));
        Assert.NotNull(f.Manager.Catalog.Get(child.Id));
        await f.Manager.SetAgentRulesAsync("grand", Rules("""[{"action":"deny","tool":"skill"}]"""));
        await f.Manager.DeleteAgentFromCommandAsync("grand");
        Denied(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "grand", ["createMainSession"] = false }, child));
        Assert.Equal("child", SessionWait.Text(f.Manager.AgentMetadata["grand"]!["createdBy"]));
        f.Manager.Nodes.Registry.Create("isolated-node");
        await f.Manager.SetAgentIsolationAsync("child", "isolated-node", true, null);
        Denied(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "isolated-child" }, child));
        Denied(await f.ToolAsync("set_agent_rules", new JsonObject { ["agentName"] = "grand", ["rules"] = new JsonArray() }, child));
        var outside = Path.Combine(f.Work, "forbidden.txt");
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"allow"}]"""));
        Denied(await f.ToolAsync("write", new JsonObject { ["filePath"] = outside, ["content"] = "denied" }, child));
        Assert.False(File.Exists(outside));
    }

    [Fact]
    public async Task Default_Node_is_new_session_placement_with_explicit_selection_and_legacy_binding_precedence()
    {
        await using var f = await Fixture();
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "placed", ["defaultNode"] = "default-offline" }));
        var main = await f.Manager.RequiredAsync("placed/main");
        Assert.Equal("default-offline", f.Manager.CurrentNode(main));
        await f.Manager.SetAgentDefaultNodeAsync("placed", "updated-offline");
        Assert.Equal("default-offline", f.Manager.CurrentNode(main));
        var automatic = await f.Manager.CreateNamedAsync("placed", "automatic", null, null);
        Assert.Equal("updated-offline", f.Manager.CurrentNode(automatic));
        Successful(await f.ToolAsync("create_session", new JsonObject { ["agentName"] = "placed", ["sessionName"] = "tool-default" }));
        Assert.Equal("updated-offline", f.Manager.CurrentNode(await f.Manager.RequiredAsync("placed/tool-default")));
        var router = new Foxwarm.MessageRouter(new SessionRuntime(f.Manager));
        await router.HandleMessageAsync(new Foxwarm.ChannelContext(f.Owner.Id, "webui"), new Foxwarm.ChannelMessage("/session create placed command-default", null));
        Assert.Equal("updated-offline", f.Manager.CurrentNode(await f.Manager.RequiredAsync("placed/command-default")));
        var explicitMain = await f.Manager.CreateNamedAsync("placed", "explicit", null, null, initialNode: "master");
        Assert.Equal("master", f.Manager.CurrentNode(explicitMain));
        var fork = await f.Manager.ForkAsync(main, "fork");
        Assert.Equal("updated-offline", f.Manager.CurrentNode(fork));
        Successful(await f.ToolAsync("create_child_session", new JsonObject { ["suffix"] = "fork-explicit", ["fork"] = true, ["node"] = "master" }, main));
        Assert.Equal("master", f.Manager.CurrentNode(await f.Manager.RequiredAsync("placed/fork-explicit")));
        f.Manager.Nodes.Registry.Create("bound-node");
        await f.Manager.SetAgentNodeAsync("placed", "bound-node");
        var bound = await f.Manager.CreateNamedAsync("placed", "bound", null, null, initialNode: "master");
        Assert.Equal("bound-node", f.Manager.CurrentNode(bound));
        await f.Manager.SetAgentRulesAsync("placed", Rules("""[{"tool":"exec","action":"deny"}]"""));
        Assert.False(f.Manager.ToolVisible(bound, "node", "exec", node: "bound-node"));
    }
}
