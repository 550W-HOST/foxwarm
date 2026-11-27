using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

[Collection("PolicyScriptStaticHooks")]
public sealed class PolicyScriptAgentLayerTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    [Fact]
    public async Task AgentRulePolicy_accepts_script_object_and_rejects_bad_shape_and_caller_selectors()
    {
        var withData = await AgentRulePolicy.ParseAsync(
            new JsonObject
            {
                ["data"] = new JsonObject
                {
                    ["nodes"] = new JsonArray("dev-a", "dev-b"),
                },
                ["script"] = """
                rules = []
                for n in data["nodes"]:
                    rules.append({
                        "id": f"read-{n}",
                        "op": "env.read",
                        "node": {"exact": n},
                        "action": "allow",
                    })
                rules.append({"id": "deny-rest", "action": "deny"})
                return rules
                """,
            }
        );
        var rules = withData.Value["rules"]!.AsArray();
        Assert.Equal(3, rules.Count);
        Assert.Equal("read-dev-a", rules[0]!["id"]!.GetValue<string>());
        Assert.Equal("deny-rest", rules[2]!["id"]!.GetValue<string>());
        Assert.True(withData.HasOperationRules);

        var unknownField = await Assert.ThrowsAsync<InvalidDataException>(() =>
            AgentRulePolicy.ParseAsync(
                new JsonObject { ["script"] = "return []", ["extra"] = true }
            )
        );
        Assert.Contains("Unknown Agent rules field `extra`", unknownField.Message);

        var missingScript = await Assert.ThrowsAsync<InvalidDataException>(() =>
            AgentRulePolicy.ParseAsync(new JsonObject { ["data"] = new JsonObject() })
        );
        Assert.Contains("non-empty string", missingScript.Message);

        var callerSelector = await Assert.ThrowsAsync<InvalidDataException>(() =>
            AgentRulePolicy.ParseAsync(
                new JsonObject
                {
                    ["script"] =
                        "return [{'id': 'ok', 'action': 'allow'}, {'id': 'bad-caller', 'agent': 'other', 'action': 'deny'}]",
                }
            )
        );
        Assert.Contains("rule[1]", callerSelector.Message);
        Assert.Contains("bad-caller", callerSelector.Message);
        Assert.Contains("caller selectors", callerSelector.Message);

        var badRule = await Assert.ThrowsAsync<InvalidDataException>(() =>
            AgentRulePolicy.ParseAsync(
                new JsonObject
                {
                    ["script"] =
                        "return [{'id': 'ok', 'action': 'allow'}, {'id': 'bad-act', 'action': 'permit'}]",
                }
            )
        );
        Assert.Contains("rule[1]", badRule.Message);
        Assert.Contains("bad-act", badRule.Message);
    }

    [Fact]
    public async Task ReaderVersion_raises_to_3_only_when_an_Agent_row_uses_the_object_form()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(workspace);

        var catalog = new AgentCatalog(data, workspace);
        Assert.Equal(3, AgentCatalog.ReaderVersion);
        Assert.Null(AgentCatalog.MinimumReaderVersion(catalog.InstallationPath));

        // Plain array layer leaves minimumReaderVersion unset.
        await catalog.CreateAsync(
            "plain",
            rules: new JsonArray
            {
                new JsonObject { ["id"] = "deny-all", ["action"] = "deny" },
            }
        );
        Assert.Null(AgentCatalog.MinimumReaderVersion(catalog.InstallationPath));

        // Array layer with op rule raises minimumReaderVersion to 2 (not 3).
        await catalog.CreateAsync(
            "op-array",
            rules: new JsonArray
            {
                new JsonObject
                {
                    ["id"] = "read-master",
                    ["op"] = "env.read",
                    ["node"] = new JsonObject { ["exact"] = "master" },
                    ["action"] = "allow",
                },
            }
        );
        Assert.Equal(2, AgentCatalog.MinimumReaderVersion(catalog.InstallationPath));

        // Scripted object layer raises minimumReaderVersion to 3.
        await catalog.CreateAsync(
            "scripted",
            rules: new JsonObject
            {
                ["script"] = "return [{'id': 'deny-all', 'action': 'deny'}]",
            }
        );
        Assert.Equal(3, AgentCatalog.MinimumReaderVersion(catalog.InstallationPath));

        // A binary seeing minimumReaderVersion > ReaderVersion refuses startup cleanly.
        await File.WriteAllTextAsync(
            catalog.InstallationPath,
            new JsonObject { ["minimumReaderVersion"] = AgentCatalog.ReaderVersion + 1 }.ToJsonString()
        );
        var tooNew = Assert.Throws<InvalidDataException>(() => new AgentCatalog(data, workspace));
        Assert.Contains("reads level 3", tooNew.Message);
    }

    [Fact]
    public async Task AgentCatalog_caches_scripted_layers_and_does_not_cache_transient_failures()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(workspace);

        var catalog = new AgentCatalog(data, workspace);
        var scriptObj = new JsonObject
        {
            ["data"] = new JsonObject { ["ops"] = new JsonArray("env.read", "env.write") },
            ["script"] = """
            return [
                {"id": f"allow-{op}", "op": op, "node": {"exact": "master"}, "action": "allow"}
                for op in data["ops"]
            ] + [{"id": "deny-rest", "action": "deny"}]
            """,
        };

        var c0 = PolicyScriptRunner.CompilationCount;
        await catalog.CreateAsync("worker", rules: scriptObj);
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        // Pre-warmed cache: NamedRuleLayers & ExpandedRuleCount do not re-run Monty.
        var layers1 = catalog.NamedRuleLayers("worker");
        var layers2 = catalog.NamedRuleLayers("worker");
        Assert.Same(layers1[^1].Policy, layers2[^1].Policy);
        Assert.Equal(3, catalog.ExpandedRuleCount("worker"));
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        // Reloading catalog cold: transient worker spawn failure is NOT cached and recovers cleanly.
        var prevBinary = PolicyScriptRunner.BinaryOverride;
        try
        {
            var reloaded = new AgentCatalog(data, workspace);
            PolicyScriptRunner.BinaryOverride = () => "/nonexistent/monty-missing";
            Assert.Throws<InvalidDataException>(() => reloaded.NamedRuleLayers("worker"));

            PolicyScriptRunner.BinaryOverride = prevBinary;
            var recovered = reloaded.NamedRuleLayers("worker");
            Assert.Equal(3, recovered[^1].Policy.Value["rules"]!.AsArray().Count);
            Assert.Equal(c0 + 2, PolicyScriptRunner.CompilationCount);
            // Subsequent read hits cache.
            Assert.Same(recovered[^1].Policy, reloaded.NamedRuleLayers("worker")[^1].Policy);
            Assert.Equal(c0 + 2, PolicyScriptRunner.CompilationCount);
        }
        finally
        {
            PolicyScriptRunner.BinaryOverride = prevBinary;
        }
    }

    [Fact]
    public async Task Create_agent_and_set_agent_rules_tools_and_ctl_support_scripted_layers_and_enforce_them()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(workspace, "agents", "main", "memory"));

        await using var manager = new SessionManager(
            data,
            workspace,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var mainSession = await manager.CreateNamedAsync("main", "main", null, null);
        var mainFiles = new WorkspaceTools(
            Path.Combine(workspace, "agents", "main"),
            new PendingWriteRefs(),
            mainSession.Id,
            mainSession.Agent
        );
        var definitions = WorkspaceTools.Definitions();
        foreach (var d in AgentToolDefinitions.Definitions())
            definitions.Add(d.DeepClone());
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        definitions.Add(ToolAuthorizationToolDefinition.ExplainDefinition());
        foreach (var d in UnifiedToolDefinitions.All())
            definitions.Add(d?.DeepClone());
        await using var mcp = new Foxwarm.McpClient(data);
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            owner => Path.Combine(workspace, "agents", owner.Agent)
        );
        var mainTools = new SessionToolExecutor(mainFiles, mainSession, manager, registry);
        mainTools.BeginTurn();

        static async Task<JsonObject> Call(SessionToolExecutor tools, string name, JsonObject args) =>
            (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString("N"),
                        ["name"] = name,
                        ["args"] = args,
                    },
                    CancellationToken.None
                )
            )!.AsObject();

        // Create child Agent via ctl with a scripted layer object passed via @r.
        var initialScript = new JsonObject
        {
            ["data"] = new JsonObject { ["allowedTools"] = new JsonArray("read") },
            ["script"] = """
            rules = [
                {"id": f"allow-{t}", "tool": {"source": "node", "name": t}, "action": "allow"}
                for t in data["allowedTools"]
            ]
            rules.append({"id": "deny-rest", "action": "deny"})
            return rules
            """,
        };
        var created = await Call(
            mainTools,
            "ctl",
            new JsonObject
            {
                ["command"] = "agent create worker --rules @r",
                ["values"] = new JsonObject { ["r"] = initialScript.DeepClone() },
            }
        );
        Assert.Null(created["error"]);

        // Verify worker's generated rules are actually enforced: read allowed, exec denied.
        var workerSession = await manager.RequiredAsync("worker/main");
        var workerFiles = new WorkspaceTools(
            Path.Combine(workspace, "agents", "worker"),
            new PendingWriteRefs(),
            workerSession.Id,
            workerSession.Agent
        );
        await manager.AuthorizeToolAsync(
            workerSession,
            new("read", "node", "read", new JsonObject { ["filePath"] = "MEMORY.md" }),
            workerFiles,
            CancellationToken.None
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                workerSession,
                new("exec", "node", "exec", new JsonObject { ["command"] = "true" }),
                workerFiles,
                CancellationToken.None
            )
        );

        // AgentRegistry reports the stored object, expanded ruleCount=2, and restricted=true.
        var listed = manager
            .AgentRegistry()
            .Cast<JsonObject>()
            .Single(row => row["id"]!.GetValue<string>() == "worker");
        Assert.IsType<JsonObject>(listed["rules"]);
        Assert.Equal(2, listed["ruleCount"]!.GetValue<int>());
        Assert.True(listed["restricted"]!.GetValue<bool>());

        // Bad set_agent_rules script fails with line/index error and keeps existing rules intact.
        var badReplace = await Call(
            mainTools,
            "ctl",
            new JsonObject
            {
                ["command"] = "agent set-rules worker --rules @r",
                ["values"] = new JsonObject
                {
                    ["r"] = new JsonObject
                    {
                        ["script"] = "return [{'id': 'bad', 'agent': 'worker', 'action': 'allow'}]",
                    },
                },
            }
        );
        Assert.NotNull(badReplace["error"]);
        Assert.Contains("rule[0]", badReplace["error"]!.ToJsonString());
        Assert.Equal(2, manager.AgentRuleCount("worker"));

        // Valid set_agent_rules via ctl replaces layer so exec is now allowed.
        var replaced = await Call(
            mainTools,
            "ctl",
            new JsonObject
            {
                ["command"] = "agent set-rules worker --rules @r",
                ["values"] = new JsonObject
                {
                    ["r"] = new JsonObject
                    {
                        ["data"] = new JsonObject { ["allowedTools"] = new JsonArray("read", "exec") },
                        ["script"] = initialScript["script"]!.DeepClone(),
                    },
                },
            }
        );
        Assert.Null(replaced["error"]);
        Assert.Equal(3, manager.AgentRuleCount("worker"));
        await manager.AuthorizeToolAsync(
            workerSession,
            new("exec", "node", "exec", new JsonObject { ["command"] = "true" }),
            workerFiles,
            CancellationToken.None
        );

        // explain_tool_authorization sees the expanded rules of the scripted Agent layer.
        var explained = await Call(
            mainTools,
            "explain_tool_authorization",
            new JsonObject
            {
                ["probes"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["sessionId"] = "worker/main",
                        ["toolId"] = "node:master/exec",
                        ["args"] = new JsonObject { ["command"] = "true" },
                    },
                    new JsonObject
                    {
                        ["sessionId"] = "worker/main",
                        ["toolId"] = "node:master/write",
                        ["args"] = new JsonObject { ["filePath"] = "x.txt", ["content"] = "hi" },
                    },
                },
            }
        );
        Assert.Null(explained["error"]);
        var probeRows = explained["probes"]!.AsArray();
        Assert.Equal("allow", probeRows[0]!["active"]!["decision"]!.GetValue<string>());
        Assert.Equal("deny", probeRows[1]!["active"]!["decision"]!.GetValue<string>());
    }

    [Fact]
    public async Task Migrated_isolated_Agent_with_restrictive_script_layer_survives_restart_reconciliation()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(workspace, "agents", "main", "memory"));
        Directory.CreateDirectory(Path.Combine(workspace, "agents", "worker", "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            new JsonObject
            {
                ["version"] = 2,
                ["agents"] = new JsonArray("worker"),
                ["metadata"] = new JsonObject
                {
                    ["worker"] = new JsonObject
                    {
                        ["isolated"] = true,
                        ["isolatedNode"] = "bound-node",
                        ["toolRules"] = new JsonArray(),
                    },
                },
            }.ToJsonString()
        );

        await using (
            var first = new SessionManager(data, workspace, Options, HostModels.ForTest(Options))
        )
        {
            await first.LoadAsync();
            // Administrator replaces the migrated layer with a scripted layer ending in deny.
            await first.SetAgentRulesAsync(
                "worker",
                new JsonObject
                {
                    ["script"] = """
                    return [
                        {"id": "read-bound", "op": "env.read", "node": {"exact": "bound-node"}, "action": "allow"},
                        {"id": "deny-rest", "action": "deny"},
                    ]
                    """,
                }
            );
        }

        // Restarting must keep the administrator's scripted layer intact (no failClosed overwrite).
        await using var restarted = new SessionManager(
            data,
            workspace,
            Options,
            HostModels.ForTest(Options)
        );
        await restarted.LoadAsync();
        Assert.IsType<JsonObject>(restarted.AgentMetadata["worker"]!["rules"]);
        Assert.Empty(restarted.StartupIsolationMigration!["agents"]!.AsArray());
    }
}
