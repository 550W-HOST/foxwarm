using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    [Fact]
    public async Task Configured_limits_refuse_native_files_and_provider_effects_and_root_provider_admission_uses_caller_provenance()
    {
        foreach (var invalid in new[] { "-1", "1.5", "null", "true", "2147483648" })
            Assert.Throws<InvalidDataException>(() => AppConfigurationRules.Validate(Obj("{\"nodeTree\":{\"maxDepth\":" + invalid + "}}")));
        if (!OperatingSystem.IsLinux())
            return;
        await using (var limited = await Fixture.Create(provider: true, limits: Obj("""{"maxDepth":0,"maxChildren":0}""")))
        {
            Denied(await limited.Call("node_create_auth_token", limited.Credential("limited", "parent")));
            Assert.False(File.Exists(Path.Combine(limited.Work, "limited.token")));
            Denied(await limited.Call("node", Lifecycle("create", "fixture/limited")));
            Assert.Empty(await limited.Effects());
            Assert.Single(limited.Manager.Nodes.Registry.ListApproved());
        }
        await using var root = await Fixture.Create(provider: true, providerParent: null);
        var delegated = await root.Child();
        Denied(await root.Call("node", Lifecycle("create", "fixture/delegated-root"), delegated));
        Denied(await root.Call("node", Lifecycle("ensure", "fixture/delegated-root"), delegated));
        Assert.Empty(await root.Effects());
        Success(await root.Call("node", Lifecycle("create", "fixture/top-root")));
        Assert.Null(root.Manager.Nodes.Registry.Forest().Parent("fixture/top-root"));
        // An existing root is a mutation target, not a newly delegated identity.
        Success(await root.Call("node", Lifecycle("ensure", "fixture/top-root"), delegated));
        var omitted = Lifecycle("ensure");
        omitted.Remove("nodeId");
        Success(await root.Call("node", omitted));
        Assert.Null(root.Manager.Nodes.Registry.Forest().Parent("fixture/generated"));
    }

    [Fact]
    public async Task Model_options_and_provider_descriptors_cannot_reparent_and_provider_configuration_remains_trusted_startup_administration()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var node = Lifecycle("create", "fixture/fresh");
        node["parentNode"] = "forged";
        Denied(await f.Call("node", node));
        Assert.Empty(await f.Effects());
        Directory.CreateDirectory(f.Target);
        await File.WriteAllTextAsync(Path.Combine(f.Target, "forged-parent"), "");
        Denied(await f.Call("node", Lifecycle("create", "fixture/fresh")));
        Assert.Empty(await f.Effects());
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/target"));
        File.Delete(Path.Combine(f.Target, "forged-parent"));
        await f.Manager.NodeProviders.ListAsync(default);
        f.Manager.Nodes.Registry.Create("new-parent");
        f.Manager.Nodes.Registry.Create("native-child", "fixture/target");
        var config = ExecutableNodeProviderTests.Configuration(f.Target, "lifecycle");
        config["parentNode"] = "new-parent";
        // A fresh startup registry applies administrator configuration, not lifecycle options or descriptors.
        var registry = new NodeProviderRegistry(f.Manager.Nodes, new JsonObject { ["fixture"] = config });
        Assert.Equal(new[] { "native-child", "fixture/target", "new-parent" }, f.Manager.Nodes.Registry.Forest().Chain("native-child"));
        Assert.Throws<InvalidDataException>(() => f.Manager.Nodes.Registry.SetParent("fixture/target", "parent"));
        Assert.NotNull(await registry.ResolveAsync("fixture/target", default));
    }

    [Fact]
    public async Task Cascade_and_concurrent_native_admission_share_the_registry_mutation_owner()
    {
        await using var f = await Fixture.Create();
        f.Manager.Nodes.Registry.Create("root");
        f.Manager.Nodes.Registry.Create("child", "root");
        var file = typeof(ApprovedNodeRegistry).GetField("file", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(f.Manager.Nodes.Registry)!;
        var hook = typeof(LinuxAtomicJsonFile).GetField("stageHook", BindingFlags.Instance | BindingFlags.NonPublic)!;
        using var reached = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        hook.SetValue(file, (Action<AtomicJsonWriteStage>)(stage =>
        {
            if (stage != AtomicJsonWriteStage.BeforeRename)
                return;
            reached.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Owned cascade publication barrier timed out.");
        }));
        var removal = Task.Run(() => f.Call("node_remove", Obj("""{"nodeId":"root","cascade":true}""")));
        Task<JsonNode?>? admission = null;
        try
        {
            Assert.True(reached.Wait(TimeSpan.FromSeconds(5)));
            admission = Task.Run(() => f.Call("node_create_auth_token", f.Credential("racing", "root")));
        }
        finally
        {
            release.Set();
        }
        Success(await removal);
        Denied(await admission!);
        hook.SetValue(file, null);
        Assert.Empty(f.Manager.Nodes.Registry.ListApproved());
        Assert.False(File.Exists(Path.Combine(f.Work, "racing.token")));
    }

    [Fact]
    public async Task Agentless_inbound_pair_approval_keeps_its_external_policy_and_does_not_open_provider_lifecycle()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        var pending = f.Manager.Nodes.Registry.Request(Obj("""{"nodeType":"cli-node","requestedName":"external-root","capabilities":{"tools":[]}}"""), NodeConnectionHub.Protocol(new()));
        // Internal Agent rules never manufacture or restrict an ordinary external principal.
        await f.Manager.SetAgentRulesAsync("main", Rules("""[{"tool":"node_pair_approve","action":"deny"}]"""));
        await using var client = await f.ClientAsync();
        var approved = await InboundMcpFixture.ConcreteAsync(client, "builtin:node_pair_approve",
            new JsonObject { ["pendingId"] = pending["id"]!.DeepClone() });
        Assert.False(approved["isError"]?.GetValue<bool>() == true, approved.ToJsonString());
        Assert.DoesNotContain("authToken", approved.ToJsonString());
        Assert.Null(f.Manager.Nodes.Registry.Forest().Parent("external-root"));
        var unavailable = await InboundMcpFixture.ConcreteAsync(client, "builtin:node", Lifecycle("ensure", "fixture/target"));
        Assert.True(unavailable["isError"]!.GetValue<bool>());
    }
    [Theory]
    [InlineData("missing")]
    [InlineData("broken")]
    public async Task Persisted_broken_ancestry_denies_real_removal_and_discovery_without_revoking_credentials(string parent)
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var registry = new ApprovedNodeRegistry(data);
        var credential = registry.Create("broken");
        var path = Path.Combine(data, "state", "nodes.json");
        var document = Obj(await File.ReadAllTextAsync(path));
        document["approvedNodes"]!["broken"]!["parentNode"] = parent;
        await File.WriteAllTextAsync(path, document.ToJsonString());
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        await using var manager = new SessionManager(data, work, options, HostModels.ForTest(options));
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "broken-tree", null, null);
        var definitions = Foxwarm.Nodes.NodeToolDefinitions.All();
        var tools = Foxwarm.Tools.SessionToolExecutor.CreateRegistry(definitions, manager.OutboundMcp, _ => work, manager.Nodes);
        var executor = new Foxwarm.Tools.SessionToolExecutor(new Foxwarm.Tools.WorkspaceTools(work), owner, manager, tools);
        Denied(await executor.ExecuteAsync(new JsonObject
        {
            ["name"] = "node_remove", ["args"] = Obj("""{"nodeId":"broken","cascade":true}"""),
        }, default));
        Assert.False(manager.ToolVisible(owner, "node", "read", node: "broken"));
        Assert.True(manager.Nodes.Registry.Authenticate("broken", credential["authToken"]!.GetValue<string>()));
        Assert.Single(manager.Nodes.Registry.ListApproved());
    }

    [Fact]
    public async Task Deferred_expiry_cleanup_during_provider_mutation_never_extends_handoff_authentication_or_claim()
    {
        using var temp = new TempDirectory();
        var registry = new ApprovedNodeRegistry(temp.Path);
        var request = registry.Request(Obj("""{"nodeType":"cli-node","requestedName":"expiring","capabilities":{"tools":[]}}"""), NodeConnectionHub.Protocol(new()));
        var pendingId = request["id"]!.GetValue<string>();
        var credential = registry.Approve(pendingId, "expiring");
        var path = Path.Combine(temp.Path, "state", "nodes.json");
        var document = Obj(await File.ReadAllTextAsync(path));
        document["pendingPairings"]![pendingId]!["approvedAt"] = ApprovedNodeRegistry.Now - ApprovedNodeRegistry.PairingTtl + 1000;
        await File.WriteAllTextAsync(path, document.ToJsonString());
        registry = new ApprovedNodeRegistry(temp.Path);
        using (await registry.BeginMutationAsync(default))
        {
            await Task.Delay(1100);
            Assert.False(registry.Authenticate("expiring", credential["authToken"]!.GetValue<string>()));
            Assert.Null(registry.ClaimId(pendingId));
            Assert.Throws<InvalidDataException>(() => registry.Touch("expiring", credential["authToken"]!.GetValue<string>(),
                Obj("""{"nodeType":"cli-node","capabilities":{"tools":[]}}"""), NodeConnectionHub.Protocol(new())));
        }
        registry.Cleanup();
        Assert.Empty(registry.ListApproved());
        Assert.Empty(registry.ListPending());
    }

}
