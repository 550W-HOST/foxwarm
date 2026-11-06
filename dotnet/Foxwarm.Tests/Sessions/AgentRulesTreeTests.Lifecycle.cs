using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
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
            Denied(
                await f.ToolAsync(
                    "create_session",
                    new JsonObject { ["agentName"] = target, ["sessionName"] = "forbidden" },
                    child
                )
            );
            Denied(
                await f.ToolAsync(
                    "create_child_session",
                    new JsonObject { ["agentName"] = target, ["suffix"] = "forbidden" },
                    child
                )
            );
            Assert.Null(f.Manager.Catalog.Get(target + "/forbidden"));
        }
        foreach (var target in new[] { "child", "grand" })
        {
            Successful(
                await f.ToolAsync(
                    "create_session",
                    new JsonObject { ["agentName"] = target, ["sessionName"] = "allowed" },
                    child
                )
            );
            Successful(
                await f.ToolAsync(
                    "create_child_session",
                    new JsonObject { ["agentName"] = target, ["suffix"] = "worker" },
                    child
                )
            );
        }
        foreach (var parent in new[] { f.Owner.Id, sibling.Id })
        {
            Denied(
                await f.ToolAsync(
                    "create_session",
                    new JsonObject
                    {
                        ["agentName"] = "child",
                        ["sessionName"] = "bad-parent",
                        ["parentSessionId"] = parent,
                    },
                    child
                )
            );
            Denied(
                await f.ToolAsync(
                    "session",
                    new JsonObject
                    {
                        ["action"] = "update-parent",
                        ["sessionId"] = otherParent.Id,
                        ["parentSessionId"] = parent,
                    },
                    child
                )
            );
        }
        foreach (var parent in new[] { otherParent.Id, grand.Id })
        {
            Successful(
                await f.ToolAsync(
                    "create_session",
                    new JsonObject
                    {
                        ["agentName"] = "child",
                        ["sessionName"] = "parent-" + parent.Split('/')[0],
                        ["parentSessionId"] = parent,
                    },
                    child
                )
            );
            Successful(
                await f.ToolAsync(
                    "session",
                    new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = parent },
                    child
                )
            );
            Assert.Equal(parent, child.Metadata().ParentSessionId);
        }
        var alias = grand.Id;
        await f.Manager.MoveIdentityAsync(
            grand,
            new JsonObject { ["newSessionId"] = "renamed-parent" }
        );
        Successful(
            await f.ToolAsync(
                "session",
                new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = alias },
                child
            )
        );
        Assert.Equal(grand.Id, child.Metadata().ParentSessionId);
        Successful(
            await f.ToolAsync(
                "session",
                new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = null },
                child
            )
        );
        Assert.Null(child.Metadata().ParentSessionId);
        // A model in a top-level Agent retains arbitrary existing parent and cross-Agent creation paths.
        Successful(
            await f.ToolAsync(
                "create_session",
                new JsonObject
                {
                    ["agentName"] = "sibling",
                    ["sessionName"] = "top-level",
                    ["parentSessionId"] = grand.Id,
                }
            )
        );
        Successful(
            await f.ToolAsync(
                "session",
                new JsonObject { ["action"] = "update-parent", ["parentSessionId"] = sibling.Id }
            )
        );
        Denied(
            await f.ToolAsync(
                "move_session",
                new JsonObject { ["newAgentName"] = "main", ["newSessionId"] = "escape" },
                child
            )
        );
        Denied(
            await f.ToolAsync(
                "move_session",
                new JsonObject
                {
                    ["sessionId"] = grand.Id,
                    ["newAgentName"] = "sibling",
                    ["newSessionId"] = "escape",
                },
                child
            )
        );
        Successful(
            await f.ToolAsync(
                "move_session",
                new JsonObject { ["newSessionId"] = "renamed", ["parentSessionId"] = grand.Id },
                child
            )
        );
        Assert.Equal("child", child.Agent);
        Successful(
            await f.ToolAsync(
                "move_session",
                new JsonObject
                {
                    ["newAgentName"] = "sibling",
                    ["newSessionId"] = "moved-top-level",
                }
            )
        );
        Assert.Equal("sibling", f.Owner.Agent);
        // Administration can still explicitly create a child outside the selected parent's Agent tree.
        var administrative = await f.Manager.CreateChildAsync(
            child,
            "admin-child",
            "sibling",
            null,
            null,
            null,
            userInitiated: true
        );
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
            var args = new JsonObject
            {
                ["afterSeconds"] = 3600,
                ["message"] = "later",
                ["newSession"] = true,
            };
            if (agent is not null)
                args["agentName"] = agent;
            if (owner is not null)
                args["sessionId"] = owner;
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
        Successful(
            await f.ToolAsync(
                "update_timer",
                new JsonObject
                {
                    ["timerId"] = id,
                    ["sessionId"] = sibling.Id,
                    ["message"] = "retained descendant target",
                },
                child
            )
        );
        Denied(
            await f.ToolAsync(
                "update_timer",
                new JsonObject
                {
                    ["timerId"] = id,
                    ["sessionId"] = sibling.Id,
                    ["agentName"] = "main",
                },
                child
            )
        );
        Assert.Equal("grand", SessionWait.Text(f.Manager.Timers.Get(id, sibling.Id)["agentName"]));
        // Changing an existing timer must inspect its retained target even when the patch omits agentName/newSession.
        var foreign = await f.ToolAsync("create_timer", Creation("sibling"));
        Successful(foreign);
        var foreignId = SessionWait.Text(foreign!["timer"]!["id"])!;
        Denied(
            await f.ToolAsync(
                "update_timer",
                new JsonObject
                {
                    ["timerId"] = foreignId,
                    ["sessionId"] = f.Owner.Id,
                    ["message"] = "must not change",
                },
                child
            )
        );
        Assert.Equal(
            "later",
            SessionWait.Text(f.Manager.Timers.Get(foreignId, f.Owner.Id)["message"])
        );
        // Enabling fresh creation on an ordinary foreign-owner timer resolves that owner's Agent.
        var ordinary = await f.ToolAsync(
            "create_timer",
            new JsonObject
            {
                ["sessionId"] = sibling.Id,
                ["afterSeconds"] = 3600,
                ["message"] = "ordinary",
            }
        );
        Successful(ordinary);
        Denied(
            await f.ToolAsync(
                "update_timer",
                new JsonObject
                {
                    ["timerId"] = ordinary!["timer"]!["id"]!.DeepClone(),
                    ["sessionId"] = sibling.Id,
                    ["newSession"] = true,
                },
                child
            )
        );
        // Firing uses the stored resolved destination, not the selected owner's Agent or a new caller identity.
        var delivered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        f.Manager.TimerSessionName = _ => "fired";
        f.Manager.Timers.Diagnostic = (_, error) =>
        {
            if (error is not null)
                delivered.TrySetException(error);
        };
        f.Manager.BeforeCreationPublication = id =>
        {
            if (id == "grand/fired")
                delivered.TrySetResult();
            return Task.CompletedTask;
        };
        var firing = await f.ToolAsync(
            "create_timer",
            new JsonObject
            {
                ["sessionId"] = sibling.Id,
                ["agentName"] = "grand",
                ["afterSeconds"] = 0.1,
                ["message"] = "descendant",
                ["newSession"] = true,
            },
            child
        );
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
        Successful(
            await f.ToolAsync(
                "set_agent_inherit",
                new JsonObject { ["agentName"] = "grand", ["inheritAgentName"] = "main" },
                child
            )
        );
        Denied(
            await f.ToolAsync(
                "set_agent_inherit",
                new JsonObject { ["agentName"] = "grand", ["inheritAgentName"] = "sibling" },
                child
            )
        );
        Assert.Equal("main", f.Manager.AgentInherit("grand"));
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Manager.DeleteAgentAsync("child"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.DeleteAgentFromCommandAsync("child")
        );
        Assert.NotNull(f.Manager.Catalog.Get(child.Id));
        await f.Manager.SetAgentRulesAsync(
            "grand",
            Rules("""[{"action":"deny","tool":"skill"}]""")
        );
        await f.Manager.DeleteAgentFromCommandAsync("grand");
        Denied(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "grand", ["createMainSession"] = false },
                child
            )
        );
        Assert.Equal("child", SessionWait.Text(f.Manager.AgentMetadata["grand"]!["createdBy"]));
        f.Manager.Nodes.Registry.Create("isolated-node");
        await f.Manager.SetAgentIsolationAsync("child", "isolated-node", true, null);
        Denied(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "isolated-child" },
                child
            )
        );
        Denied(
            await f.ToolAsync(
                "set_agent_rules",
                new JsonObject { ["agentName"] = "grand", ["rules"] = new JsonArray() },
                child
            )
        );
        var outside = Path.Combine(f.Work, "forbidden.txt");
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"allow"}]"""));
        Denied(
            await f.ToolAsync(
                "write",
                new JsonObject { ["filePath"] = outside, ["content"] = "denied" },
                child
            )
        );
        Assert.False(File.Exists(outside));
    }

    private static void AssertBoundary(
        SessionOwner owner,
        string boundaryEvent,
        string sessionId,
        string cwd
    )
    {
        var notice = SystemTexts(owner)
            .Select(text => text.Split('\n')[0])
            .Where(line =>
                line.StartsWith(
                    "<foxwarm-system kind=\"session-boundary\"",
                    StringComparison.Ordinal
                )
            )
            .Select(line => System.Xml.Linq.XElement.Parse(line))
            .Single(element => element.Attribute("event")?.Value == boundaryEvent);
        Assert.Equal("workspace/main", notice.Attribute("parentSessionId")?.Value);
        Assert.Equal(sessionId, notice.Attribute("currentSessionId")?.Value);
        Assert.Equal("dev-offline", notice.Attribute("currentNode")?.Value);
        Assert.Equal(cwd, notice.Attribute("cwd")?.Value);
    }

    private static IEnumerable<string> SystemTexts(SessionOwner owner) =>
        owner
            .Entry.Snapshot()
            .History.Materialize()
            .SelectMany(message => (message["parts"] as JsonArray) ?? [])
            .Select(part => SessionWait.Text(part?["system"]))
            .OfType<string>();

    [Fact]
    public async Task Default_working_directory_applies_to_new_sessions_on_the_default_Node()
    {
        // Paths are locators: notices must not normalize their whitespace or markup characters.
        const string Repo = "/srv/two  words/<repo>";
        await using var f = await Fixture();
        Denied(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "relative", ["defaultCwd"] = "repo" }
            )
        );
        Assert.DoesNotContain("relative", f.Manager.Agents());
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "workspace",
                    ["defaultNode"] = "dev-offline",
                    ["defaultCwd"] = Repo,
                }
            )
        );
        var main = await f.Manager.RequiredAsync("workspace/main");
        Assert.Equal(("dev-offline", Repo), f.Manager.ExecutionPlacement(main));
        var automatic = await f.Manager.CreateNamedAsync("workspace", "automatic", null, null);
        Assert.Equal(("dev-offline", Repo), f.Manager.ExecutionPlacement(automatic));
        var elsewhere = await f.Manager.CreateNamedAsync(
            "workspace",
            "elsewhere",
            null,
            null,
            initialNode: "master"
        );
        Assert.Equal(("master", (string?)null), f.Manager.ExecutionPlacement(elsewhere));

        var fork = await f.Manager.ForkAsync(main, "fork");
        Assert.Equal(("dev-offline", Repo), f.Manager.ExecutionPlacement(fork));
        AssertBoundary(fork, "history-inherited", "workspace/main_fork", Repo);
        Successful(
            await f.ToolAsync("create_child_session", new JsonObject { ["suffix"] = "child" }, main)
        );
        var child = await f.Manager.RequiredAsync("workspace/child");
        Assert.Equal(("dev-offline", Repo), f.Manager.ExecutionPlacement(child));
        AssertBoundary(child, "new-child", "workspace/child", Repo);

        // Without a default Node, the directory belongs to master.
        await f.Manager.SetAgentDefaultPlacementAsync("workspace", true, null, true, "/home/repo");
        var onMaster = await f.Manager.CreateNamedAsync(
            "workspace",
            "on-master",
            null,
            null,
            initialNode: "master"
        );
        Assert.Equal(("master", "/home/repo"), f.Manager.ExecutionPlacement(onMaster));
        // The main Session's Node is not a fallback, so it starts on master with the directory.
        var fallback = await f.Manager.CreateNamedAsync("workspace", "fallback", null, null);
        Assert.Equal(("master", "/home/repo"), f.Manager.ExecutionPlacement(fallback));
        Assert.Equal(("dev-offline", Repo), f.Manager.ExecutionPlacement(main));
    }

    [Fact]
    public async Task Installation_default_Node_places_Agents_without_their_own_default()
    {
        await using var f = await Fixture();
        string Node(SessionOwner owner) => f.Manager.CurrentNode(owner);
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "legacy", ["defaultNode"] = "legacy-offline" }
            )
        );
        var legacyMain = await f.Manager.RequiredAsync("legacy/main");
        await f.Manager.SetAgentDefaultPlacementAsync("legacy", true, null, false, null);
        // The main Session's Node is no longer a fallback.
        var before = await f.Manager.CreateNamedAsync("legacy", "before", null, null);
        Assert.Equal("master", Node(before));

        var saved = await f.Configuration.SaveAppAsync("agentDefaultNode: install-offline\n");
        Assert.Contains("agentDefaultNode", saved["applied"]!.AsArray().Select(v => v!.ToString()));
        Assert.DoesNotContain(
            "agentDefaultNode",
            saved["restartRequired"]!.AsArray().Select(v => v!.ToString())
        );
        // Existing selections stay; the caller's Node is not a fallback.
        Assert.Equal("legacy-offline", Node(legacyMain));
        Assert.Equal(
            "install-offline",
            Node(await f.Manager.CreateNamedAsync("legacy", "after", null, null))
        );
        Assert.Equal("master", Node(f.Owner));
        Successful(
            await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "plain" })
        );
        var plain = await f.Manager.RequiredAsync("plain/main");
        Assert.Equal("install-offline", Node(plain));
        Assert.Null(f.Manager.AgentMetadata["plain"]?["defaultNode"]);
        // A same-Agent fork follows its parent before any default.
        Assert.Equal("master", Node(await f.Manager.ForkAsync(f.Owner, "fork")));
        // A cross-Agent child of a master caller uses the target's installation default.
        Successful(
            await f.ToolAsync(
                "create_child_session",
                new JsonObject { ["suffix"] = "child", ["agentName"] = "plain" }
            )
        );
        Assert.Equal("install-offline", Node(await f.Manager.RequiredAsync("plain/child")));
        await f.Manager.SetAgentDefaultPlacementAsync("plain", false, null, true, "/srv/plain");
        Assert.Equal(
            ("install-offline", "/srv/plain"),
            f.Manager.ExecutionPlacement(
                await f.Manager.CreateNamedAsync("plain", "cwd", null, null)
            )
        );

        // An Agent's own default, including explicit master, and explicit selection win.
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "own", ["defaultNode"] = "own-offline" }
            )
        );
        Assert.Equal("own-offline", Node(await f.Manager.RequiredAsync("own/main")));
        await f.Manager.SetAgentDefaultPlacementAsync("own", true, "master", true, "/srv/own");
        Assert.Equal(
            ("master", "/srv/own"),
            f.Manager.ExecutionPlacement(await f.Manager.CreateNamedAsync("own", "m", null, null))
        );
        Assert.Equal(
            "explicit-offline",
            Node(
                await f.Manager.CreateNamedAsync(
                    "plain",
                    "explicit",
                    null,
                    null,
                    initialNode: "explicit-offline"
                )
            )
        );

        // Clearing it leaves master.
        await f.Configuration.SaveAppAsync("bot:\n  name: fox\n");
        Assert.Equal(
            "master",
            Node(await f.Manager.CreateNamedAsync("legacy", "cleared", null, null))
        );
    }

    [Fact]
    public async Task Same_Agent_parent_Node_outranks_Agent_and_installation_defaults()
    {
        await using var f = await Fixture();
        string Node(SessionOwner owner) => f.Manager.CurrentNode(owner);
        await f.Configuration.SaveAppAsync("agentDefaultNode: install-offline\n");
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject
                {
                    ["agentName"] = "fam",
                    ["defaultNode"] = "fam-default",
                    ["defaultCwd"] = "/srv/fam",
                }
            )
        );
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "other", ["defaultNode"] = "other-default" }
            )
        );
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "plain" }));
        var main = await f.Manager.RequiredAsync("fam/main");
        Assert.Equal(("fam-default", "/srv/fam"), f.Manager.ExecutionPlacement(main));
        await main.Entry.SaveLane.CommitNodeAsync("moved-offline", clearCwd: true);

        // Children, forks and WebUI children of a same-Agent parent follow its current Node;
        // the default directory belongs to the default Node only.
        Successful(
            await f.ToolAsync("create_child_session", new JsonObject { ["suffix"] = "c" }, main)
        );
        Assert.Equal(
            ("moved-offline", (string?)null),
            f.Manager.ExecutionPlacement(await f.Manager.RequiredAsync("fam/c"))
        );
        Assert.Equal("moved-offline", Node(await f.Manager.ForkAsync(main, "fork")));
        Assert.Equal(
            "moved-offline",
            Node(await f.Manager.CreateUserChildAsync("fam", "web", main.Id))
        );
        Successful(
            await f.ToolAsync(
                "create_child_session",
                new JsonObject { ["suffix"] = "pinned", ["node"] = "master" },
                main
            )
        );
        Assert.Equal("master", Node(await f.Manager.RequiredAsync("fam/pinned")));

        // Cross-Agent children start from the target Agent's defaults, not the parent's Node.
        await f.Owner.Entry.SaveLane.CommitNodeAsync("owner-offline", clearCwd: true);
        Successful(
            await f.ToolAsync(
                "create_child_session",
                new JsonObject { ["suffix"] = "x", ["agentName"] = "other" }
            )
        );
        Successful(
            await f.ToolAsync(
                "create_child_session",
                new JsonObject { ["suffix"] = "y", ["agentName"] = "plain" }
            )
        );
        Assert.Equal("install-offline", Node(await f.Manager.RequiredAsync("plain/y")));
        Assert.Equal("other-default", Node(await f.Manager.RequiredAsync("other/x")));
        Assert.Equal(
            "other-default",
            Node(await f.Manager.CreateUserChildAsync("other", "web", main.Id))
        );

        // create_session is not a child: neither its caller nor a recorded parent places it.
        Successful(
            await f.ToolAsync(
                "create_session",
                new JsonObject
                {
                    ["agentName"] = "fam",
                    ["sessionName"] = "tool",
                    ["parentSessionId"] = main.Id,
                },
                main
            )
        );
        Assert.Equal(
            ("fam-default", "/srv/fam"),
            f.Manager.ExecutionPlacement(await f.Manager.RequiredAsync("fam/tool"))
        );
    }

    [Theory]
    [InlineData("agentDefaultNode: [a]\n")]
    [InlineData("agentDefaultNode: bad node\n")]
    public void Invalid_installation_default_Node_is_rejected(string yaml)
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(Path.Combine(temp.Path, "state", "config.yaml"), yaml);
        var error = Assert.Throws<InvalidDataException>(() => new ModelConfiguration(temp.Path));
        Assert.Contains("agentDefaultNode", error.Message);
    }

    [Fact]
    public async Task Default_Node_is_new_session_placement_with_explicit_selection_and_legacy_binding_precedence()
    {
        await using var f = await Fixture();
        Successful(
            await f.ToolAsync(
                "create_agent",
                new JsonObject { ["agentName"] = "placed", ["defaultNode"] = "default-offline" }
            )
        );
        var main = await f.Manager.RequiredAsync("placed/main");
        Assert.Equal("default-offline", f.Manager.CurrentNode(main));
        await f.Manager.SetAgentDefaultPlacementAsync(
            "placed",
            true,
            "updated-offline",
            false,
            null
        );
        Assert.Equal("default-offline", f.Manager.CurrentNode(main));
        var automatic = await f.Manager.CreateNamedAsync("placed", "automatic", null, null);
        Assert.Equal("updated-offline", f.Manager.CurrentNode(automatic));
        Successful(
            await f.ToolAsync(
                "create_session",
                new JsonObject { ["agentName"] = "placed", ["sessionName"] = "tool-default" }
            )
        );
        Assert.Equal(
            "updated-offline",
            f.Manager.CurrentNode(await f.Manager.RequiredAsync("placed/tool-default"))
        );
        var router = new Foxwarm.MessageRouter(new SessionRuntime(f.Manager));
        await router.HandleMessageAsync(
            new Foxwarm.ChannelContext(f.Owner.Id, "webui"),
            new Foxwarm.ChannelMessage("/session create placed command-default", null)
        );
        Assert.Equal(
            "updated-offline",
            f.Manager.CurrentNode(await f.Manager.RequiredAsync("placed/command-default"))
        );
        var explicitMain = await f.Manager.CreateNamedAsync(
            "placed",
            "explicit",
            null,
            null,
            initialNode: "master"
        );
        Assert.Equal("master", f.Manager.CurrentNode(explicitMain));
        // A same-Agent fork follows its parent, not the updated Agent default.
        var fork = await f.Manager.ForkAsync(main, "fork");
        Assert.Equal("default-offline", f.Manager.CurrentNode(fork));
        Successful(
            await f.ToolAsync(
                "create_child_session",
                new JsonObject
                {
                    ["suffix"] = "fork-explicit",
                    ["fork"] = true,
                    ["node"] = "master",
                },
                main
            )
        );
        Assert.Equal(
            "master",
            f.Manager.CurrentNode(await f.Manager.RequiredAsync("placed/fork-explicit"))
        );
        f.Manager.Nodes.Registry.Create("bound-node");
        await f.Manager.SetAgentNodeAsync("placed", "bound-node");
        var bound = await f.Manager.CreateNamedAsync(
            "placed",
            "bound",
            null,
            null,
            initialNode: "master"
        );
        Assert.Equal("bound-node", f.Manager.CurrentNode(bound));
        await f.Manager.SetAgentRulesAsync(
            "placed",
            Rules("""[{"tool":"exec","action":"deny"}]""")
        );
        Assert.False(f.Manager.ToolVisible(bound, "node", "exec", node: "bound-node"));
    }
}
