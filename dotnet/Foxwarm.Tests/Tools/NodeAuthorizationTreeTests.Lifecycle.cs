using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    private static JsonObject Lifecycle(string action, string? id = null) => new()
    {
        ["action"] = action, ["providerId"] = "fixture", ["nodeId"] = id,
    };

    [Fact]
    public async Task Provider_creates_and_ensures_use_configured_parent_and_actual_existing_identity_before_effects()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var delegated = await f.Child();
        await f.Policy("version: 1\nrules:\n- {tool: node, node: parent, args: {action: create}, action: deny}\n");
        Denied(await f.Call("node", Lifecycle("create", "fixture/blocked"), delegated));
        Assert.Empty(await f.Effects());
        await f.Policy("version: 1\nrules: []\n");
        var create = Lifecycle("create", "fixture/child");
        create["parameters"] = Obj("""{"parentNode":"forged-parent"}""");
        Success(await f.Call("node", create, delegated));
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("fixture/child"));
        Assert.Single(await f.Effects());
        await f.Policy("version: 1\nrules:\n- {tool: node, node: {exact: fixture/child}, args: {action: ensure}, action: deny}\n- {tool: node, node: parent, action: allow}\n");
        Denied(await f.Call("node", Lifecycle("ensure", "fixture/child"), delegated));
        Assert.Single(await f.Effects());
        // A fresh requested identity is delegated through the configured parent, not an opaque option.
        Success(await f.Call("node", Lifecycle("ensure", "fixture/fresh"), delegated));
        Assert.Equal(2, (await f.Effects()).Length);
        var omitted = Lifecycle("ensure");
        omitted.Remove("nodeId");
        Denied(await f.Call("node", omitted, delegated));
        Assert.Equal(2, (await f.Effects()).Length);
        Success(await f.Call("node", omitted));
        Assert.Equal(3, (await f.Effects()).Length);
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("fixture/generated"));
        // Non-subtree policy still applies to the retained top-level omitted-ID path.
        await f.Policy("version: 1\nrules: [{tool: node, args: {action: ensure}, action: deny}]\n");
        Denied(await f.Call("node", omitted));
        Assert.Equal(3, (await f.Effects()).Length);
    }

    [Fact]
    public async Task Actual_provider_file_and_copy_calls_intersect_global_and_agent_subtree_rules_without_merging_endpoint_allows()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var delegated = await f.Child();
        await f.Manager.NodeProviders.ListAsync(default);
        var file = Path.Combine(f.Target, "fs", "root", "read.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await File.WriteAllTextAsync(file, "subtree contents");
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"read","node":"parent","action":"allow"},{"tool":"read","action":"deny"}]"""));
        var read = Obj("""{"toolId":"node:fixture/target/read","args":{"filePath":"read.txt"}}""");
        Success(await f.Call("call_tool", read, delegated));
        Assert.True(f.Manager.ToolVisible(delegated, "node", "read", node: "fixture/target"));
        await f.Manager.SetAgentRulesAsync("delegated", Rules("""[{"tool":"read","node":{"exact":"fixture/target"},"action":"deny"}]"""));
        Denied(await f.Call("call_tool", read, delegated));
        Assert.False(f.Manager.ToolVisible(delegated, "node", "read", node: "fixture/target"));
        await f.Manager.SetAgentRulesAsync("delegated", new JsonArray());
        await f.Policy("version: 1\nrules: [{tool: read, node: parent, action: deny}]\n");
        Denied(await f.Call("call_tool", read, delegated));
        await f.Policy("version: 1\nrules: []\n");
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"copy_between_nodes","node":"parent","action":"allow"},{"tool":"copy_between_nodes","node":"master","action":"allow"},{"tool":"copy_between_nodes","action":"deny"}]"""));
        var destination = Path.Combine(f.Work, "copy.txt");
        var copy = new JsonObject { ["sourceNode"] = "fixture/target", ["sourcePath"] = "read.txt", ["targetNode"] = "master", ["targetPath"] = destination };
        Denied(await f.Call("copy_between_nodes", copy, delegated));
        Assert.False(File.Exists(destination));
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"copy_between_nodes","node":["parent","master"],"action":"allow"},{"tool":"copy_between_nodes","action":"deny"}]"""));
        Success(await f.Call("copy_between_nodes", copy, delegated));
        Assert.Equal("subtree contents", await File.ReadAllTextAsync(destination));
    }

    [Fact]
    public async Task Native_cascade_checks_every_descendant_before_revoke_or_disconnect_and_rejects_mixed_provider_subtrees()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var root = f.Manager.Nodes.Registry.Create("root");
        var child = f.Manager.Nodes.Registry.Create("child", "root");
        var grand = f.Manager.Nodes.Registry.Create("grand", "child");
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseWebSockets();
        app.Map("/node_ws", f.Manager.Nodes.HandleAsync);
        await app.StartAsync();
        var sockets = new List<ClientWebSocket>();
        try
        {
            foreach (var credential in new[] { root, child, grand })
            {
                var socket = new ClientWebSocket();
                sockets.Add(socket);
                var url = app.Urls.Single().Replace("http", "ws") + "/node_ws?id=" + credential["nodeId"] + "&auth=" + credential["authToken"];
                await socket.ConnectAsync(new Uri(url), default);
                await socket.SendAsync(Encoding.UTF8.GetBytes("""{"type":"node_register","nodeType":"peer","parentNode":"forged","capabilities":{"tools":[]}}"""), WebSocketMessageType.Text, true, default);
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await socket.ReceiveAsync(new byte[65536], deadline.Token);
            }
            Assert.Null(f.Manager.Nodes.Registry.Forest().Parent("root"));
            Assert.Equal("root", f.Manager.Nodes.Registry.Forest().Parent("child"));
            Assert.Equal("child", f.Manager.Nodes.Registry.Forest().Parent("grand"));
            await f.Policy("version: 1\nrules:\n- {tool: node_remove, node: {exact: grand}, action: deny}\n- {tool: node_remove, node: root, action: allow}\n");
            Denied(await f.Call("node_remove", Obj("""{"nodeId":"root"}""")));
            Denied(await f.Call("node_remove", Obj("""{"nodeId":"root","cascade":true}""")));
            foreach (var credential in new[] { root, child, grand })
            {
                var id = credential["nodeId"]!.GetValue<string>();
                Assert.True(f.Manager.Nodes.Online(id));
                Assert.True(f.Manager.Nodes.Registry.Authenticate(id, credential["authToken"]!.GetValue<string>()));
            }
            await f.Policy("version: 1\nrules: []\n");
            await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"node_remove","node":{"exact":"child"},"action":"deny"}]"""));
            Denied(await f.Call("node_remove", Obj("""{"nodeId":"root","cascade":true}""")));
            Assert.All(new[] { "root", "child", "grand" }, id => Assert.True(f.Manager.Nodes.Connected(id)));
            await f.Manager.SetAgentRulesAsync("main", new JsonArray());
            Success(await f.Call("node_remove", Obj("""{"nodeId":"root","cascade":true}""")));
            foreach (var credential in new[] { root, child, grand })
            {
                var id = credential["nodeId"]!.GetValue<string>();
                Assert.False(f.Manager.Nodes.Connected(id));
                Assert.False(f.Manager.Nodes.Registry.Authenticate(id, credential["authToken"]!.GetValue<string>()));
            }
            // Released names have no permanent used-parent tombstone.
            f.Manager.Nodes.Registry.Create("root");
            await f.Manager.NodeProviders.ListAsync(default);
            Denied(await f.Call("node_remove", Obj("""{"nodeId":"parent","cascade":true}""")));
            Assert.True(f.Manager.Nodes.Registry.Forest().Contains("parent"));
            Assert.Empty(await f.Effects());
            f.Manager.Nodes.Registry.Create("native-under-provider", "fixture/target");
            var destroy = Obj("""{"action":"destroy","nodeId":"fixture/target","confirmation":"destroy node fixture/target"}""");
            Denied(await f.Call("node", destroy));
            Assert.Empty(await f.Effects());
        }
        finally
        {
            foreach (var socket in sockets)
                socket.Dispose();
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Provider_disappearance_configuration_removal_and_restart_preserve_only_referenced_identities()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        using var native = new NodeConnectionHub(data);
        native.Registry.Create("parent");
        var configuration = ExecutableNodeProviderTests.Configuration(Path.Combine(temp.Path, "target"), "lifecycle");
        configuration["parentNode"] = "parent";
        var providers = new JsonObject { ["fixture"] = configuration };
        var registry = new NodeProviderRegistry(native, providers);
        await registry.ListAsync(default);
        native.Registry.Create("child", "fixture/target");
        // The provider's next discovery no longer includes target, but its authorization identity is referenced.
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "target", "node-id"), "replacement");
        await registry.ListAsync(default);
        Assert.Equal(new[] { "child", "fixture/target", "parent" }, native.Registry.Forest().Chain("child"));
        Assert.Contains(registry.Snapshot(), node => SessionWait.Text(node?["id"]) == "fixture/target" && SessionWait.Text(node?["availability"]) == "offline");
        using var restartedNative = new NodeConnectionHub(data);
        var removedConfiguration = new NodeProviderRegistry(restartedNative, new JsonObject());
        Assert.Equal(new[] { "child", "fixture/target", "parent" }, restartedNative.Registry.Forest().Chain("child"));
        Assert.NotNull(removedConfiguration.Snapshot().FirstOrDefault(node => SessionWait.Text(node?["id"]) == "fixture/target"));
        Assert.Throws<InvalidDataException>(() => restartedNative.Registry.Remove("parent"));
        restartedNative.Registry.Remove("child");
        _ = new NodeProviderRegistry(restartedNative, new JsonObject());
        Assert.False(restartedNative.Registry.Forest().Contains("fixture/target"));
        restartedNative.Registry.Remove("parent");
        restartedNative.Registry.Create("parent");
        Assert.Single(restartedNative.Registry.ListApproved());
    }

    [Fact]
    public void Registry_limits_are_admission_only_and_unclaimed_pairing_expiry_reject_rename_and_admin_reparent_preserve_the_forest()
    {
        using var temp = new TempDirectory();
        var registry = new ApprovedNodeRegistry(temp.Path);
        registry.ConfigureLimits(() => (2, 1));
        registry.Create("root");
        registry.Create("child", "root");
        registry.Create("grand", "child");
        Assert.Throws<InvalidDataException>(() => registry.Create("too-deep", "grand"));
        Assert.Throws<InvalidDataException>(() => registry.Create("too-many", "root"));
        registry.ConfigureLimits(() => (0, 0));
        Assert.Equal(3, registry.Forest().Chain("grand").Count);
        registry.SetParent("grand", "child"); // unchanged existing edges remain usable.
        Assert.Throws<InvalidDataException>(() => registry.Create("new", "root"));
        registry.SetParent("grand", null);
        registry.Remove("child");
        registry.Remove("root");
        registry.Create("root");
        registry.Rename("root", "renamed");
        registry.Create("root");
        var pending = registry.Request(Obj("""{"nodeType":"cli-node","requestedName":"paired","capabilities":{"tools":[]}}"""), NodeConnectionHub.Protocol(new()));
        registry.Approve(pending["id"]!.GetValue<string>(), "paired");
        Assert.Throws<InvalidDataException>(() => registry.Create("unclaimed-child", "paired"));
        registry.Reject(pending["id"]!.GetValue<string>());
        registry.Create("paired");
        registry.Remove("paired");
        pending = registry.Request(Obj("""{"nodeType":"cli-node","requestedName":"paired","capabilities":{"tools":[]}}"""), NodeConnectionHub.Protocol(new()));
        registry.Approve(pending["id"]!.GetValue<string>(), "paired");
        registry.Cleanup(ApprovedNodeRegistry.Now + ApprovedNodeRegistry.PairingTtl + 1);
        registry.Create("paired");
        registry.ConfigureLimits(() => (16, 256));
        registry.SetParent("paired", "root");
        Assert.Throws<InvalidDataException>(() => registry.SetParent("root", "paired"));
        var reopened = new ApprovedNodeRegistry(temp.Path);
        Assert.Equal("root", reopened.Forest().Parent("paired"));
        Assert.Throws<InvalidDataException>(() => reopened.SetParent("paired", "missing"));
    }
}
