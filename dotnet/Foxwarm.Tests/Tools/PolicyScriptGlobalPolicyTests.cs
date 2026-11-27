using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

[Collection("PolicyScriptStaticHooks")]
public sealed class PolicyScriptGlobalPolicyTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public async Task Global_script_policy_accepts_script_with_or_without_data_and_validates_shape()
    {
        var noData = await ToolAuthorizationYaml.ParseAsync(
            Utf8(
                """
                version: 1
                defaultAction: deny
                script: |
                  return [
                    {"id": "only-read", "op": "env.read", "node": {"exact": "master"}, "action": "allow"},
                  ]
                """
            )
        );
        Assert.Equal("deny", noData.Value["defaultAction"]!.GetValue<string>());
        Assert.Single(noData.Value["rules"]!.AsArray());
        Assert.True(noData.HasOperationRules);

        var withData = await ToolAuthorizationYaml.ParseAsync(
            Utf8(
                """
                version: 1
                defaultAction: deny
                data:
                  teams:
                    - { name: alpha, node: dev-alpha }
                    - { name: beta, node: dev-beta }
                script: |
                  out = []
                  for team in data["teams"]:
                    out.append({
                      "id": f"{team['name']}-work",
                      "agent": team["name"],
                      "op": ["env.read", "env.write"],
                      "node": {"provider": team["node"]},
                      "action": "allow",
                    })
                  return out
                """
            )
        );
        var rules = withData.Value["rules"]!.AsArray();
        Assert.Equal(2, rules.Count);
        Assert.Equal("alpha-work", rules[0]!["id"]!.GetValue<string>());
        Assert.Equal("beta-work", rules[1]!["id"]!.GetValue<string>());

        var both = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8("version: 1\nrules: []\nscript: 'return []'\n")
            )
        );
        Assert.Contains("both `rules` and `script`", both.Message);

        var dataOnly = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8("version: 1\ndata: {a: 1}\nrules: []\n")
            )
        );
        Assert.Contains("`data` requires `script`", dataOnly.Message);

        var blankScript = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(Utf8("version: 1\nscript: '   '\n"))
        );
        Assert.Contains("non-empty string", blankScript.Message);

        var beforeBadHeader = PolicyScriptRunner.CompilationCount;
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8("version: 2\nscript: 'while True: pass'\n")
            )
        );
        Assert.Equal(beforeBadHeader, PolicyScriptRunner.CompilationCount);
    }

    [Fact]
    public async Task Script_syntax_runtime_and_output_rule_errors_report_line_or_rule_index()
    {
        var syntax = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8("version: 1\nscript: |\n  x = 1\n  def broken(1):\n    pass\n")
            )
        );
        Assert.Contains("line 2", syntax.Message);
        Assert.Contains("SyntaxError", syntax.Message);

        var runtime = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8("version: 1\nscript: |\n  x = 1\n  y = 0\n  return [x / y]\n")
            )
        );
        Assert.Contains("line 3", runtime.Message);
        Assert.Contains("ZeroDivisionError", runtime.Message);

        var badRule = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8(
                    """
                    version: 1
                    script: |
                      return [
                        {"id": "ok-rule", "action": "allow"},
                        {"id": "bad-action", "action": "permit"},
                      ]
                    """
                )
            )
        );
        Assert.Contains("rule[1]", badRule.Message);
        Assert.Contains("bad-action", badRule.Message);
        Assert.Contains("Invalid policy action", badRule.Message);

        var nonObjectRule = await Assert.ThrowsAsync<InvalidDataException>(() =>
            ToolAuthorizationYaml.ParseAsync(
                Utf8("version: 1\nscript: |\n  return [{'id': 'r0', 'action': 'allow'}, 'oops']\n")
            )
        );
        Assert.Contains("rule[1]", nonObjectRule.Message);
        Assert.Contains("must be an object", nonObjectRule.Message);
    }

    [Fact]
    public async Task Authority_caches_by_content_hash_past_ttl_recompiles_on_change_and_fails_closed()
    {
        using var temp = new TempDirectory();
        var now = 1_000L;
        var authority = new ToolAuthorizationAuthority(
            temp.Path,
            clock: () => now,
            retryDelay: _ => Task.CompletedTask
        );
        Directory.CreateDirectory(Path.GetDirectoryName(authority.PolicyPath)!);

        const string scriptV1 = """
            version: 1
            defaultAction: deny
            data:
              allowed: [alpha]
            script: |
              return [{"id": f"{a}-ok", "agent": a, "action": "allow"} for a in data["allowed"]]
            """;
        const string scriptV2 = """
            version: 1
            defaultAction: deny
            data:
              allowed: [alpha, beta]
            script: |
              return [{"id": f"{a}-ok", "agent": a, "action": "allow"} for a in data["allowed"]]
            """;

        await File.WriteAllTextAsync(authority.PolicyPath, scriptV1);

        var c0 = PolicyScriptRunner.CompilationCount;
        var first = await authority.LoadAsync();
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);
        Assert.Single(first.Value["rules"]!.AsArray());

        // Within 10s TTL: no disk read, no compile.
        now += 5_000;
        Assert.Same(first, await authority.LoadAsync());
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        // Past 10s TTL with unchanged file bytes: content hash matches, no Monty re-run.
        now += 20_000;
        Assert.Same(first, await authority.LoadAsync());
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        now += 60_000;
        Assert.Same(first, authority.Load());
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        // Changing file bytes on disk triggers exactly one new compilation past TTL.
        await File.WriteAllTextAsync(authority.PolicyPath, scriptV2);
        now += 15_000;
        var second = await authority.LoadAsync();
        Assert.Equal(c0 + 2, PolicyScriptRunner.CompilationCount);
        Assert.Equal(2, second.Value["rules"]!.AsArray().Count);

        // InstallAsync compiles once and populates cache so immediate LoadAsync does not recompile.
        const string scriptV3 = """
            version: 1
            defaultAction: deny
            script: |
              return [{"id": "only-v3", "action": "allow"}]
            """;
        await authority.InstallAsync(Utf8(scriptV3), CancellationToken.None);
        Assert.Equal(c0 + 3, PolicyScriptRunner.CompilationCount);
        var third = await authority.LoadAsync();
        Assert.Equal(c0 + 3, PolicyScriptRunner.CompilationCount);
        Assert.Equal("only-v3", third.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>());

        // Direct edit with broken script fails closed after TTL; never returns stale policy.
        await File.WriteAllTextAsync(
            authority.PolicyPath,
            "version: 1\nscript: |\n  import time\n  time.time()\n  return []\n"
        );
        now += 15_000;
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
            authority.LoadAsync()
        );
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
    }

    [Fact]
    public async Task Transient_load_failures_are_not_cached_and_recover_on_next_load()
    {
        using var temp = new TempDirectory();
        var now = 1_000L;
        var authority = new ToolAuthorizationAuthority(
            temp.Path,
            clock: () => now,
            retryDelay: _ => Task.CompletedTask
        );
        Directory.CreateDirectory(Path.GetDirectoryName(authority.PolicyPath)!);

        const string validScript = """
            version: 1
            defaultAction: deny
            script: |
              return [{"id": "recovered", "action": "allow"}]
            """;
        await File.WriteAllTextAsync(authority.PolicyPath, validScript);

        var prevBinary = PolicyScriptRunner.BinaryOverride;
        var prevSpawn = PolicyScriptRunner.OnBeforeSpawn;
        var prevStartup = PolicyScriptRunner.StartupWallClockOverride;
        try
        {
            // 1. Spawn failure (missing/unspawnable worker) -> fails closed, NOT cached; recovers on next Load.
            PolicyScriptRunner.BinaryOverride = () => "/nonexistent/monty-spawn-fail";
            await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
                authority.LoadAsync()
            );

            PolicyScriptRunner.BinaryOverride = prevBinary;
            var afterSpawn = await authority.LoadAsync();
            Assert.Equal(
                "recovered",
                afterSpawn.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>()
            );

            // 2. Crashed worker on changed policy -> fails closed, NOT cached; recovers on next Load.
            var crashingWorker = Path.Combine(temp.Path, "crash-worker.sh");
            await File.WriteAllTextAsync(crashingWorker, "#!/bin/sh\nexit 1\n");
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(
                    crashingWorker,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                );

            const string validScriptV2 = """
                version: 1
                defaultAction: deny
                script: |
                  return [{"id": "recovered-v2", "action": "allow"}]
                """;
            await File.WriteAllTextAsync(authority.PolicyPath, validScriptV2);
            now += 15_000;
            PolicyScriptRunner.BinaryOverride = () => crashingWorker;
            await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
                authority.LoadAsync()
            );

            PolicyScriptRunner.BinaryOverride = prevBinary;
            var afterCrash = await authority.LoadAsync();
            Assert.Equal(
                "recovered-v2",
                afterCrash.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>()
            );

            // 3. Startup timeout on changed policy -> fails closed, NOT cached; recovers on next Load.
            const string validScriptV3 = """
                version: 1
                defaultAction: deny
                script: |
                  return [{"id": "recovered-v3", "action": "allow"}]
                """;
            await File.WriteAllTextAsync(authority.PolicyPath, validScriptV3);
            now += 15_000;
            PolicyScriptRunner.StartupWallClockOverride = TimeSpan.FromMilliseconds(20);
            PolicyScriptRunner.OnBeforeSpawn = () => Thread.Sleep(80);
            await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() =>
                authority.LoadAsync()
            );

            PolicyScriptRunner.OnBeforeSpawn = null;
            PolicyScriptRunner.StartupWallClockOverride = prevStartup;
            var afterTimeout = await authority.LoadAsync();
            Assert.Equal(
                "recovered-v3",
                afterTimeout.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>()
            );
        }
        finally
        {
            PolicyScriptRunner.BinaryOverride = prevBinary;
            PolicyScriptRunner.OnBeforeSpawn = prevSpawn;
            PolicyScriptRunner.StartupWallClockOverride = prevStartup;
        }
    }

    [Fact]
    public async Task Deterministic_script_error_stays_cached_until_policy_bytes_change()
    {
        using var temp = new TempDirectory();
        var now = 1_000L;
        var authority = new ToolAuthorizationAuthority(
            temp.Path,
            clock: () => now,
            retryDelay: _ => Task.CompletedTask
        );
        Directory.CreateDirectory(Path.GetDirectoryName(authority.PolicyPath)!);

        await File.WriteAllTextAsync(
            authority.PolicyPath,
            "version: 1\nscript: |\n  return [1 / 0]\n"
        );

        var c0 = PolicyScriptRunner.CompilationCount;
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() => authority.LoadAsync());
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        // Repeated loads with unchanged bytes stay failed closed without re-running Monty.
        now += 15_000;
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() => authority.LoadAsync());
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
        Assert.Equal(c0 + 1, PolicyScriptRunner.CompilationCount);

        // Updating the file bytes clears the failure and compiles once.
        await File.WriteAllTextAsync(
            authority.PolicyPath,
            "version: 1\nscript: |\n  return [{'id': 'fixed', 'action': 'allow'}]\n"
        );
        var fixedPolicy = await authority.LoadAsync();
        Assert.Equal(c0 + 2, PolicyScriptRunner.CompilationCount);
        Assert.Equal(
            "fixed",
            fixedPolicy.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Cold_synchronous_Load_runs_concurrently_without_deadlock()
    {
        using var temp = new TempDirectory();
        var authority = new ToolAuthorizationAuthority(temp.Path);
        Directory.CreateDirectory(Path.GetDirectoryName(authority.PolicyPath)!);
        await File.WriteAllTextAsync(
            authority.PolicyPath,
            """
            version: 1
            defaultAction: deny
            script: |
              return [{"id": "cold-sync", "action": "allow"}]
            """
        );

        var loaded = await Task.WhenAll(
            Enumerable.Range(0, 4).Select(_ => Task.Run(() => authority.Load()))
        );
        Assert.All(
            loaded,
            policy =>
                Assert.Equal(
                    "cold-sync",
                    policy.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>()
                )
        );
    }

    [Fact]
    public async Task AgentCatalog_caches_parsed_layers_per_row_until_updated()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(workspace);
        var catalog = new AgentCatalog(data, workspace);
        await catalog.CreateAsync(
            "worker",
            rules: new JsonArray
            {
                new JsonObject
                {
                    ["id"] = "no-master",
                    ["node"] = new JsonObject { ["exact"] = "master" },
                    ["action"] = "deny",
                },
            }
        );

        var first = catalog.NamedRuleLayers("worker");
        var second = catalog.NamedRuleLayers("worker");
        Assert.Equal(first.Length, second.Length);
        Assert.Same(first[^1].Policy, second[^1].Policy);

        await catalog.SetRulesAsync(
            "worker",
            new JsonArray
            {
                new JsonObject { ["id"] = "deny-all", ["action"] = "deny" },
            }
        );
        var updated = catalog.NamedRuleLayers("worker");
        Assert.NotSame(first[^1].Policy, updated[^1].Policy);
        Assert.Equal(
            "deny-all",
            updated[^1].Policy.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Explain_compare_between_handwritten_and_equivalent_script_gives_empty_ruleDiff_both_ways()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            new JsonObject
            {
                ["version"] = 2,
                ["agents"] = new JsonArray("alpha", "beta"),
                ["metadata"] = new JsonObject(),
            }.ToJsonString()
        );
        foreach (var agent in new[] { "alpha", "beta" })
            Directory.CreateDirectory(Path.Combine(workspace, "agents", agent, "memory"));
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            foreach (var (id, agent) in new[] { ("s-alpha", "alpha"), ("s-beta", "beta") })
            {
                await SessionCatalogMigrationTests.Authority(data, id);
                var file = Path.Combine(data, "state", "sessions", id + ".json");
                var state = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
                state["agent"] = agent;
                await File.WriteAllTextAsync(file, state.ToJsonString());
                catalog.Upsert([SessionCatalogTests.Row(id, 0, null, agent, [agent])]);
            }
        }

        const string handwritten = """
            version: 1
            defaultAction: deny
            rules:
              - id: alpha-config-read
                agent: alpha
                op: [config.read, session.view]
                action: allow
              - id: alpha-read
                agent: alpha
                op: env.read
                node: { exact: master }
                action: allow
              - id: alpha-list
                agent: alpha
                tool: { source: builtin, name: list_agents }
                action: allow
              - id: beta-read
                agent: beta
                op: env.read
                node: { exact: master }
                action: allow
              - id: beta-exec-ask
                agent: beta
                op: env.exec
                node: { exact: master }
                action: ask
                reason: confirm beta exec
                approval: { timeoutSeconds: 600, approvers: [ops] }
            """;

        const string scripted = """
            version: 1
            defaultAction: deny
            data:
              readers: [alpha, beta]
              approvers: [ops]
            script: |
              rules = [
                {"id": "alpha-config-read", "agent": "alpha", "op": ["config.read", "session.view"], "action": "allow"},
              ]
              for agent in data["readers"]:
                rules.append({
                  "id": f"{agent}-read",
                  "agent": agent,
                  "op": "env.read",
                  "node": {"exact": "master"},
                  "action": "allow",
                })
                if agent == "alpha":
                  rules.append({
                    "id": "alpha-list",
                    "agent": "alpha",
                    "tool": {"source": "builtin", "name": "list_agents"},
                    "action": "allow",
                  })
              rules.append({
                "id": "beta-exec-ask",
                "agent": "beta",
                "op": "env.exec",
                "node": {"exact": "master"},
                "action": "ask",
                "reason": "confirm beta exec",
                "approval": {"timeoutSeconds": 600, "approvers": data["approvers"]},
              })
              return rules
            """;

        await using var manager = new SessionManager(
            data,
            workspace,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("s-alpha");
        var files = new WorkspaceTools(
            Path.Combine(workspace, "agents", "alpha"),
            new PendingWriteRefs(),
            caller.Id,
            caller.Agent
        );
        var definitions = WorkspaceTools.Definitions();
        foreach (var d in AgentToolDefinitions.Definitions())
            definitions.Add(d.DeepClone());
        definitions.Add(ToolAuthorizationToolDefinition.Definition());
        definitions.Add(ToolAuthorizationToolDefinition.ExplainDefinition());
        await using var mcp = new Foxwarm.McpClient(data);
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            _ => Path.Combine(workspace, "agents", caller.Agent)
        );
        var executor = new SessionToolExecutor(files, caller, manager, registry);
        executor.BeginTurn();

        static async Task<JsonObject> CallExplain(SessionToolExecutor tools, JsonObject args) =>
            (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString("N"),
                        ["name"] = "explain_tool_authorization",
                        ["args"] = args,
                    },
                    CancellationToken.None
                )
            )!.AsObject();

        var probes = new JsonArray
        {
            new JsonObject
            {
                ["sessionId"] = "s-alpha",
                ["toolId"] = "builtin:list_agents",
                ["args"] = new JsonObject(),
            },
            new JsonObject
            {
                ["sessionId"] = "s-beta",
                ["toolId"] = "node:master/read",
                ["args"] = new JsonObject { ["filePath"] = "MEMORY.md" },
            },
            new JsonObject
            {
                ["sessionId"] = "s-beta",
                ["toolId"] = "node:master/exec",
                ["args"] = new JsonObject { ["command"] = "true" },
            },
            new JsonObject
            {
                ["sessionId"] = "s-beta",
                ["toolId"] = "builtin:list_agents",
                ["args"] = new JsonObject(),
            },
        };

        // Direction 1: hand-written active vs scripted candidate
        await manager.Authorization.InstallAsync(Utf8(handwritten), CancellationToken.None);
        await File.WriteAllTextAsync(
            Path.Combine(workspace, "agents", "alpha", "candidate.yaml"),
            scripted
        );
        var forward = await CallExplain(
            executor,
            new JsonObject
            {
                ["compare"] = true,
                ["compact"] = true,
                ["policyFilePath"] = "candidate.yaml",
                ["probes"] = probes.DeepClone(),
            }
        );
        Assert.Null(forward["error"]);
        AssertEmptyRuleDiff(forward["ruleDiff"]!.AsObject());
        Assert.All(forward["probes"]!.AsArray(), row => Assert.False(row!["changed"]!.GetValue<bool>()));

        // Direction 2: scripted active vs hand-written candidate
        await manager.Authorization.InstallAsync(Utf8(scripted), CancellationToken.None);
        await File.WriteAllTextAsync(
            Path.Combine(workspace, "agents", "alpha", "handwritten.yaml"),
            handwritten
        );
        var reverse = await CallExplain(
            executor,
            new JsonObject
            {
                ["compare"] = true,
                ["compact"] = true,
                ["policyFilePath"] = "handwritten.yaml",
                ["probes"] = probes.DeepClone(),
            }
        );
        Assert.Null(reverse["error"]);
        AssertEmptyRuleDiff(reverse["ruleDiff"]!.AsObject());
        Assert.All(reverse["probes"]!.AsArray(), row => Assert.False(row!["changed"]!.GetValue<bool>()));
    }

    [Fact]
    public async Task Set_config_tool_rules_validates_scripts_reports_line_or_rule_index_and_keeps_active_file()
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
        var caller = await manager.CreateNamedAsync("main", "main", null, null);
        var files = new WorkspaceTools(
            Path.Combine(workspace, "agents", "main"),
            new PendingWriteRefs(),
            caller.Id,
            caller.Agent
        );

        const string initial = "version: 1\ndefaultAction: allow\nrules:\n  - id: keep-me\n    action: allow\n";
        await manager.Authorization.InstallAsync(Utf8(initial), CancellationToken.None);

        // Bad script (line error) must fail and preserve initial policy bytes.
        var badLineFile = Path.Combine(workspace, "agents", "main", "bad-line.yaml");
        await File.WriteAllTextAsync(
            badLineFile,
            "version: 1\nscript: |\n  x = 1\n  return [1 / 0]\n"
        );
        var lineErr = await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.InstallConfigAsync(
                caller,
                files,
                new JsonObject { ["target"] = "tool-rules", ["filePath"] = "bad-line.yaml" },
                CancellationToken.None
            )
        );
        Assert.Contains("line 2", lineErr.Message);
        Assert.Contains("The active file was not changed.", lineErr.Message);
        Assert.Equal(initial, await File.ReadAllTextAsync(manager.Authorization.PolicyPath));

        // Bad output rule (index error) must fail and preserve initial policy bytes.
        var badRuleFile = Path.Combine(workspace, "agents", "main", "bad-rule.yaml");
        await File.WriteAllTextAsync(
            badRuleFile,
            "version: 1\nscript: |\n  return [{'id': 'r0', 'action': 'allow'}, {'id': 'r1', 'action': 'bogus'}]\n"
        );
        var ruleErr = await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.InstallConfigAsync(
                caller,
                files,
                new JsonObject { ["target"] = "tool-rules", ["filePath"] = "bad-rule.yaml" },
                CancellationToken.None
            )
        );
        Assert.Contains("rule[1]", ruleErr.Message);
        Assert.Contains("The active file was not changed.", ruleErr.Message);
        Assert.Equal(initial, await File.ReadAllTextAsync(manager.Authorization.PolicyPath));

        // Valid scripted candidate installs once without double compilation.
        var goodFile = Path.Combine(workspace, "agents", "main", "good-script.yaml");
        await File.WriteAllTextAsync(
            goodFile,
            """
            version: 1
            defaultAction: allow
            script: |
              return [{"id": "deny-beta", "agent": "beta", "action": "deny"}]
            """
        );
        var before = PolicyScriptRunner.CompilationCount;
        await manager.InstallConfigAsync(
            caller,
            files,
            new JsonObject { ["target"] = "tool-rules", ["filePath"] = "good-script.yaml" },
            CancellationToken.None
        );
        Assert.Equal(before + 1, PolicyScriptRunner.CompilationCount);
        var active = await manager.Authorization.LoadAsync();
        Assert.Equal(before + 1, PolicyScriptRunner.CompilationCount);
        Assert.Equal("deny-beta", active.Value["rules"]!.AsArray()[0]!["id"]!.GetValue<string>());
    }

    private static void AssertEmptyRuleDiff(JsonObject diff)
    {
        Assert.Empty(diff["added"]!.AsArray());
        Assert.Empty(diff["removed"]!.AsArray());
        Assert.Empty(diff["changed"]!.AsArray());
        Assert.Empty(diff["moved"]!.AsArray());
    }
}
