using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Tools;

using static Foxwarm.Tests.ApprovalStagingSupport;

namespace Foxwarm.Tests;

// A second decision-equality corpus for approval staging, written independently of the first:
// 14 policy configurations (including Agent-local layers and an unavailable policy) by 28 calls,
// recorded at the base revision. FOXWARM_STAGING_REVIEW_CORPUS_OUT writes the outcomes of the
// current build instead of comparing them.
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Calls_of_the_independent_corpus_decide_as_at_the_base_revision()
    {
        var policies = new (string Name, string Rules, string Default, bool Local)[] {
            ("compat", "[]", "allow", false),
            ("deny", "[]", "deny", false),
            ("read-deny", "[{id: no-read, tool: {source: node, name: read}, action: deny}]", "allow", false),
            ("view-deny", "[{id: no-view, tool: {source: builtin, name: view_session}, action: deny}]", "allow", false),
            ("unused-ask", "[{id: unused, tool: {source: node, name: unused_node_tool}, action: ask}]", "allow", false),
            ("disabled-ask", "[{id: disabled, enabled: false, action: ask}]", "allow", false),
            ("shadowed-ask", "[{id: first, action: allow}, {id: shadowed, action: ask}]", "deny", false),
            ("staged-read-deny", "[{id: unused, tool: {source: node, name: unused_node_tool}, action: ask}, {id: no-read, tool: {source: node, name: read}, action: deny}]", "allow", false),
            ("staged-view-deny", "[{id: unused, tool: {source: node, name: unused_node_tool}, action: ask}, {id: no-view, tool: {source: builtin, name: view_session}, action: deny}]", "allow", false),
            ("staged-deny", "[{id: unused, tool: {source: node, name: unused_node_tool}, action: ask}]", "deny", false),
            ("local-pass", "[]", "allow", true),
            ("local-deny", "[{id: no-read, tool: {source: node, name: read}, action: deny}]", "allow", true),
            ("local-staged", "[{id: unused, tool: {source: node, name: unused_node_tool}, action: ask}, {id: no-read, tool: {source: node, name: read}, action: deny}]", "allow", true),
            ("policy-unavailable", "[]", "allow", false),
        };
        var calls = new (string Name, string Tool, string Args)[] {
            ("write", "write", "{\"filePath\":\"write.txt\",\"content\":\"test\"}"),
            ("read", "read", "{\"filePath\":\"seed.txt\"}"),
            ("read-no-path", "read", "{}"),
            ("read-nonstring", "read", "{\"filePath\":7}"),
            ("read-unknown-var", "read", "{\"filePath\":\"$unknown/seed.txt\"}"),
            ("read-null-byte", "read", "{\"filePath\":\"x\\u0000y\"}"),
            ("edit", "edit", "{\"filePath\":\"seed.txt\",\"oldText\":\"seed\",\"newText\":\"seed2\"}"),
            ("edit-invalid-patch", "edit", "{\"apply_patch\":\"bad\"}"),
            ("script-trim", "run_script", "{\"filePath\":\" job.py \"}"),
            ("script-inline", "run_script", "{\"code\":\"return 3\"}"),
            ("script-invalid", "run_script", "{\"filePath\":7}"),
            ("explain-other", "explain_tool_authorization", "{\"probes\":[{\"sessionId\":\"self\",\"toolId\":\"builtin:task\",\"args\":{\"action\":\"list\"}}]}"),
            ("explain-absent", "explain_tool_authorization", "{\"probes\":[{\"sessionId\":\"absent\",\"toolId\":\"builtin:task\",\"args\":{\"action\":\"list\"}}]}"),
            ("explain-candidate", "explain_tool_authorization", "{\"policyFilePath\":\"candidate.yaml\",\"probes\":[{\"sessionId\":\"outside\",\"toolId\":\"builtin:task\",\"args\":{\"action\":\"list\"}}]}"),
            ("timer-new", "create_timer", "{\"afterSeconds\":3600,\"message\":\"test\",\"newSession\":true,\"agentName\":\"alpha\"}"),
            ("timer-invalid", "create_timer", "{\"afterSeconds\":-1,\"message\":\"test\"}"),
            ("view-alias", "view_session", "{\"sessionId\":\"self\"}"),
            ("view-absent", "view_session", "{\"sessionId\":\"absent\"}"),
            ("session-default", "session", "{}"),
            ("session-array", "session", "{\"action\":[\"list\"]}"),
            ("session-spelling", "session", "{\"action\":\" Status \"}"),
            ("task-list", "task", "{\"action\":\"list\"}"),
            ("task-invalid", "task", "{\"action\":\"get\",\"taskId\":\"missing\"}"),
            ("copy", "copy_between_nodes", "{\"sourceNode\":\"master\",\"sourcePath\":\"seed.txt\",\"targetNode\":\"master\",\"targetPath\":\"copy.txt\"}"),
            ("copy-invalid", "copy_between_nodes", "{\"sourceNode\":\"master\",\"targetNode\":\"master\"}"),
            ("config-invalid", "set_config", "{\"target\":\"models\"}"),
            ("config-path", "set_config", "{\"target\":\"models\",\"filePath\":\"candidate.yaml\"}"),
            ("compaction-file", "submit_compact_plan", "{\"argsFilePath\":\"plan.json\"}"),
        };
        var result = new JsonObject();
        foreach (var p in policies)
        {
            using var temp = new TempDirectory();
            await Seed(temp.Path);
            await using var manager = Manager(temp.Path);
            await manager.LoadAsync();
            var caller = await manager.RequiredAsync("foreign");
            var execution = TimerExecutor(manager, caller, temp.Path);
            await using var mcp = execution.Mcp;
            var work = Path.Combine(temp.Path, "workspace", "agents", caller.Agent);
            await File.WriteAllTextAsync(Path.Combine(work, "seed.txt"), "seed");
            await File.WriteAllTextAsync(Path.Combine(work, "job.py"), "return 7");
            await File.WriteAllTextAsync(Path.Combine(work, "candidate.yaml"), "version: 1\nrules: []\n");
            await File.WriteAllTextAsync(Path.Combine(work, "plan.json"), "{}");
            await Policy(manager, "version: 1\ndefaultAction: " + p.Default + "\nrules: " + (p.Local ? "[]" : p.Rules) + "\n");
            if (p.Local)
            {
                // YAML parser yields the same v1 rule array accepted by the Agent setter.
                var parsed = ToolAuthorizationYaml.Parse(Encoding.UTF8.GetBytes("version: 1\nrules: " + p.Rules));
                await manager.SetAgentRulesAsync("beta", (JsonArray)parsed.Value["rules"]!.DeepClone());
            }
            if (p.Name == "policy-unavailable")
            {
                await File.WriteAllTextAsync(manager.Authorization.PolicyPath, "not a policy");
                manager.Authorization.Invalidate();
            }
            var row = new JsonObject();
            foreach (var c in calls)
            {
                var response = await Call(execution.Tools, c.Tool, Obj(c.Args)).WaitAsync(TimeSpan.FromSeconds(15));
                var error = response["error"];
                var outcome = error is null ? "ok" : error.ToJsonString().Replace(temp.Path, "<root>", StringComparison.Ordinal);
                row[c.Name] = Regex.Replace(outcome, "(ap|tmr|tsr)[-_][A-Za-z0-9]+", "$1-<id>");
            }
            row["approvals"] = caller.Entry.WithState(state => SessionApprovals.Records(state.Meta).Count());
            result[p.Name] = row;
        }
        var output = Environment.GetEnvironmentVariable("FOXWARM_STAGING_REVIEW_CORPUS_OUT");
        if (!string.IsNullOrEmpty(output))
        {
            await File.WriteAllTextAsync(output, result.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            return;
        }
        var expected = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "approval-staging-equality-review.json")
                )
            )!
            .AsObject();
        // Scheduled changes since the base revision (operation authorization phase 3): an
        // inline script is self-scoped, so a deny of its invocation no longer stops it.
        var scheduled = new Dictionary<string, string>
        {
            ["deny / script-inline"] = "ok",
            ["staged-deny / script-inline"] = "ok",
        };
        foreach (var p in policies)
            foreach (var (call, recorded) in expected[p.Name]!.AsObject())
            {
                var outcome = scheduled.TryGetValue($"{p.Name} / {call}", out var now)
                    ? JsonValue.Create(now)
                    : recorded;
                Assert.True(
                    JsonNode.DeepEquals(outcome, result[p.Name]![call]),
                    $"{p.Name} / {call}: expected {outcome?.ToJsonString()}, got {result[p.Name]![call]?.ToJsonString()}"
                );
            }
    }

    // With the policy unavailable, calls whose arguments or paths are invalid report those
    // errors first, as before staging.
    [Theory]
    [InlineData("read", """{"filePath":"$unknown/seed.txt"}""", "invalid_path", "Unknown Agent path variable: $unknown")]
    [InlineData("read", "{\"filePath\":\"x\\u0000y\"}", "invalid_path", "Invalid path.")]
    [InlineData("edit", """{"apply_patch":"bad"}""", "tool_error", "Invalid apply_patch input:")]
    public async Task Invalid_calls_report_their_own_error_before_an_unavailable_policy(
        string tool,
        string args,
        string type,
        string message
    )
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = TimerExecutor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await File.WriteAllTextAsync(manager.Authorization.PolicyPath, "not a policy");
        manager.Authorization.Invalidate();
        var response = await Call(execution.Tools, tool, Obj(args)).WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(type, Error(response));
        Assert.StartsWith(message, SessionWait.Text(response["error"]!["message"]));
        Assert.Empty(Records(caller));
    }
}
