using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();
    private static JsonArray Rules(string json) => JsonNode.Parse(json)!.AsArray();
    private static void Success(JsonNode? result) => Assert.True(result is not null && result["error"] is null, result?.ToJsonString());
    private static void Denied(JsonNode? result) => Assert.NotNull(result?["error"]);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal string Target => Path.Combine(Temp.Path, "provider");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal ToolRegistry Registry = null!;

        internal static async Task<Fixture> Create(bool provider = false, JsonObject? limits = null, string? providerParent = "parent")
        {
            var f = new Fixture();
            Directory.CreateDirectory(Path.Combine(f.Data, "state"));
            Directory.CreateDirectory(f.Work);
            if (provider)
            {
                var native = new ApprovedNodeRegistry(f.Data);
                native.Create("parent");
            }
            var app = new JsonObject { ["vector"] = false };
            if (limits is not null)
                app["nodeTree"] = limits.DeepClone();
            if (provider)
            {
                var config = ExecutableNodeProviderTests.Configuration(f.Target, "lifecycle");
                if (providerParent is not null)
                    config["parentNode"] = providerParent;
                app["nodeProviders"] = new JsonObject { ["fixture"] = config };
            }
            await File.WriteAllTextAsync(Path.Combine(f.Data, "state", "config.yaml"), app.ToJsonString());
            await File.WriteAllTextAsync(Path.Combine(f.Data, "state", "models.yaml"),
                "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n");
            var configuration = new ModelConfiguration(HostPaths.ForDataRoot(f.Data, f.Temp.Path, environment: _ => null));
            var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
            f.Manager = new(f.Data, f.Work, options, new HostModels(configuration));
            await f.Manager.LoadAsync();
            f.Owner = await f.Manager.CreateNamedAsync("main", "tree", null, null);
            f.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            var definitions = WorkspaceTools.Definitions();
            foreach (var item in NodeToolDefinitions.All().Concat(AgentToolDefinitions.Definitions()).Concat(UnifiedToolDefinitions.All()).Concat(ToolScriptToolDefinitions.Definitions()).Concat(FileDeliveryDefinitions.Definitions()))
                definitions.Add(item!.DeepClone());
            f.Registry = SessionToolExecutor.CreateRegistry(definitions, f.Manager.OutboundMcp,
                owner => f.Manager.IdentityWorkspace(owner).ToolDirectory, f.Manager.Nodes, f.Manager.NodeProviders);
            return f;
        }

        internal async Task<JsonNode?> Call(string name, JsonObject args, SessionOwner? owner = null)
        {
            owner ??= Owner;
            var executor = new SessionToolExecutor(new WorkspaceTools(Manager.IdentityWorkspace(owner).ToolDirectory), owner, Manager, Registry);
            executor.BeginTurn();
            return await executor.ExecuteAsync(new JsonObject { ["name"] = name, ["args"] = args.DeepClone() }, default);
        }

        internal async Task<SessionOwner> Child()
        {
            Success(await Call("create_agent", Obj("""{"agentName":"delegated"}""")));
            var child = await Manager.RequiredAsync("delegated/main");
            child.Registry.TriggerOverride = _ => Task.CompletedTask;
            return child;
        }

        internal Task Policy(string yaml) => Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);
        internal JsonObject Credential(string id, string? parent = null) => new()
        {
            ["nodeId"] = id, ["filePath"] = Path.Combine(Work, id + ".token"), ["parentNode"] = parent,
        };
        internal async Task<JsonObject[]> Effects() => File.Exists(Path.Combine(Target, "effects.jsonl"))
            ? (await File.ReadAllLinesAsync(Path.Combine(Target, "effects.jsonl"))).Select(line => Obj(line)).ToArray() : [];
        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public void Bare_patterns_exact_current_provider_and_multi_endpoint_order_keep_their_distinct_meanings()
    {
        var forest = new NodeAuthorizationForest(new Dictionary<string, string?>
        {
            ["master"] = null, ["box"] = null, ["native-child"] = "box", ["provider/grand"] = "native-child", ["other"] = null,
        });
        var request = new ToolAuthorizationRequest("node", "read", null, new(), [], "worker", "worker/main", "provider/grand", ".", ".", ".",
            NodeTargets: ["provider/grand"], CurrentNode: "provider/grand", NodeForest: forest);
        bool Allows(string selector, ToolAuthorizationRequest? value = null) => ToolAuthorizationEvaluation.Evaluate(
            ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes($"version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: {selector}\n")), value ?? request).Allowed;
        Assert.True(Allows("box"));
        Assert.True(Allows("'b*x'"));
        Assert.False(Allows("master"));
        Assert.False(Allows("{exact: box}"));
        Assert.True(Allows("{exact: provider/grand}"));
        Assert.True(Allows("{exact: [native-child, provider/grand]}"));
        Assert.True(Allows("{current: true}"));
        Assert.False(Allows("{current: true}", request with { CurrentNode = "box" }));
        Assert.True(Allows("{provider: provider}"));
        Assert.False(Allows("{provider: authenticated-remote}"));
        var both = request with { Source = "builtin", Name = "copy_between_nodes", NodeTargets = ["native-child", "other"] };
        Assert.False(Allows("box", both));
        Assert.True(Allows("[box, other]", both));
        var split = ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny\nrules:\n- {node: box, action: allow}\n- {node: other, action: allow}\n"));
        Assert.False(ToolAuthorizationEvaluation.Evaluate(split, both).Allowed);
        var deny = ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes("version: 1\nrules: [{node: box, action: deny}]\n"));
        Assert.False(ToolAuthorizationEvaluation.Evaluate(deny, both).Allowed);
        var shadow = ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes("version: 1\nrules:\n- {node: box, action: allow}\n- {node: provider/grand, action: deny}\n"));
        Assert.True(ToolAuthorizationEvaluation.Evaluate(shadow, request).Allowed);
        foreach (var parents in new[]
        {
            new Dictionary<string, string?> { ["provider/grand"] = "missing" },
            new Dictionary<string, string?> { ["provider/grand"] = "box", ["box"] = "provider/grand" },
        })
        {
            var broken = request with { NodeForest = new NodeAuthorizationForest(parents) };
            Assert.Throws<InvalidDataException>(() => ToolAuthorizationEvaluation.Evaluate(shadow, broken));
            Assert.Throws<InvalidDataException>(() => ToolAuthorizationEvaluation.Visible(shadow, broken));
        }
        Assert.Throws<InvalidDataException>(() => ToolAuthorizationPolicy.Normalize(Obj("""{"version":1,"rules":[{"node":{"exact":"box*"},"action":"allow"}]}""")));
    }

    [Fact]
    public async Task Native_credentials_authorize_the_concrete_parent_operation_before_any_file_or_reservation_on_all_call_paths()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("parent");
        var delegated = await f.Child();
        await f.Policy("version: 1\nrules:\n- {tool: node_create_auth_token, node: parent, action: deny}\n");
        var deniedArgs = f.Credential("direct-denied", "parent");
        Denied(await f.Call("node_create_auth_token", deniedArgs, delegated));
        Denied(await f.Call("call_tool", new JsonObject { ["toolId"] = "builtin:node_create_auth_token", ["args"] = f.Credential("unified-denied", "parent") }, delegated));
        Denied(await f.Call("run_script", new JsonObject { ["code"] =
            "return call_tool('builtin:node_create_auth_token', " + f.Credential("script-denied", "parent").ToJsonString() + ")" }, delegated));
        Assert.Single(f.Manager.Nodes.Registry.ListApproved());
        Assert.Empty(Directory.GetFiles(f.Work, "*.token"));
        await f.Policy("version: 1\nrules: []\n");
        Denied(await f.Call("node_create_auth_token", f.Credential("no-parent"), delegated));
        Assert.False(File.Exists(Path.Combine(f.Work, "no-parent.token")));
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"node_create_auth_token","node":"parent","action":"allow"},{"tool":"node_create_auth_token","action":"deny"}]"""));
        Success(await f.Call("node_create_auth_token", f.Credential("child", "parent"), delegated));
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("child"));
        Success(await f.Call("node_create_auth_token", f.Credential("grand", "child"), delegated));
        await f.Manager.SetAgentRulesAsync("delegated", Rules("""[{"tool":"node_create_auth_token","node":{"exact":"child"},"action":"deny"}]"""));
        Denied(await f.Call("node_create_auth_token", f.Credential("local-denied", "child"), delegated));
        Assert.False(File.Exists(Path.Combine(f.Work, "local-denied.token")));
        await f.Manager.SetAgentRulesAsync("main", new JsonArray());
        Success(await f.Call("node_create_auth_token", f.Credential("top-root")));
        Assert.Null(f.Manager.Nodes.Registry.Forest().Parent("top-root"));
        Assert.Equal("grand", f.Manager.Nodes.Registry.Forest().Chain("grand")[0]);
    }

    [Fact]
    public async Task Delegated_pair_approval_cannot_create_roots_but_top_level_pairing_and_pending_lifetimes_remain_supported()
    {
        await using var f = await Fixture.Create();
        var delegated = await f.Child();
        var pending = f.Manager.Nodes.Registry.Request(Obj("""{"nodeType":"cli-node","requestedName":"paired","capabilities":{"tools":[]}}"""), NodeConnectionHub.Protocol(new()));
        var args = new JsonObject { ["pendingId"] = pending["id"]!.DeepClone() };
        Denied(await f.Call("node_pair_approve", args, delegated));
        Assert.Empty(f.Manager.Nodes.Registry.ListApproved());
        Assert.Null(f.Manager.Nodes.Registry.ListPending()[0]!["approvedNodeId"]);
        Success(await f.Call("node_pair_approve", args));
        Assert.Throws<InvalidDataException>(() => f.Manager.Nodes.Registry.Create("not-claimed", "paired"));
        Assert.NotNull(f.Manager.Nodes.Registry.ClaimId(pending["id"]!.GetValue<string>()));
        f.Manager.Nodes.Registry.Create("now-claimed", "paired");
        Assert.Throws<InvalidDataException>(() => f.Manager.Nodes.Registry.Rename("paired", "replacement"));
        Assert.Throws<InvalidDataException>(() => f.Manager.Nodes.Remove("paired"));
    }

    [Fact]
    public async Task Incoming_selected_node_history_send_and_events_stay_exact_despite_outgoing_subtree_grants()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("parent");
        f.Manager.Nodes.Registry.Create("child", "parent");
        await f.Owner.Entry.SaveLane.CommitNodeAsync("child");
        var before = f.Owner.Entry.Snapshot().Queue.Count;
        foreach (var type in new[] { "session_history_request", "session_send_message" })
            await Assert.ThrowsAsync<InvalidDataException>(() => f.Manager.HandleNodeSessionRequestAsync("parent",
                new JsonObject { ["type"] = type, ["sessionId"] = f.Owner.Id, ["message"] = "must not arrive" }, () => { }, default));
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Manager.AdmitNodeSessionEventAsync("parent",
            new JsonObject { ["sessionId"] = f.Owner.Id, ["message"] = "must not arrive" }));
        Assert.Equal(before, f.Owner.Entry.Snapshot().Queue.Count);
        var list = await f.Manager.HandleNodeSessionRequestAsync("parent", Obj("""{"type":"session_list_request"}"""), () => { }, default);
        Assert.Empty(list["sessions"]!.AsArray());
        var history = await f.Manager.HandleNodeSessionRequestAsync("child",
            new JsonObject { ["type"] = "session_history_request", ["sessionId"] = f.Owner.Id }, () => { }, default);
        Assert.Equal(f.Owner.Id, SessionWait.Text(history["session"]?["id"]));
    }
}
