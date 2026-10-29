using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    [Fact]
    public async Task Foreign_Session_reparenting_cannot_manufacture_a_child_scoped_read_grant()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var sibling = await ChildAgent(f, "sibling");
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"allow","tool":{"source":"builtin","name":"view_session"},"args":{"sessionId":{"session":{"relation":"child"}}}},{"action":"deny","tool":"view_session"}]"""));
        var read = new JsonObject { ["sessionId"] = sibling.Id };
        Denied(await f.ToolAsync("view_session", read, child));
        var previous = sibling.Metadata().ParentSessionId;
        Denied(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["sessionId"] = sibling.Id, ["parentSessionId"] = child.Id }, child));
        Denied(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["sessionId"] = f.Owner.Id, ["parentSessionId"] = child.Id }, child));
        Assert.Equal(previous, sibling.Metadata().ParentSessionId);
        Denied(await f.ToolAsync("view_session", read, child));
        // A target and parent inside the subtree retain ordinary relationship behavior.
        var peer = await f.Manager.CreateNamedAsync("child", "peer", null, null);
        Successful(await f.ToolAsync("session", new JsonObject { ["action"] = "update-parent", ["sessionId"] = peer.Id, ["parentSessionId"] = child.Id }, child));
        Successful(await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = peer.Id }, child));
    }

    [Fact]
    public async Task Foreign_conversion_cannot_move_retained_history_into_a_readable_descendant()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var sibling = await ChildAgent(f, "sibling");
        await ForkClearLifecycleTests.AppendAsync(sibling, new JsonObject
        {
            ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "foreign-conversion-evidence" }),
        });
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"allow","tool":{"source":"builtin","name":"view_session"},"args":{"sessionId":{"session":{"sameAgent":true}}}},{"action":"deny","tool":"view_session"}]"""));
        var originalId = sibling.Id;
        var snapshot = sibling.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]?.ToJsonString();
        var history = sibling.Entry.Snapshot().History.Select(row => row.ToJson().ToJsonString()).ToArray();
        Denied(await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = sibling.Id }, child));
        Denied(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "converted-foreign", ["convertSession"] = true, ["sourceSessionId"] = sibling.Id }, child));
        Assert.DoesNotContain("converted-foreign", f.Manager.Agents());
        Assert.Equal(originalId, sibling.Id);
        Assert.Equal(snapshot, sibling.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]?.ToJsonString());
        Assert.Equal(history, sibling.Entry.Snapshot().History.Select(row => row.ToJson().ToJsonString()));
        Denied(await f.ToolAsync("create_child_session", new JsonObject { ["agentName"] = "converted-foreign", ["suffix"] = "reader" }, child));
        Assert.Null(f.Manager.Catalog.Get("converted-foreign/reader"));
        Denied(await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = originalId }, child));
        // The ordinary descendant-reader read is available for an authorized same-subtree conversion.
        var source = await f.Manager.CreateNamedAsync("child", "own-source", null, null);
        await ForkClearLifecycleTests.AppendAsync(source, new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "own-conversion-evidence" }) });
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "converted-own", ["convertSession"] = true, ["sourceSessionId"] = source.Id }, child));
        Successful(await f.ToolAsync("create_child_session", new JsonObject { ["agentName"] = "converted-own", ["suffix"] = "reader" }, child));
        var reader = await f.Manager.RequiredAsync("converted-own/reader");
        var read = await f.ToolAsync("view_session", new JsonObject { ["sessionId"] = "converted-own/main" }, reader);
        Successful(read);
        Assert.Contains("own-conversion-evidence", read!.ToJsonString());
        var descendant = await ChildAgent(f, "descendant", child);
        var alias = descendant.Id;
        await f.Manager.MoveIdentityAsync(descendant, new JsonObject { ["newSessionId"] = "selected-alias" });
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "converted-descendant", ["convertSession"] = true, ["inheritMemory"] = true, ["sourceSessionId"] = alias }, child));
        Assert.Equal("converted-descendant/main", descendant.Id);
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "converted-self", ["convertSession"] = true }, child));
        Assert.Equal("converted-self/main", child.Id);
        Assert.Equal("child", SessionWait.Text(f.Manager.AgentMetadata["converted-self"]!["createdBy"]));
    }

    [Fact]
    public async Task Memory_copy_rejects_foreign_sources_before_publication_and_allows_creator_ancestors()
    {
        await using var f = await Fixture();
        var child = await ChildAgent(f, "child");
        var sibling = await ChildAgent(f, "sibling");
        var source = Path.Combine(f.Manager.AgentDirectory("sibling"), "memory", "MEMORY.md");
        Successful(await f.ToolAsync("write", new JsonObject { ["filePath"] = source, ["content"] = "foreign-memory-evidence", ["overwrite"] = true }, sibling));
        await f.Manager.SetAgentRulesAsync("child", Rules("""[{"action":"allow","tool":"read","path":{"allWithin":"${agent.dir}"}},{"action":"deny","tool":"read"}]"""));
        Denied(await f.ToolAsync("read", new JsonObject { ["filePath"] = source }, child));
        Denied(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "copied", ["sourceSessionId"] = sibling.Id, ["inheritMemory"] = true, ["convertSession"] = false }, child));
        Assert.DoesNotContain("copied", f.Manager.Agents());
        Assert.False(Directory.Exists(Path.Combine(f.Work, "agents", "copied")));
        Assert.Null(f.Manager.Catalog.Get("copied/main"));
        Denied(await f.ToolAsync("read", new JsonObject { ["filePath"] = source }, child));
        var ancestor = Path.Combine(f.Manager.AgentDirectory("main"), "memory", "MEMORY.md");
        Successful(await f.ToolAsync("write", new JsonObject { ["filePath"] = ancestor, ["content"] = "ancestor-memory-evidence", ["overwrite"] = true }));
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "ancestor-copy", ["sourceSessionId"] = f.Owner.Id, ["inheritMemory"] = true }, child));
        var copied = await f.Manager.RequiredAsync("ancestor-copy/main");
        var read = await f.ToolAsync("read", new JsonObject { ["filePath"] = Path.Combine(f.Manager.AgentDirectory(copied.Agent), "memory", "MEMORY.md") }, copied);
        Successful(read);
        Assert.Contains("ancestor-memory-evidence", read!.ToJsonString());
        // The ancestor-copy exception cannot authorize identity transfer, including combined flags.
        foreach (var copy in new[] { false, true })
        {
            var name = copy ? "ancestor-combined" : "ancestor-convert";
            Denied(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = name, ["sourceSessionId"] = f.Owner.Id, ["convertSession"] = true, ["inheritMemory"] = copy }, child));
            Assert.DoesNotContain(name, f.Manager.Agents());
            Assert.Equal("main", f.Owner.Agent);
        }
        // Selecting an unrelated existing source only for defaults remains supported.
        Successful(await f.ToolAsync("create_agent", new JsonObject { ["agentName"] = "defaults-only", ["sourceSessionId"] = sibling.Id }, child));
        Assert.False(File.Exists(Path.Combine(f.Manager.AgentDirectory("defaults-only"), "memory", "MEMORY.md")));
    }
}
