using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class NodeRemovalTests
{
    [Fact]
    public async Task Removal_is_discoverable_not_default_and_normal_policy_denial_preserves_credentials()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        await using var manager = new SessionManager(data, work, options, HostModels.ForTest(options));
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "remove", null, null, initialNode: "offline");
        await using var mcp = new Foxwarm.McpClient(data);
        var definitions = NodeToolDefinitions.All();
        foreach (var definition in UnifiedToolDefinitions.All()) definitions.Add(definition?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work, manager.Nodes);
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        async Task<JsonObject> Call(string name, JsonObject args) => (await tools.ExecuteAsync(new JsonObject { ["name"] = name, ["args"] = args }, default))!.AsObject();
        Assert.DoesNotContain(registry.ModelDefinitions(), definition => definition!["name"]!.GetValue<string>() == "node_remove");
        var found = await Call("search_tools", new JsonObject { ["query"] = "node_remove", ["sources"] = new JsonArray("builtin"), ["limit"] = 1 });
        Assert.Contains("builtin:node_remove", found["output"]!.GetValue<string>());
        var credential = manager.Nodes.Registry.Create("offline");
        var auth = credential["authToken"]!.GetValue<string>();
        var marker = Path.Combine(work, "retained.txt");
        await File.WriteAllTextAsync(marker, "not environment destruction");
        await File.WriteAllTextAsync(Path.Combine(data, "state", "tool-authorization.yaml"), "version: 1\nrules:\n- id: revoke\n  action: deny\n  match:\n    tool: {source: builtin, name: node_remove}\n");
        manager.Authorization.Invalidate();
        var denied = await Call("call_tool", new JsonObject { ["toolId"] = "builtin:node_remove", ["args"] = new JsonObject { ["nodeId"] = "offline" } });
        Assert.Equal("tool_authorization_denied", denied["error"]!["type"]!.GetValue<string>());
        Assert.True(manager.Nodes.Registry.Authenticate("offline", auth));
        await File.WriteAllTextAsync(Path.Combine(data, "state", "tool-authorization.yaml"), "version: 1\nrules: []\n");
        manager.Authorization.Invalidate();
        var removed = await Call("call_tool", new JsonObject { ["toolId"] = "builtin:node_remove", ["args"] = new JsonObject { ["nodeId"] = "offline" } });
        Assert.Null(removed["error"]);
        Assert.Equal("offline", removed["nodeId"]!.GetValue<string>());
        Assert.False(removed["disconnected"]!.GetValue<bool>());
        Assert.False(new ApprovedNodeRegistry(data).Authenticate("offline", auth));
        Assert.Equal("offline", manager.CurrentNode(owner));
        Assert.NotNull(manager.Catalog.Get(owner.Id));
        Assert.Equal("not environment destruction", await File.ReadAllTextAsync(marker));
    }
}
