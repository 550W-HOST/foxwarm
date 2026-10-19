using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    private static JsonObject Lifecycle(
        string action,
        string? node = null,
        string? provider = null,
        JsonObject? parameters = null
    )
    {
        var result = new JsonObject { ["action"] = action };
        if (node is not null)
            result["nodeId"] = node;
        if (provider is not null)
            result["providerId"] = provider;
        if (parameters is not null)
            result["parameters"] = parameters;
        return result;
    }

    [Fact]
    public async Task Provider_discovery_and_lifecycle_use_actual_direct_unified_and_native_callers_without_selecting_or_creating_Agents()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        var list = await f.Call("node", Lifecycle("list"));
        Success(list);
        Assert.Contains("fixture", list["output"]!.GetValue<string>());
        var structured = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('node', {'action':'list'})" }
        );
        Success(structured);
        var data = structured["result"]!.AsObject();
        Assert.Equal("master", data["currentNode"]!.GetValue<string>());
        Assert.Contains(
            data["nodes"]!.AsArray(),
            node => node?["id"]?.GetValue<string>() == f.Node
        );
        var provider = data["providers"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(p => p["id"]!.GetValue<string>() == "fixture");
        Assert.Equal(3, provider.Count);
        Assert.Equal(4, provider["lifecycle"]!.AsArray().Count);
        var full = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "builtin:node",
                ["args"] = Lifecycle("inspect", provider: "fixture"),
            }
        );
        Success(full);
        Assert.Equal("object", full["provider"]!["createParameters"]!["type"]!.GetValue<string>());
        Assert.Contains("files remain", full["provider"]!["dataRetention"]!.GetValue<string>());
        foreach (var fixedProvider in new[] { "master", "authenticated-remote" })
        {
            var description = await f.Call("node", Lifecycle("inspect", provider: fixedProvider));
            Success(description);
            Assert.Empty(description["provider"]!["lifecycle"]!.AsArray());
        }
        var created = await f.Call(
            "node",
            Lifecycle(
                "create",
                "fixture/created",
                "fixture",
                new JsonObject { ["label"] = "New environment" }
            )
        );
        Success(created);
        Assert.Equal("fixture/created", created["node"]!["id"]!.GetValue<string>());
        Assert.Equal("fixture", created["node"]!["provider"]!.GetValue<string>());
        Assert.Equal(
            "read-write",
            created["node"]!["primitiveBackends"]!["filesystem"]!.GetValue<string>()
        );
        Assert.Equal(
            "business-data-not-qualified",
            created["details"]!["nodeId"]!.GetValue<string>()
        );
        Assert.Equal("master", f.Manager.CurrentNode(f.Owner));
        Assert.Equal(new[] { "main" }, f.Manager.Agents());
        var ensured = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('node', {'action':'ensure','providerId':'fixture','nodeId':'fixture/created','parametersJson':'{\"label\":\"Ensured\"}'})",
            }
        );
        Success(ensured);
        Assert.Equal("Ensured", ensured["result"]!["node"]!["label"]!.GetValue<string>());
        var inspected = await f.Call(
            "node",
            Lifecycle("inspect", "fixture/created", parameters: new JsonObject { ["detail"] = 3 })
        );
        Success(inspected);
        Assert.Equal(3, inspected["details"]!["parameters"]!["detail"]!.GetValue<int>());
        await f.Manager.SelectNodeAsync(f.Owner, "fixture/created");
        Success(
            await f.Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "lifecycle-file",
                    ["content"] = "actual target",
                    ["createDirs"] = true,
                }
            )
        );
        Assert.Equal("actual target", await File.ReadAllTextAsync(f.FilePath("lifecycle-file")));
        Success(await f.Call("exec", Exec("printf actual >> lifecycle-file")));
        Assert.Equal(
            "actual targetactual",
            await File.ReadAllTextAsync(f.FilePath("lifecycle-file"))
        );
        var destroy = Lifecycle("destroy", "fixture/created");
        destroy["confirmation"] = "destroy node fixture/created";
        var destroyed = await f.Call("node", destroy);
        Success(destroyed);
        Assert.Equal("fixture/created", destroyed["nodeId"]!.GetValue<string>());
        Assert.Contains("retained", destroyed["dataRetention"]!.GetValue<string>());
        Assert.True(File.Exists(f.FilePath("lifecycle-file")));
        Assert.Null(await f.Manager.NodeProviders.ResolveAsync("fixture/created", default));
        Assert.Equal("fixture/created", f.Manager.CurrentNode(f.Owner));
        var calls = (await f.Requests())
            .Where(row =>
                row["operation"]!.GetValue<string>()
                    is "create"
                        or "ensure"
                        or "inspect"
                        or "destroy"
            )
            .ToArray();
        Assert.Equal(4, calls.Length);
        Assert.All(
            calls,
            row =>
            {
                var request = row["request"]!.AsObject();
                Assert.Equal("created", request["nodeId"]!.GetValue<string>());
                Assert.Equal(f.Owner.Id, request["sourceSessionId"]!.GetValue<string>());
                Assert.Equal("main", request["context"]!["agent"]!.GetValue<string>());
                Assert.Equal(new[] { "agent" }, request["context"]!.AsObject().Select(p => p.Key));
                Assert.DoesNotContain("confirmation", request.Select(p => p.Key));
            }
        );
    }

    [Fact]
    public async Task Action_arguments_identity_confirmation_and_policy_reject_before_effect_and_uncertain_effect_is_not_replayed()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        foreach (
            var invalid in new[]
            {
                Lifecycle("list", "fixture/target"),
                Lifecycle("select", "fixture/target", "fixture"),
                Lifecycle("create", "other/foreign", "fixture"),
                Lifecycle("create", "master", "fixture"),
                Lifecycle("create", "fixture/target", "fixture"),
                Lifecycle("create", "fixture/space ", "fixture"),
                Lifecycle("create", provider: "missing"),
                Lifecycle("inspect", "fixture/target", "fixture"),
                Lifecycle(
                    "inspect",
                    provider: "fixture",
                    parameters: new JsonObject { ["notAllowed"] = true }
                ),
                Lifecycle("inspect", "master"),
                Lifecycle("create", provider: "other"),
                Lifecycle("destroy", "fixture/target"),
                new JsonObject
                {
                    ["action"] = "destroy",
                    ["nodeId"] = "fixture/target",
                    ["confirmation"] = "destroy node fixture/target ",
                },
                new JsonObject
                {
                    ["action"] = "create",
                    ["providerId"] = "fixture",
                    ["parametersJson"] = "[]",
                },
                Lifecycle(
                    "create",
                    provider: "fixture",
                    parameters: new JsonObject { ["large"] = new string('x', 65536) }
                ),
            }
        )
            Assert.NotNull((await f.Call("node", invalid))["error"]);
        Assert.False(File.Exists(Path.Combine(f.Target, "effects.jsonl")));
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(policy, "version: 1\ndefaultAction: deny\nrules: []\n");
        f.Manager.Authorization.Invalidate();
        Assert.NotNull(
            (await f.Call("node", Lifecycle("create", "fixture/denied", "fixture")))["error"]
        );
        Assert.False(File.Exists(Path.Combine(f.Target, "effects.jsonl")));
        await File.WriteAllTextAsync(
            policy,
            "version: 1\ndefaultAction: deny\nrules: [{action: allow, tool: {source: builtin, name: [node, run_script]}}]\n"
        );
        f.Manager.Authorization.Invalidate();
        var disclosed = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('node', {'action':'list'})['nodes']" }
        );
        Success(disclosed);
        Assert.All(disclosed["result"]!.AsArray(), node => Assert.Empty(node!["tools"]!.AsArray()));
        var mismatch = await f.Call(
            "node",
            Lifecycle(
                "create",
                "fixture/mismatch",
                "fixture",
                new JsonObject { ["wrongIdentity"] = true }
            )
        );
        Assert.NotNull(mismatch["error"]);
        Assert.NotNull(await f.Manager.NodeProviders.ResolveAsync("fixture/mismatch", default));
        var lost = await f.Call(
            "node",
            Lifecycle(
                "create",
                "fixture/uncertain",
                "fixture",
                new JsonObject { ["lostReceipt"] = true }
            )
        );
        Assert.NotNull(lost["error"]);
        Assert.NotNull(await f.Manager.NodeProviders.ResolveAsync("fixture/uncertain", default));
        Assert.Equal(
            2,
            (await File.ReadAllLinesAsync(Path.Combine(f.Target, "effects.jsonl"))).Length
        );
        Assert.Equal(
            2,
            (await f.Requests()).Count(row => row["operation"]!.GetValue<string>() == "create")
        );
        var precedence = Lifecycle(
            "ensure",
            "fixture/precedence",
            "fixture",
            new JsonObject { ["label"] = "Primary object wins" }
        );
        precedence["parametersJson"] = "not JSON";
        Success(await f.Call("node", precedence));
    }

    [Fact]
    public async Task Registry_mutations_are_ordered_queued_cancellation_has_no_effect_and_inspection_remains_independent()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        var first = f.Call(
            "node",
            Lifecycle("create", "fixture/queued", "fixture", new JsonObject { ["block"] = true })
        );
        await Until(() => Task.FromResult(File.Exists(Path.Combine(f.Target, "effect-started"))));
        using var cancellation = new CancellationTokenSource();
        var cancelled = f.Call(
            "node",
            Lifecycle("ensure", "fixture/cancelled", "fixture"),
            cancellation.Token
        );
        var duplicate = f.Call("node", Lifecycle("create", "fixture/queued", "fixture"));
        cancellation.Cancel();
        try
        {
            var inspect = await f.Call("node", Lifecycle("inspect", "fixture/queued"))
                .WaitAsync(TimeSpan.FromSeconds(2));
            Success(inspect);
            Assert.False(first.IsCompleted);
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(f.Target, "release-effect"), "");
        }
        Success(await first);
        Assert.NotNull((await cancelled)["error"]);
        Assert.NotNull((await duplicate)["error"]);
        Assert.Single(await File.ReadAllLinesAsync(Path.Combine(f.Target, "effects.jsonl")));
        Assert.DoesNotContain(
            await f.Requests(),
            row => row["operation"]!.GetValue<string>() == "ensure"
        );
    }

    [Fact]
    public async Task Effectively_isolated_discovery_filters_actions_but_exact_allow_cannot_enable_mutations_or_foreign_inspection()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        await f.Manager.SetAgentIsolationAsync(
            "main",
            f.Node,
            true,
            new JsonArray(
                new JsonObject
                {
                    ["effect"] = "allow",
                    ["source"] = "builtin",
                    ["tool"] = "node",
                }
            )
        );
        var listed = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return call_tool('node', {'action':'list'})" }
        );
        Success(listed);
        var nodes = listed["result"]!["nodes"]!.AsArray();
        Assert.Equal(
            new[] { "master", f.Node },
            nodes.Select(node => node!["id"]!.GetValue<string>())
        );
        Assert.Equal(
            new[] { "inspect" },
            listed["result"]!["providers"]!
                .AsArray()
                .Single(p => p!["id"]!.GetValue<string>() == "fixture")!["lifecycle"]!
                .AsArray()
                .Select(SessionWait.Text)
        );
        var full = await f.Call("node", Lifecycle("inspect", provider: "fixture"));
        Success(full);
        Assert.Single(full["provider"]!["lifecycle"]!.AsArray());
        Success(await f.Call("node", Lifecycle("inspect", f.Node)));
        foreach (
            var denied in new[]
            {
                Lifecycle("create", "fixture/denied", "fixture"),
                Lifecycle("ensure", "fixture/denied", "fixture"),
                Lifecycle("destroy", f.Node),
                Lifecycle("inspect", "other/target"),
                Lifecycle("select", "master"),
            }
        )
            Assert.NotNull((await f.Call("node", denied))["error"]);
        Assert.False(File.Exists(Path.Combine(f.Target, "effects.jsonl")));
    }

    [Fact]
    public async Task Full_inspection_copies_bounded_plain_schema_data_without_business_schema_validation()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        using var native = new NodeConnectionHub(Path.Combine(temp.Path, "native"));
        var root = Path.Combine(temp.Path, "provider");
        Directory.CreateDirectory(root);
        var description = new JsonObject
        {
            ["label"] = "Fixture",
            ["description"] = "Arbitrary JSON schemas are data.",
            ["lifecycle"] = new JsonArray("inspect"),
            ["createParameters"] = true,
            ["ensureParameters"] = new JsonArray("custom", null),
            ["dataRetention"] = "Files remain.",
        };
        await File.WriteAllTextAsync(
            Path.Combine(root, "description.json"),
            description.ToJsonString()
        );
        var registry = new NodeProviderRegistry(
            native,
            new JsonObject { ["fixture"] = ExecutableNodeProviderTests.Configuration(root) }
        );
        var first = await registry.InspectProviderAsync("fixture", default);
        Assert.True(first["createParameters"]!.GetValue<bool>());
        first["ensureParameters"]![0] = "changed";
        Assert.Equal(
            "custom",
            (await registry.InspectProviderAsync("fixture", default))["ensureParameters"]![
                0
            ]!.GetValue<string>()
        );
        description["createParameters"] = new string('x', 16 * 1024);
        await File.WriteAllTextAsync(
            Path.Combine(root, "description.json"),
            description.ToJsonString()
        );
        var fresh = new ExecutableNodeProvider(
            "fixture",
            ExecutableNodeProviderTests.Configuration(root)
        );
        await Assert.ThrowsAsync<NodeProviderException>(() => fresh.DescribeAsync(default));

        // Full Main inspection allows a scalar inside a container at its deepest
        // supported nesting level; schemas remain plain data at that boundary too.
        await using var f = await Fixture.Create();
        JsonObject schema = new() { ["leaf"] = true };
        for (var index = 0; index < 10; index++)
            schema = new JsonObject { ["nested"] = schema };
        description["createParameters"] = schema;
        await File.WriteAllTextAsync(
            Path.Combine(f.Target, "description.json"),
            description.ToJsonString()
        );
        Success(await f.Call("node", Lifecycle("inspect", provider: "fixture")));
    }
}
