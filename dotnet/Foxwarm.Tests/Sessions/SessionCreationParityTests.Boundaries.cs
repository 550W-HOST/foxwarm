using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    [Fact]
    public async Task Unbound_channel_and_single_Agent_guest_use_the_same_automatic_name_without_real_transports()
    {
        var guest = ExternalChannelFixture.Channel();
        guest["guestAgent"] = new JsonObject { ["agentId"] = "guest", ["isolated"] = false };
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["alpha"] = guest });
        await f.Manager.CreateAgentAsync("guest", false);
        f.Manager.SessionNameClock = () => LocalTime;
        f.Manager.SessionNameRandom = () => 0.5;
        ExternalChannelContext Source(string conversation, string sender) => new("alpha", "telegram", conversation, sender, "synthetic", _ => Task.CompletedTask);
        await f.Router.HandleExternalMessageAsync(Source("ordinary", "11"), new([new JsonObject { ["text"] = "ordinary fixture input" }]));
        await f.Router.HandleExternalMessageAsync(Source("guest", "22"), new([new JsonObject { ["text"] = "guest fixture input" }]));
        Assert.Equal("1231_i", SessionWait.Text(f.Manager.ChannelBinding("alpha:ordinary")?["sessionId"]));
        Assert.Equal("guest/1231_i", SessionWait.Text(f.Manager.ChannelBinding("alpha:guest")?["sessionId"]));
        Assert.True(SessionCatalog.Flag(f.Manager.ChannelBinding("alpha:guest")?["dangerouslyAllowAllUsers"]));
        Assert.Single((await f.Manager.RequiredAsync("1231_i")).Entry.Snapshot().Queue);
        Assert.Single((await f.Manager.RequiredAsync("guest/1231_i")).Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task Child_allocation_keeps_main_replacement_append_cross_Agent_and_archive_counter_rules()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        await f.Manager.CreateAgentAsync("other", false);
        async Task Create(SessionOwner owner, string suffix, string? agent = null, bool fork = false)
        {
            var args = new JsonObject { ["suffix"] = suffix, ["fork"] = fork };
            if (agent is not null) args["agentName"] = agent;
            var response = await f.ToolAsync("create_child_session", args, owner);
            Assert.True(response is JsonObject && response["error"] is null, response?.ToJsonString());
        }
        await Create(f.Owner, "worker");
        await f.Manager.DeleteAsync("source_worker");
        await Create(f.Owner, "worker");
        Assert.NotNull(await f.Manager.GetExistingAsync("source_worker_2"));
        await Create(f.Owner, "worker", "other");
        Assert.Equal("source", (await f.Manager.RequiredAsync("other/worker")).Metadata().ParentSessionId);
        var main = await f.Manager.CreateNamedAsync("other", "main", null, null);
        await Create(main, "from-main");
        Assert.Equal("other/main", (await f.Manager.RequiredAsync("other/from-main")).Metadata().ParentSessionId);
        var response = await f.ToolAsync("create_child_session", new JsonObject { ["suffix"] = "cross-fork", ["agentName"] = "other", ["fork"] = true });
        Assert.NotNull(response!["error"]);
        Assert.Null(f.Manager.Catalog.Get("other/cross-fork"));
    }

    [Fact]
    public async Task Invalid_creation_inputs_do_not_allocate_or_deliver_and_an_isolated_target_keeps_its_binding()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        var initial = f.Manager.Catalog.List().Select(row => SessionWait.Text(row["id"])).ToArray();
        foreach (var patch in new JsonObject[]
        {
            new() { ["parentSessionId"] = "missing" },
            new() { ["node"] = "  " },
            new() { ["systemPromptFiles"] = "not-an-array" },
            new() { ["systemPromptFiles"] = new JsonArray("missing.md") },
            new() { ["sessionName"] = "not.allowed" },
            new() { ["sessionName"] = "not-allowed\n" },
        })
        {
            var args = new JsonObject { ["agentName"] = "main", ["sessionName"] = "invalid-create" };
            foreach (var pair in patch) args[pair.Key] = pair.Value?.DeepClone();
            var response = await f.ToolAsync("create_session", args);
            Assert.NotNull(response!["error"]);
            Assert.Equal(initial, f.Manager.Catalog.List().Select(row => SessionWait.Text(row["id"])).ToArray());
        }
        f.Manager.Nodes.Registry.Create("bound");
        await f.Manager.CreateAgentAsync("isolated", false, isolatedNode: "bound");
        var named = await f.ToolAsync("create_session", new JsonObject { ["agentName"] = "isolated", ["sessionName"] = "named", ["node"] = "master" });
        Assert.True(named is JsonObject && named["error"] is null, named?.ToJsonString());
        Assert.Equal("bound", f.Manager.CurrentNode(await f.Manager.RequiredAsync("isolated/named")));
        var child = await f.ToolAsync("create_child_session", new JsonObject { ["agentName"] = "isolated", ["suffix"] = "child", ["node"] = "master" });
        Assert.True(child is JsonObject && child["error"] is null, child?.ToJsonString());
        Assert.Equal("bound", f.Manager.CurrentNode(await f.Manager.RequiredAsync("isolated/child")));
    }

    [Fact]
    public async Task Task_linked_child_tool_keeps_node_selection_and_delivers_one_assignment()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        var created = await f.Manager.Tasks.ExecuteAsync(new JsonObject { ["action"] = "create", ["title"] = "synthetic child selection" }, f.Owner.Id);
        var taskId = created.Payload["task"]!["id"]!.GetValue<string>();
        var response = await f.ToolAsync("create_child_session", new JsonObject
        {
            ["suffix"] = "assigned", ["node"] = "assignment-node", ["taskId"] = taskId,
        });
        Assert.True(response is JsonObject && response["error"] is null, response?.ToJsonString());
        var child = await f.Manager.RequiredAsync("source_assigned");
        Assert.Equal("assignment-node", f.Manager.CurrentNode(child));
        var item = Assert.Single(child.Entry.Snapshot().Queue);
        Assert.Contains(taskId, System.Text.Json.JsonSerializer.Serialize(item));
        var task = await f.Manager.Tasks.ExecuteAsync(new JsonObject { ["action"] = "get", ["taskId"] = taskId }, f.Owner.Id);
        Assert.Equal(child.Id, SessionWait.Text(task.Payload["task"]!["ownerSessionId"]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Fresh_virtual_or_unconfigured_creation_defers_memory_and_archived_Agent_main_rejection_does_not_create_an_Agent_folder(bool virtualModel)
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        var models = HostModels.Parse(JsonNode.Parse(virtualModel ? """
            {"default":"route","providers":{"local":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]},"route":"local/wire"}}
            """ : "{\"providers\":{}}")!.AsObject(), new JsonObject());
        await using var manager = new SessionManager(data, work, options, models);
        await manager.LoadAsync();
        manager.SessionNameClock = () => LocalTime;
        manager.SessionNameRandom = () => 0.5;
        var ordinary = await manager.CreateAsync();
        Assert.Equal("", SessionWait.Text(ordinary.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]));
        await manager.CreateAgentAsync("retained");
        var agentDirectory = manager.AgentDirectory("retained");
        await manager.DeleteAgentAsync("retained");
        await Assert.ThrowsAsync<InvalidDataException>(() => manager.CreateAgentAsync("retained"));
        Assert.False(Directory.Exists(agentDirectory));
        var noMain = await manager.CreateAgentAsync("retained", false);
        Assert.Null(noMain.MainSessionId);
    }
}
