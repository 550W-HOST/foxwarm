using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    // Adds cold Sessions "cold000"... to the seeded catalog, alternating the two seeded Agents.
    private static async Task SeedColdSessions(string root, int count)
    {
        var data = Path.Combine(root, "data");
        using var catalog = new SessionCatalog(data);
        catalog.Initialize();
        for (var index = 0; index < count; index++)
        {
            var id = $"cold{index:000}";
            var agent = index % 2 == 0 ? "alpha" : "beta";
            await SessionCatalogMigrationTests.Authority(data, id);
            var file = Path.Combine(data, "state", "sessions", id + ".json");
            var state = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
            state["agent"] = agent;
            await File.WriteAllTextAsync(file, state.ToJsonString());
            catalog.Upsert([SessionCatalogTests.Row(id, 0, null, agent, [])]);
        }
    }

    private static JsonObject Probe(string session, string tool, string args, string? label = null)
    {
        var probe = Obj($$"""{"sessionId":"{{session}}","toolId":"{{tool}}","args":{{args}}}""");
        if (label is not null)
            probe["label"] = label;
        return probe;
    }

    private static JsonArray Probes(params JsonObject[] probes) =>
        new(probes.Select(probe => (JsonNode?)probe).ToArray());

    private const string ExecArgs = """{"command":"true"}""";

    [Fact]
    public async Task Explain_accepts_256_probes_and_rejects_257_or_none()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);

        Assert.Equal(256, ToolAuthorizationToolDefinition.MaxExplainProbes);
        var schema = ToolAuthorizationToolDefinition.ExplainDefinition()["parameters"]!["properties"]!;
        Assert.Equal(256, schema["probes"]!["maxItems"]!.GetValue<int>());
        Assert.NotNull(schema["compact"]);
        Assert.NotNull(schema["probes"]!["items"]!["properties"]!["label"]);

        JsonObject Args(int count, bool compact)
        {
            var probes = new JsonArray();
            for (var index = 0; index < count; index++)
                probes.Add((JsonNode?)Probe("self", "builtin:wait", "{}"));
            return new JsonObject { ["probes"] = probes, ["compact"] = compact };
        }

        foreach (var compact in new[] { false, true })
        {
            var result = await manager.ExplainToolAuthorizationAsync(
                caller,
                execution.Files,
                Args(256, compact),
                CancellationToken.None
            );
            Assert.Equal(256, result["probes"]!.AsArray().Count);
        }
        foreach (var count in new[] { 0, 257 })
        {
            var response = await Call(execution.Tools, "explain_tool_authorization", Args(count, true));
            Assert.Contains("1 to 256 probe objects", response.FailureMessage()!);
        }
    }

    [Fact]
    public async Task Explain_covers_256_distinct_and_repeated_sessions()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await SeedColdSessions(temp.Path, 256);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);

        var distinct = new JsonArray();
        var repeated = new JsonArray();
        for (var index = 0; index < 256; index++)
        {
            distinct.Add((JsonNode?)Probe($"cold{index:000}", "node:master/exec", ExecArgs));
            repeated.Add((JsonNode?)Probe("foreign", "node:master/exec", ExecArgs));
        }
        var rows = (
            await Explain(execution.Tools, new JsonObject { ["probes"] = distinct, ["compact"] = true })
        )["probes"]!.AsArray();
        for (var index = 0; index < 256; index++)
        {
            Assert.Equal(index, rows[index]!["index"]!.GetValue<int>());
            Assert.Equal($"cold{index:000}", rows[index]!["sessionId"]!.GetValue<string>());
            // Odd Sessions belong to beta, whose exec the policy denies.
            Assert.Equal(
                index % 2 == 0 ? "allow" : "deny",
                rows[index]!["decision"]!.GetValue<string>()
            );
        }
        rows = (
            await Explain(execution.Tools, new JsonObject { ["probes"] = repeated, ["compact"] = true })
        )["probes"]!.AsArray();
        Assert.All(
            rows,
            row =>
            {
                Assert.Equal("deny", row!["decision"]!.GetValue<string>());
                Assert.Equal("beta-no-exec", row["rules"]![0]!["rule"]!.GetValue<string>());
            }
        );
    }

    [Fact]
    public async Task Explain_compact_active_rows_report_decision_and_deciding_layers()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);

        var args = new JsonObject
        {
            ["compact"] = true,
            ["probes"] = Probes(
                Probe("outside", "node:master/exec", ExecArgs, "BAD exec foreign"),
                Probe("foreign", "node:master/read", """{"filePath":"notes.txt"}"""),
                Probe("foreign", "builtin:wait", "{}", "own wait"),
                Probe("self", "node:master/exec", ExecArgs),
                Probe("missing", "builtin:wait", "{}", "gone"),
                Probe("outside", "builtin:no_such_tool", "{}")
            ),
        };
        var result = await Explain(execution.Tools, args);
        Assert.Equal("active", result["policy"]!.GetValue<string>());
        Assert.Null(result["ruleDiff"]);
        var rows = result["probes"]!.AsArray();
        Assert.Equal(6, rows.Count);

        Assert.True(
            JsonNode.DeepEquals(
                Obj(
                    """
                    {"index":0,"label":"BAD exec foreign","sessionId":"foreign","toolId":"node:master/exec",
                     "decision":"deny","rules":[{"layer":"global","rule":"beta-no-exec","decision":"deny"}]}
                    """
                ),
                rows[0]
            ),
            rows[0]!.ToJsonString()
        );
        Assert.True(
            JsonNode.DeepEquals(
                Obj(
                    """
                    {"index":1,"sessionId":"foreign","toolId":"node:master/read",
                     "decision":"allow","rules":[{"layer":"global","rule":"beta-read","decision":"allow"}]}
                    """
                ),
                rows[1]
            ),
            rows[1]!.ToJsonString()
        );
        // A self-scoped call is not assessed: nothing to name.
        Assert.True(
            JsonNode.DeepEquals(
                Obj(
                    """
                    {"index":2,"label":"own wait","sessionId":"foreign","toolId":"builtin:wait",
                     "decision":"allow","self":true,"rules":[]}
                    """
                ),
                rows[2]
            ),
            rows[2]!.ToJsonString()
        );
        // The migrated Agent's generated layer denies where the global default allows.
        Assert.Equal("deny", rows[3]!["decision"]!.GetValue<string>());
        var layers = rows[3]!["rules"]!.AsArray();
        var layer = Assert.Single(layers);
        Assert.Equal("agent:alpha", layer!["layer"]!.GetValue<string>());
        Assert.Equal("isolation-master-exec", layer["rule"]!.GetValue<string>());

        Assert.Equal(4, rows[4]!["index"]!.GetValue<int>());
        Assert.Equal("gone", rows[4]!["label"]!.GetValue<string>());
        Assert.Equal("missing", rows[4]!["sessionId"]!.GetValue<string>());
        Assert.Contains("not found", rows[4]!["error"]!.GetValue<string>());
        Assert.Null(rows[4]!["decision"]);
        Assert.Equal(5, rows[5]!["index"]!.GetValue<int>());
        Assert.Equal("foreign", rows[5]!["sessionId"]!.GetValue<string>());
        Assert.Contains("Unknown tool", rows[5]!["error"]!.GetValue<string>());
        Assert.Null(rows[5]!["toolId"]);
        Assert.All(rows, row => Assert.Null(row!["facts"]));
    }

    [Theory]
    [InlineData("defaultAction: deny", "deny")]
    [InlineData("defaultAction: ask", "ask")]
    public async Task Explain_compact_names_a_default_layer_that_does_not_allow(
        string defaultAction,
        string decision
    )
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            $$"""
            version: 1
            {{defaultAction}}
            rules:
            - {id: explain, tool: {source: builtin, name: explain_tool_authorization}, action: allow}
            - {id: read-policy, tool: {source: node, name: read}, action: allow}
            """
        );
        var result = await Explain(
            execution.Tools,
            new JsonObject
            {
                ["compact"] = true,
                ["probes"] = Probes(Probe("self", "builtin:list_agents", "{}")),
            }
        );
        var row = result["probes"]![0]!;
        Assert.Equal(decision, row["decision"]!.GetValue<string>());
        var layer = Assert.Single(row["rules"]!.AsArray());
        Assert.Equal("global", layer!["layer"]!.GetValue<string>());
        Assert.Null(layer["rule"]);
        Assert.Equal(decision, layer["decision"]!.GetValue<string>());
    }

    [Fact]
    public async Task Explain_compact_compare_rows_carry_both_policies_and_changed()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "workspace", "agents", "alpha", "candidate.yaml"),
            """
            version: 1
            defaultAction: deny
            rules:
            - {"id":"beta-no-exec","agent":"beta","tool":{"source":"node","name":"exec"},"action":"deny"}
            - {"id":"alpha-no-list","agent":"alpha","tool":{"source":"builtin","name":"list_agents"},"action":"deny"}
            """
        );
        var result = await Explain(
            execution.Tools,
            new JsonObject
            {
                ["compact"] = true,
                ["compare"] = true,
                ["policyFilePath"] = "candidate.yaml",
                ["probes"] = Probes(
                    Probe("self", "builtin:list_agents", "{}", "own list"),
                    Probe("outside", "node:master/exec", ExecArgs),
                    Probe("missing", "builtin:list_agents", "{}")
                ),
            }
        );
        Assert.Equal("compare", result["policy"]!.GetValue<string>());
        Assert.NotNull(result["ruleDiff"]);
        var rows = result["probes"]!.AsArray();
        Assert.True(
            JsonNode.DeepEquals(
                Obj(
                    """
                    {"index":0,"label":"own list","sessionId":"opaque","toolId":"builtin:list_agents",
                     "active":{"decision":"allow","rules":[]},
                     "candidate":{"decision":"deny","rules":[{"layer":"global","rule":"alpha-no-list","decision":"deny"}]},
                     "changed":true}
                    """
                ),
                rows[0]
            ),
            rows[0]!.ToJsonString()
        );
        Assert.True(
            JsonNode.DeepEquals(
                Obj(
                    """
                    {"index":1,"sessionId":"foreign","toolId":"node:master/exec",
                     "active":{"decision":"deny","rules":[{"layer":"global","rule":"beta-no-exec","decision":"deny"}]},
                     "candidate":{"decision":"deny","rules":[{"layer":"global","rule":"beta-no-exec","decision":"deny"}]},
                     "changed":false}
                    """
                ),
                rows[1]
            ),
            rows[1]!.ToJsonString()
        );
        Assert.Contains("not found", rows[2]!["error"]!.GetValue<string>());
        Assert.Null(rows[2]!["changed"]);
        Assert.Null(rows[2]!["active"]);

        // Candidate only: the same flat row as an active-only call.
        result = await Explain(
            execution.Tools,
            new JsonObject
            {
                ["compact"] = true,
                ["policyFilePath"] = "candidate.yaml",
                ["probes"] = Probes(Probe("self", "builtin:list_agents", "{}")),
            }
        );
        Assert.Equal("candidate", result["policy"]!.GetValue<string>());
        Assert.Equal("deny", result["probes"]![0]!["decision"]!.GetValue<string>());
        Assert.Null(result["probes"]![0]!["candidate"]);
    }

    [Fact]
    public async Task Explain_echoes_labels_in_both_modes_and_keeps_default_output_without_them()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);

        var labelled = Probes(
            Probe("outside", "node:master/exec", ExecArgs, "BAD exec foreign"),
            Probe("missing", "builtin:wait", "{}", "exec own Node"),
            Probe("self", "builtin:wait", "{}")
        );
        foreach (var compact in new[] { false, true })
        {
            var rows = (
                await Explain(
                    execution.Tools,
                    new JsonObject
                    {
                        ["probes"] = labelled.DeepClone(),
                        ["compact"] = compact,
                    }
                )
            )["probes"]!.AsArray();
            Assert.Equal("BAD exec foreign", rows[0]!["label"]!.GetValue<string>());
            Assert.Equal("exec own Node", rows[1]!["label"]!.GetValue<string>());
            Assert.NotNull(rows[1]!["error"]);
            Assert.False(rows[2]!.AsObject().ContainsKey("label"));
        }

        // Without labels or compact, the earlier fields come first, in their order, and the
        // operation plan and per-check decisions follow them.
        var plain = await Explain(
            execution.Tools,
            new JsonObject { ["probes"] = Probes(Probe("outside", "node:master/exec", ExecArgs)) }
        );
        var row = plain["probes"]![0]!.AsObject();
        Assert.Equal(
            ["sessionId", "tool", "active", "invocation", "capability", "arguments", "branch"],
            row.Select(property => property.Key).Take(7).ToArray()
        );
        Assert.Equal(
            ["decision", "allowed", "deniedBy", "layers", "facts", "obligations"],
            row["active"]!.AsObject().Select(property => property.Key).ToArray()
        );

        // A malformed label makes that probe an error row, not a failed call.
        foreach (var bad in new JsonNode?[] { 7, "", new string('x', 201) })
        {
            var probe = Probe("self", "builtin:wait", "{}");
            probe["label"] = bad;
            var rows = (
                await Explain(
                    execution.Tools,
                    new JsonObject { ["probes"] = Probes(probe, Probe("self", "builtin:wait", "{}")) }
                )
            )["probes"]!.AsArray();
            Assert.Contains("label must be", rows[0]!["error"]!.GetValue<string>());
            Assert.Null(rows[0]!["label"]);
            Assert.NotNull(rows[1]!["active"]);
        }
        var maximal = Probe("self", "builtin:wait", "{}", new string('x', 200));
        Assert.Null(
            (
                await Explain(
                    execution.Tools,
                    new JsonObject { ["probes"] = Probes((JsonObject)maximal.DeepClone()) }
                )
            )["probes"]![0]!["error"]
        );
        Assert.Contains(
            "compact must be a boolean",
            (
                await Call(
                    execution.Tools,
                    "explain_tool_authorization",
                    new JsonObject { ["probes"] = Probes((JsonObject)maximal.DeepClone()), ["compact"] = "yes" }
                )
            ).FailureMessage()!
        );
    }

    [Fact]
    public async Task Explain_compact_reports_secret_decisions()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            rules:
            - id: no-secret-exec
              tool: {source: node, name: exec}
              secrets: {anyOf: [token]}
              action: deny
              reason: secret refused
            """
        );
        var result = await Explain(
            execution.Tools,
            new JsonObject
            {
                ["compact"] = true,
                ["probes"] = Probes(
                    Probe(
                        "self",
                        "node:master/exec",
                        """{"command":"true","secretEnv":{"TOKEN":"token"}}"""
                    ),
                    Probe("self", "node:master/exec", ExecArgs)
                ),
            }
        );
        var secretRow = result["probes"]![0]!;
        Assert.Equal("deny", secretRow["decision"]!.GetValue<string>());
        var layer = Assert.Single(secretRow["rules"]!.AsArray());
        Assert.Equal("deny", layer!["secrets"]!["decision"]!.GetValue<string>());
        Assert.Equal("no-secret-exec", layer["secrets"]!["rule"]!.GetValue<string>());
        Assert.Equal("allow", result["probes"]![1]!["decision"]!.GetValue<string>());
    }

    [Fact]
    public async Task Explain_through_ctl_accepts_compact_and_labels()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);

        var response = await Call(
            execution.Tools,
            "ctl",
            new JsonObject
            {
                ["command"] = "config explain-auth --compact --probes @probes",
                ["values"] = new JsonObject
                {
                    ["probes"] = Probes(
                        Probe("outside", "node:master/exec", ExecArgs, "BAD exec foreign")
                    ),
                },
            }
        );
        Assert.Null(response["error"]);
        var row = JsonNode
            .Parse(response["output"]!.GetValue<string>())!["probes"]![0]!;
        Assert.Equal("BAD exec foreign", row["label"]!.GetValue<string>());
        Assert.Equal("deny", row["decision"]!.GetValue<string>());
        Assert.Equal("beta-no-exec", row["rules"]![0]!["rule"]!.GetValue<string>());
        Assert.Null(row["facts"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Explain_returns_structured_results_to_toolscript(bool compact)
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);

        var script = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = "return call_tool('builtin:explain_tool_authorization', args)",
                ["args"] = new JsonObject
                {
                    ["compact"] = compact,
                    ["probes"] = Probes(
                        Probe("outside", "node:master/exec", ExecArgs, "BAD exec foreign")
                    ),
                },
            }
        );
        Assert.True(SessionWait.Text(script["status"]) == "completed", script.ToJsonString());
        var result = script["result"]!.AsObject();
        Assert.Null(result["output"]);
        Assert.Equal("active", result["policy"]!.GetValue<string>());
        var row = result["probes"]![0]!;
        Assert.Equal("BAD exec foreign", row["label"]!.GetValue<string>());
        if (compact)
            Assert.Equal("deny", row["decision"]!.GetValue<string>());
        else
            Assert.Equal("deny", row["active"]!["decision"]!.GetValue<string>());
    }
}
