using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private const string ExplainPolicy = """
        version: 1
        defaultAction: allow
        rules:
          - id: beta-no-exec
            agent: beta
            tool: {source: node, name: exec}
            action: deny
            reason: no exec for beta
          - id: beta-read
            agent: beta
            tool: {source: node, name: read}
            action: allow
          - id: obsolete
            agent: nobody
            action: deny
        """;

    private static async Task<JsonObject> Explain(SessionToolExecutor tools, JsonObject args)
    {
        var response = await Call(tools, "explain_tool_authorization", args);
        Assert.Null(response["error"]);
        return JsonNode.Parse(response["output"]!.GetValue<string>())!.AsObject();
    }

    [Fact]
    public async Task Explain_reports_shared_layer_decisions_facts_isolation_and_probe_errors()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);
        Assert.DoesNotContain(
            manager.ModelDefinitions(caller),
            node => node?["name"]?.GetValue<string>() == "explain_tool_authorization"
        );

        var result = await Explain(
            execution.Tools,
            Obj(
                """
                {"probes":[
                  {"sessionId":"outside","toolId":"node:master/exec","args":{"command":"true"}},
                  {"sessionId":"foreign","source":"node","name":"read","args":{"filePath":"notes.txt"}},
                  {"sessionId":"self","toolId":"node:master/exec","args":{"command":"true"}},
                  {"sessionId":"missing","toolId":"builtin:wait","args":{}}
                ]}
                """
            )
        );
        Assert.Equal("active", result["policy"]!.GetValue<string>());
        var probes = result["probes"]!.AsArray();

        var exec = probes[0]!["active"]!;
        Assert.Equal("foreign", probes[0]!["sessionId"]!.GetValue<string>());
        Assert.False(exec["allowed"]!.GetValue<bool>());
        Assert.Equal("policy", exec["deniedBy"]!.GetValue<string>());
        var rule = exec["layers"]![0]!["rule"]!;
        Assert.Equal("global", exec["layers"]![0]!["layer"]!.GetValue<string>());
        Assert.Equal(1, rule["index"]!.GetValue<int>());
        Assert.Equal("beta-no-exec", rule["id"]!.GetValue<string>());
        Assert.Equal("no exec for beta", rule["reason"]!.GetValue<string>());
        Assert.Equal("beta", exec["facts"]!["agent"]!.GetValue<string>());
        Assert.Equal("master", exec["facts"]!["currentNode"]!.GetValue<string>());
        Assert.False(exec["isolation"]!["isolated"]!.GetValue<bool>());

        var read = probes[1]!["active"]!;
        Assert.True(read["allowed"]!.GetValue<bool>());
        Assert.Equal("beta-read", read["layers"]![0]!["rule"]!["id"]!.GetValue<string>());
        var path = read["facts"]!["paths"]![0]!;
        Assert.Equal("notes.txt", path["raw"]!.GetValue<string>());
        Assert.Equal(
            AuthorizationPaths.CanonicalPotential(
                Path.Combine(temp.Path, "workspace", "agents", "beta", "notes.txt")
            ),
            path["resolved"]!.GetValue<string>()
        );

        // Generic default allow passes; the isolated Agent's legacy check still denies master exec.
        var isolated = probes[2]!["active"]!;
        Assert.Equal("opaque", probes[2]!["sessionId"]!.GetValue<string>());
        Assert.Null(isolated["layers"]![0]!["rule"]);
        Assert.Equal("allow", isolated["layers"]![0]!["default"]!.GetValue<string>());
        Assert.True(isolated["isolation"]!["isolated"]!.GetValue<bool>());
        Assert.False(isolated["isolation"]!["allowed"]!.GetValue<bool>());
        Assert.Equal("isolation", isolated["deniedBy"]!.GetValue<string>());
        Assert.False(isolated["allowed"]!.GetValue<bool>());

        Assert.Contains("not found", probes[3]!["error"]!.GetValue<string>());
        Assert.Null(probes[3]!["active"]);
    }

    [Fact]
    public async Task Explain_compare_evaluates_candidate_per_probe_and_diffs_rule_ids()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, ExplainPolicy);
        var target = Path.Combine(temp.Path, "data", "state", "tool-authorization.yaml");
        var installed = await File.ReadAllBytesAsync(target);
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "workspace", "agents", "alpha", "candidate.yaml"),
            """
            version: 1
            defaultAction: deny
            rules:
            - {"id":"beta-read","agent":"beta","tool":{"source":"node","name":"read"},"action":"allow","reason":"now explained"}
            - {"id":"beta-no-exec","agent":"beta","tool":{"source":"node","name":"exec"},"action":"deny","reason":"no exec for beta"}
            - {"id":"alpha-no-wait","agent":"alpha","tool":{"source":"builtin","name":"wait"},"action":"deny"}
            - {"id":"alpha-rest","agent":"alpha","action":"allow"}
            """
        );
        var result = await Explain(
            execution.Tools,
            Obj(
                """
                {"policyFilePath":"candidate.yaml","compare":true,"probes":[
                  {"sessionId":"opaque","toolId":"builtin:wait","args":{}},
                  {"sessionId":"foreign","toolId":"node:master/exec","args":{"command":"true"}}
                ]}
                """
            )
        );
        Assert.Equal("compare", result["policy"]!.GetValue<string>());
        var wait = result["probes"]![0]!;
        Assert.True(wait["active"]!["allowed"]!.GetValue<bool>());
        Assert.False(wait["candidate"]!["allowed"]!.GetValue<bool>());
        Assert.Equal(
            "alpha-no-wait",
            wait["candidate"]!["layers"]![0]!["rule"]!["id"]!.GetValue<string>()
        );
        Assert.True(wait["changed"]!.GetValue<bool>());
        var exec = result["probes"]![1]!;
        Assert.False(exec["changed"]!.GetValue<bool>());
        Assert.Equal(2, exec["candidate"]!["layers"]![0]!["rule"]!["index"]!.GetValue<int>());

        var diff = result["ruleDiff"]!;
        Assert.Equal("deny", diff["defaultAction"]!["candidate"]!.GetValue<string>());
        Assert.Equal(
            ["alpha-no-wait", "alpha-rest"],
            diff["added"]!.AsArray().Select(item => item!["id"]!.GetValue<string>())
        );
        Assert.Equal("obsolete", diff["removed"]![0]!["id"]!.GetValue<string>());
        Assert.Single(diff["removed"]!.AsArray());
        // Flow-style layout alone is not a modification; only the added reason is.
        Assert.Equal("beta-read", diff["changed"]![0]!["id"]!.GetValue<string>());
        Assert.Single(diff["changed"]!.AsArray());
        Assert.Single(diff["moved"]!.AsArray());
        Assert.Equal(installed, await File.ReadAllBytesAsync(target));

        var candidateOnly = await Explain(
            execution.Tools,
            Obj(
                """{"policyFilePath":"candidate.yaml","probes":[{"sessionId":"opaque","toolId":"builtin:wait"}]}"""
            )
        );
        Assert.Equal("candidate", candidateOnly["policy"]!.GetValue<string>());
        Assert.Null(candidateOnly["probes"]![0]!["active"]);
        Assert.Null(candidateOnly["ruleDiff"]);

        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "workspace", "agents", "alpha", "candidate.yaml"),
            "version: 1\nrules: null"
        );
        var invalid = await Call(
            execution.Tools,
            "explain_tool_authorization",
            Obj(
                """{"policyFilePath":"candidate.yaml","probes":[{"sessionId":"opaque","toolId":"builtin:wait"}]}"""
            )
        );
        Assert.Contains(
            "Invalid tool-rules candidate",
            invalid["error"]!["message"]!.GetValue<string>()
        );
        Assert.NotNull(
            Error(
                await Call(
                    execution.Tools,
                    "explain_tool_authorization",
                    Obj(
                        """{"compare":true,"probes":[{"sessionId":"opaque","toolId":"builtin:wait"}]}"""
                    )
                )
            )
        );
    }

    [Fact]
    public async Task Explain_requires_its_own_grant_and_read_access_to_active_and_candidate_policies()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        Directory.CreateDirectory(Path.Combine(own, "private"));
        await File.WriteAllTextAsync(Path.Combine(own, "private", "candidate.yaml"), "version: 1");
        await File.WriteAllTextAsync(Path.Combine(own, "candidate.yaml"), "version: 1");
        var probe = """[{"sessionId":"opaque","toolId":"builtin:wait"}]""";

        await Policy(
            manager,
            "version: 1\nrules: [{id: no-explain, agent: alpha, tool: {source: builtin, name: explain_tool_authorization}, action: deny}]"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "explain_tool_authorization",
                    Obj($$"""{"probes":{{probe}}}""")
                )
            )
        );

        await Policy(
            manager,
            "version: 1\nrules: [{id: own-reads, agent: alpha, tool: {source: node, name: read}, path: {anyNotWithin: '${agent.dir}'}, action: deny}]"
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "explain_tool_authorization",
                    Obj($$"""{"probes":{{probe}}}""")
                )
            )
        );

        await Policy(
            manager,
            "version: 1\nrules: [{id: private-reads, agent: alpha, tool: {source: node, name: read}, path: {allWithin: '${agent.dir}/private'}, action: deny}]"
        );
        _ = await Explain(execution.Tools, Obj($$"""{"probes":{{probe}}}"""));
        _ = await Explain(
            execution.Tools,
            Obj($$"""{"policyFilePath":"candidate.yaml","probes":{{probe}}}""")
        );
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await Call(
                    execution.Tools,
                    "explain_tool_authorization",
                    Obj($$"""{"policyFilePath":"private/candidate.yaml","probes":{{probe}}}""")
                )
            )
        );
    }
}
