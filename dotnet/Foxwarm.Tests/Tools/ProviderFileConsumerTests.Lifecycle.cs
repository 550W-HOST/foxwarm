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
            Assert.Equal(
                new[] { "inspect" },
                description["provider"]!["lifecycle"]!.AsArray().Select(SessionWait.Text)
            );
            Assert.Equal(
                new[] { "inspect" },
                data["providers"]!
                    .AsArray()
                    .Single(p => SessionWait.Text(p?["id"]) == fixedProvider)!["lifecycle"]!
                    .AsArray()
                    .Select(SessionWait.Text)
            );
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
    public async Task Fixed_node_inspection_uses_safe_known_catalog_data_without_discovery_selection_or_provisioning()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        await f.Owner.UpdateCwdAsync(f.Work);
        await File.WriteAllTextAsync(Path.Combine(f.Target, "list-unavailable"), "");
        var main = await f.Call("node", Lifecycle("inspect", "master"));
        Success(main);
        Assert.Equal("master", main["node"]!["id"]!.GetValue<string>());
        Assert.Equal("master", main["node"]!["type"]!.GetValue<string>());
        Assert.True(main["node"]!["online"]!.GetValue<bool>());
        Assert.True(
            JsonNode.DeepEquals(
                f.Manager.NodeSummaries()[0]!["services"],
                main["node"]!["services"]
            )
        );
        Assert.Null(main["node"]!["defaultCwd"]);
        foreach (var type in new[] { "cli-node", "browser-extension", "shell-node", "android" })
        {
            var id = "offline-" + type;
            var requested = f.Manager.Nodes.Registry.Request(
                new JsonObject
                {
                    ["requestedName"] = "Known " + type,
                    ["nodeType"] = type,
                    ["capabilities"] = new JsonObject
                    {
                        ["tools"] = new JsonArray(new JsonObject { ["name"] = "read" }),
                        ["services"] = new JsonObject { ["vscode-fs"] = 1 },
                    },
                },
                NodeConnectionHub.Protocol(new JsonObject())
            );
            var credential = f.Manager.Nodes.Registry.Approve(
                requested["id"]!.GetValue<string>(),
                id
            );
            var result = await f.Call(
                "call_tool",
                new JsonObject { ["toolId"] = "builtin:node", ["args"] = Lifecycle("inspect", id) }
            );
            Assert.True(result["error"] is null, result.ToJsonString());
            var node = result["node"]!;
            Assert.Equal(id, node["id"]!.GetValue<string>());
            Assert.Equal(type, node["type"]!.GetValue<string>());
            Assert.Equal("Known " + type, node["displayName"]!.GetValue<string>());
            Assert.False(node["connected"]!.GetValue<bool>());
            Assert.False(node["executable"]!.GetValue<bool>());
            Assert.Empty(node["tools"]!.AsArray());
            Assert.Empty(node["services"]!.AsObject());
            Assert.Null(node["capabilities"]);
            Assert.Null(node["defaultCwd"]);
            Assert.DoesNotContain("tokenHash", result.ToJsonString());
            Assert.DoesNotContain("approvedAuthToken", result.ToJsonString());
            Assert.DoesNotContain(
                credential["authToken"]!.GetValue<string>(),
                result.ToJsonString()
            );
        }
        var missing = await f.Call("node", Lifecycle("inspect", "missing-native"));
        Assert.Contains("Node is not available: missing-native", missing.ToJsonString());
        foreach (var id in new[] { "master", "offline-cli-node" })
        {
            var destroy = Lifecycle("destroy", id);
            destroy["confirmation"] = "destroy node " + id;
            Assert.Contains("does not support", (await f.Call("node", destroy)).ToJsonString());
        }
        foreach (var provider in new[] { "master", "authenticated-remote" })
        foreach (var action in new[] { "create", "ensure" })
            Assert.Contains(
                "does not support",
                (await f.Call("node", Lifecycle(action, provider: provider))).ToJsonString()
            );
        Assert.False(File.Exists(Path.Combine(f.Target, "calls.jsonl")));
        Assert.False(File.Exists(Path.Combine(f.OtherTarget, "calls.jsonl")));
        Assert.Equal("master", f.Manager.CurrentNode(f.Owner));
        Assert.Equal(f.Work, f.Manager.ExecutionPlacement(f.Owner).Cwd);
        Assert.Equal(new[] { "main" }, f.Manager.Agents());

        // A real executable discovery failure and an unsupported executable inspection stay errors.
        var unavailable = await f.Call("node", Lifecycle("inspect", f.Node));
        Assert.Contains("Directory temporarily unavailable", unavailable.ToJsonString());
        Assert.Null(unavailable["node"]);
        Assert.Equal("list", Assert.Single(await f.Requests())["operation"]!.GetValue<string>());
        var unsupported = await f.Call("node", Lifecycle("inspect", "other/target"));
        Assert.Contains("does not support", unsupported.ToJsonString());
        Assert.Null(unsupported["node"]);
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(
            policy,
            "version: 1\nrules: [{action: deny, node: offline-cli-node}]\n"
        );
        f.Manager.Authorization.Invalidate();
        var denied = await f.Call("node", Lifecycle("inspect", "offline-cli-node"));
        Assert.Equal("tool_authorization_denied", SessionWait.Text(denied["error"]?["type"]));
        Assert.Null(denied["node"]);
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
                Lifecycle("inspect", "master"),
                Lifecycle("select", "master"),
            }
        )
            Assert.NotNull((await f.Call("node", denied))["error"]);
        Assert.False(File.Exists(Path.Combine(f.Target, "effects.jsonl")));
    }

    [Fact]
    public async Task Plain_lifecycle_parameters_reject_nonfinite_numbers_and_oversized_containers_before_effect()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        var tooManyProperties = new JsonObject();
        for (var index = 0; index < 2049; index++)
            tooManyProperties["k" + index] = 0;
        foreach (
            var parameters in new[]
            {
                new JsonObject
                {
                    ["items"] = new JsonArray(
                        Enumerable
                            .Range(0, 2049)
                            .Select(_ => (JsonNode?)JsonValue.Create(0))
                            .ToArray()
                    ),
                },
                tooManyProperties,
            }
        )
            Assert.NotNull(
                (
                    await f.Call(
                        "node",
                        Lifecycle(
                            "create",
                            "fixture/rejected",
                            "fixture",
                            (JsonObject)parameters.DeepClone()
                        )
                    )
                )["error"]
            );
        var nonfinite = Lifecycle("create", "fixture/nonfinite", "fixture");
        nonfinite["parametersJson"] = "{\"huge\":1e400}";
        Assert.NotNull((await f.Call("node", nonfinite))["error"]);
        Assert.False(File.Exists(Path.Combine(f.Target, "effects.jsonl")));
        Assert.False(File.Exists(Path.Combine(f.Target, "calls.jsonl")));

        tooManyProperties.Remove("k2048");
        Success(
            await f.Call(
                "node",
                Lifecycle("create", "fixture/object", "fixture", tooManyProperties)
            )
        );
        Success(
            await f.Call(
                "node",
                Lifecycle(
                    "create",
                    "fixture/array",
                    "fixture",
                    new JsonObject
                    {
                        ["items"] = new JsonArray(
                            Enumerable
                                .Range(0, 2048)
                                .Select(_ => (JsonNode?)JsonValue.Create(0))
                                .ToArray()
                        ),
                    }
                )
            )
        );
        var finite = Lifecycle("create", "fixture/finite", "fixture");
        finite["parametersJson"] = "{\"large\":1e308,\"tiny\":5e-324,\"negativeZero\":-0}";
        Success(await f.Call("node", finite));
        Assert.Equal(
            3,
            (await File.ReadAllLinesAsync(Path.Combine(f.Target, "effects.jsonl"))).Length
        );
    }

    [Fact]
    public async Task Full_inspection_preserves_distinct_protocol_and_service_container_limits()
    {
        if (!OperatingSystem.IsLinux())
            return;
        foreach (var entries in new[] { 2049, 2048 })
        {
            await using var f = await Fixture.Create("lifecycle");
            var description = new JsonObject
            {
                ["label"] = "Fixture",
                ["description"] = "Plain schema data.",
                ["lifecycle"] = new JsonArray("inspect"),
                ["createParameters"] = new JsonArray(
                    Enumerable
                        .Range(0, entries)
                        .Select(_ => (JsonNode?)JsonValue.Create(0))
                        .ToArray()
                ),
            };
            await File.WriteAllTextAsync(
                Path.Combine(f.Target, "description.json"),
                description.ToJsonString()
            );
            var protocol = new ExecutableNodeProvider(
                "fixture",
                ExecutableNodeProviderTests.Configuration(f.Target)
            );
            Assert.Equal(
                entries,
                (await protocol.DescribeAsync(default))["createParameters"]!.AsArray().Count
            );
            var inspected = await f.Call("node", Lifecycle("inspect", provider: "fixture"));
            if (entries == 2048)
                Success(inspected);
            else
                Assert.NotNull(inspected["error"]);
        }
    }

    [Fact]
    public async Task Unicode_schema_inspection_uses_the_inclusive_serialized_byte_boundary()
    {
        if (!OperatingSystem.IsLinux())
            return;
        foreach (var extra in new[] { "xxx", "xx" })
        {
            await using var f = await Fixture.Create();
            var schema = new string('\u2028', 5460) + extra;
            var description = new JsonObject
            {
                ["label"] = "Fixture",
                ["description"] = "Plain schema data.",
                ["lifecycle"] = new JsonArray(),
                ["createParameters"] = schema,
            };
            await File.WriteAllTextAsync(
                Path.Combine(f.Target, "description.json"),
                description.ToJsonString()
            );
            Assert.Equal(
                extra.Length == 2 ? 16384 : 16385,
                System.Text.Encoding.UTF8.GetByteCount(schema) + 2
            );
            var inspected = await f.Call("node", Lifecycle("inspect", provider: "fixture"));
            if (extra.Length == 2)
            {
                Success(inspected);
                Assert.Equal(
                    schema,
                    inspected["provider"]!["createParameters"]!.GetValue<string>()
                );
            }
            else
                Assert.NotNull(inspected["error"]);
        }
    }

    [Fact]
    public async Task Parameter_byte_limit_is_checked_before_effect_and_full_lifecycle_result_keeps_service_bounds()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("lifecycle");
        // Keep response details small to observe the parameter budget independently.
        await File.WriteAllTextAsync(Path.Combine(f.Target, "details.json"), "{}");
        var parameters = new JsonObject { ["padding"] = new string('x', 65523) };
        Assert.Equal(65537, System.Text.Encoding.UTF8.GetByteCount(parameters.ToJsonString()));
        Assert.NotNull(
            (
                await f.Call(
                    "node",
                    Lifecycle(
                        "create",
                        "fixture/over",
                        "fixture",
                        (JsonObject)parameters.DeepClone()
                    )
                )
            )["error"]
        );
        Assert.False(File.Exists(Path.Combine(f.Target, "effects.jsonl")));
        parameters["padding"] = new string('x', 65522);
        Assert.Equal(65536, System.Text.Encoding.UTF8.GetByteCount(parameters.ToJsonString()));
        Success(
            await f.Call("node", Lifecycle("create", "fixture/boundary", "fixture", parameters))
        );
        foreach (var entries in new[] { 2049, 2048 })
        {
            await File.WriteAllTextAsync(
                Path.Combine(f.Target, "details.json"),
                new JsonArray(
                    Enumerable
                        .Range(0, entries)
                        .Select(_ => (JsonNode?)JsonValue.Create(0))
                        .ToArray()
                ).ToJsonString()
            );
            var created = await f.Call(
                "node",
                Lifecycle("create", "fixture/result" + entries, "fixture")
            );
            if (entries == 2048)
                Success(created);
            else
                Assert.NotNull(created["error"]);
        }
        // Result rejection is post-effect and must not replay or undo the adapter's action.
        Assert.Equal(
            3,
            (await File.ReadAllLinesAsync(Path.Combine(f.Target, "effects.jsonl"))).Length
        );
    }

    [Fact]
    public void Plain_json_byte_budgets_use_stringify_strings_and_binary64_numbers_at_inclusive_boundaries()
    {
        // JSON.stringify bytes: quotes, literal separators/non-BMP, controls, literal escapes,
        // and fixed/scientific number thresholds. Archive-only integer exactness is not a rule here.
        foreach (
            var (json, bytes) in new[]
            {
                ("\"" + new string('\u2028', 3000) + "\"", 9002),
                ("\"\u2029😀\"", 9),
                ("\"\\\\u2028\"", 9),
                ("\"\\u0000\\n\\t\\\"\\\\\"", 16),
                ("1e-6", 8),
                ("1e20", 21),
                ("1e21", 5),
                ("-0", 1),
                ("9007199254740993", 16),
            }
        )
        {
            var value = JsonNode.Parse(json)!;
            ExecutableNodeProvider.BoundedJson(value, bytes);
            Assert.Throws<NodeProviderException>(() =>
                ExecutableNodeProvider.BoundedJson(value, bytes - 1)
            );
        }
        foreach (var budget in new[] { 16 * 1024, 64 * 1024 })
        {
            ExecutableNodeProvider.BoundedJson(
                JsonValue.Create(new string('x', budget - 2)),
                budget
            );
            Assert.Throws<NodeProviderException>(() =>
                ExecutableNodeProvider.BoundedJson(
                    JsonValue.Create(new string('x', budget - 1)),
                    budget
                )
            );
        }
        foreach (var service in new[] { false, true })
            Assert.Throws<NodeProviderException>(() =>
                ExecutableNodeProvider.BoundedJson(
                    JsonNode.Parse("1e400"),
                    1024,
                    serviceBudget: service
                )
            );
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
