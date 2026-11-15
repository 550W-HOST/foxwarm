using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Operation authorization phase 1 through real dispatch and explanation: denials name the rule,
// the denied obligation, the capability and the command; explanations add the plan; nothing
// changes what is allowed or denied.
public sealed partial class ToolAuthorizationEffectsTests
{
    private const string OperationPolicy = """
        version: 1
        defaultAction: allow
        rules:
          - id: deny-exec
            tool: {source: node, name: exec}
            action: deny
          - id: no-script-read
            tool: {source: node, name: read}
            args: {filePath: job.py}
            action: deny
          - id: no-new-beta
            tool: {source: builtin, name: create_session}
            args: {agentName: beta}
            action: deny
        """;

    private static string Message(JsonObject response) =>
        response["error"]!["message"]!.GetValue<string>();

    [Fact]
    public async Task Denials_name_the_rule_obligation_capability_and_command_without_running_the_effect()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, OperationPolicy);
        var own = Path.Combine(temp.Path, "workspace", "agents", "alpha");
        Directory.CreateDirectory(Path.Combine(own, "open"));
        await File.WriteAllTextAsync(Path.Combine(own, "job.py"), "return 1");
        await File.WriteAllTextAsync(Path.Combine(own, "open", "job.py"), "return 2");

        // The primary request, direct and through ctl.
        var direct = await Call(execution.Tools, "exec", Obj("""{"command":"touch direct-exec"}"""));
        Assert.Equal("tool_authorization_denied", Error(direct));
        Assert.Equal(
            "Tool authorization rule denies node capability `exec`. Rule `deny-exec` (#1) in the global policy denied `node:master/exec`, called as `exec`.",
            Message(direct)
        );
        var command = await Call(
            execution.Tools,
            "ctl",
            CtlTestArgs.Unified(
                new JsonObject
                {
                    ["toolId"] = "node:master/exec",
                    ["args"] = new JsonObject { ["command"] = "touch ctl-exec" },
                }
            )
        );
        Assert.Equal("tool_authorization_denied", Error(command));
        Assert.EndsWith(
            "Rule `deny-exec` (#1) in the global policy denied `node:master/exec`, called as `ctl tool call`.",
            Message(command)
        );
        Assert.False(File.Exists(Path.Combine(own, "direct-exec")));
        Assert.False(File.Exists(Path.Combine(own, "ctl-exec")));

        // A malformed call fails in its handler as before; nothing is attributed to policy.
        var malformed = await Call(execution.Tools, "node", Obj("""{"action":["list"]}"""));
        Assert.NotNull(malformed["error"]);
        Assert.NotEqual("tool_authorization_denied", Error(malformed));
        Assert.DoesNotContain("called as", Message(malformed));

        // A sub-request of an allowed primary: the script source read.
        var script = await Call(execution.Tools, "run_script", Obj("""{"filePath":"job.py"}"""));
        Assert.NotNull(script["error"]);
        Assert.Contains(
            "Rule `no-script-read` (#2) in the global policy denied the read of the script source file on its Node (`node:master/read`) for `builtin:run_script`, called as `run_script`.",
            script.ToJsonString()
                .Replace("\\u0060", "`", StringComparison.Ordinal)
                .Replace("\\u0027", "'", StringComparison.Ordinal)
        );
        // The same call succeeds where the policy allows the read.
        var allowed = await Call(execution.Tools, "run_script", Obj("""{"filePath":"open/job.py"}"""));
        Assert.Null(allowed["error"]);

        // A policy probe: the timer is allowed, its creation target is not.
        var timer = await Call(
            execution.Tools,
            "create_timer",
            Obj("""{"afterSeconds":3600,"message":"later","newSession":true,"agentName":"beta"}""")
        );
        Assert.Equal("tool_authorization_denied", Error(timer));
        Assert.Equal(
            "Tool authorization rules deny creating a Session in Agent 'beta'. Rule `no-new-beta` (#3) in the global policy denied the create_session creation target (`builtin:create_session`) for `builtin:create_timer`, called as `create_timer`.",
            Message(timer)
        );
        Assert.Equal(
            "0",
            (await Call(execution.Tools, "list_timers", new JsonObject()))["timers"]!.AsArray().Count.ToString()
        );
    }

    [Fact]
    public async Task Explain_reports_invocation_arguments_operations_and_obligation_decisions()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, OperationPolicy);

        var result = await Explain(
            execution.Tools,
            Obj(
                """
                {"probes":[
                  {"sessionId":"opaque","command":"tool call node:master/exec --args @a","values":{"a":{"command":"true","cwd":"open"}}},
                  {"sessionId":"opaque","toolId":"builtin:run_script","args":{"filePath":"job.py"}},
                  {"sessionId":"opaque","toolId":"builtin:node","args":{"action":" Select ","nodeId":"master"}},
                  {"sessionId":"opaque","command":"session status"},
                  {"sessionId":"opaque","command":"node frobnicate"},
                  {"sessionId":"opaque","command":"node list","toolId":"builtin:node"},
                  {"sessionId":"opaque","toolId":"builtin:node","args":{"action":["list"]}}
                ]}
                """
            )
        );
        var probes = result["probes"]!.AsArray();

        var exec = probes[0]!;
        Assert.Equal("ctl tool call", exec["invocation"]!.GetValue<string>());
        Assert.Equal("node:master/exec", exec["capability"]!.GetValue<string>());
        Assert.Equal("true", exec["arguments"]!["raw"]!["command"]!.GetValue<string>());
        Assert.Equal("env.exec", exec["operations"]![0]!["op"]!.GetValue<string>());
        Assert.Equal("master", exec["operations"]![0]!["resources"]!["node"]!.GetValue<string>());
        Assert.Equal("deny", exec["active"]!["decision"]!.GetValue<string>());
        var primary = exec["active"]!["obligations"]![0]!;
        Assert.Equal("primary", primary["id"]!.GetValue<string>());
        Assert.Equal("deny", primary["decision"]!.GetValue<string>());
        Assert.Equal("deny-exec", primary["layers"]![0]!["rule"]!["id"]!.GetValue<string>());

        // The primary is allowed; its source-read obligation is denied, as at run time.
        var script = probes[1]!;
        Assert.Equal("ctl tool call", script["invocation"]!.GetValue<string>());
        Assert.Equal("file", script["branch"]!.GetValue<string>());
        Assert.Equal("allow", script["active"]!["decision"]!.GetValue<string>());
        var kinds = script["obligations"]!
            .AsArray()
            .Select(item => (item!["id"]!.GetValue<string>(), item["kind"]!.GetValue<string>()))
            .ToArray();
        Assert.Equal([("primary", "primary"), ("source-read", "subRequest"), ("nested", "nested")], kinds);
        var read = script["active"]!["obligations"]!
            .AsArray()
            .Single(item => item!["id"]!.GetValue<string>() == "source-read")!;
        Assert.Equal("deny", read["decision"]!.GetValue<string>());
        Assert.Equal("no-script-read", read["layers"]![0]!["rule"]!["id"]!.GetValue<string>());
        var nested = script["active"]!["obligations"]!
            .AsArray()
            .Single(item => item!["id"]!.GetValue<string>() == "nested")!;
        Assert.False(nested["evaluated"]!.GetValue<bool>());

        // Raw and normalized arguments side by side; the decision keeps the raw spelling.
        var select = probes[2]!;
        Assert.Equal(" Select ", select["arguments"]!["raw"]!["action"]!.GetValue<string>());
        Assert.Equal("select", select["arguments"]!["normalized"]!["action"]!.GetValue<string>());
        Assert.Equal("select", select["branch"]!.GetValue<string>());

        // A ctl command probe carries its fixed arguments and the resolved Session target.
        var status = probes[3]!;
        Assert.Equal("ctl session status", status["invocation"]!.GetValue<string>());
        Assert.Equal("session.view", status["operations"]![0]!["op"]!.GetValue<string>());
        Assert.Equal(
            "opaque",
            status["operations"]![0]!["resources"]!["targetSession"]!.GetValue<string>()
        );
        Assert.Null(status["incomplete"]);

        Assert.Contains("frobnicate", probes[4]!["error"]!.GetValue<string>());
        Assert.Equal(
            "A probe gives either command (with values) or a tool, not both.",
            probes[5]!["error"]!.GetValue<string>()
        );

        // A malformed call is reported as incomplete; the existing decision is unchanged.
        var malformed = probes[6]!;
        Assert.Null(malformed["branch"]);
        Assert.Contains(
            "action is not a string",
            malformed["incomplete"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        Assert.Equal("allow", malformed["active"]!["decision"]!.GetValue<string>());
        Assert.Empty(malformed["active"]!["obligations"]!.AsArray());

        // Compact rows add the command of a command probe and the first other check that does
        // not allow; the plan is left out.
        var compact = (
            await Explain(
                execution.Tools,
                Obj(
                    """
                    {"compact":true,"probes":[
                      {"sessionId":"opaque","toolId":"builtin:run_script","args":{"filePath":"job.py"}},
                      {"sessionId":"opaque","command":"session status"},
                      {"sessionId":"opaque","toolId":"node:master/exec","args":{"command":"true","cwd":"open"}}
                    ]}
                    """
                )
            )
        )["probes"]!.AsArray();
        Assert.True(
            JsonNode.DeepEquals(
                Obj(
                    """
                    {"index":0,"sessionId":"opaque","toolId":"builtin:run_script","decision":"allow","rules":[],
                     "obligation":{"id":"source-read","decision":"deny","rule":"no-script-read"}}
                    """
                ),
                compact[0]
            ),
            compact[0]!.ToJsonString()
        );
        Assert.Equal("ctl session status", compact[1]!["invocation"]!.GetValue<string>());
        Assert.Null(compact[1]!["obligation"]);
        Assert.Null(compact[2]!["invocation"]);
        Assert.Null(compact[2]!["obligation"]);
        Assert.Null(compact[2]!["operations"]);
    }
}
