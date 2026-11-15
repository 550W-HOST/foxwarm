using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Decision equality for approval staging (operation authorization phase 2): real calls under
// policies whose outcomes for those calls involve no ask decide exactly as at the base revision.
// The fixture holds the outcomes recorded at the base; FOXWARM_STAGING_CORPUS_OUT writes the
// outcomes of the current build instead of comparing them.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static readonly (string Name, string Yaml)[] StagingPolicies =
    [
        ("empty", "version: 1\nrules: []\n"),
        (
            "deny-default-allow-files",
            "version: 1\ndefaultAction: deny\nrules:\n- {id: files, tool: {source: node, name: [read, write, edit]}, action: allow}\n- {id: timers, tool: {source: builtin, name: create_timer}, action: allow}\n"
        ),
        (
            "deny-read",
            "version: 1\nrules:\n- {id: no-read, tool: {source: node, name: read}, action: deny}\n"
        ),
        (
            "deny-view",
            "version: 1\nrules:\n- {id: no-view, tool: {source: builtin, name: view_session}, action: deny}\n"
        ),
        (
            "deny-create-session",
            "version: 1\nrules:\n- {id: no-sessions, tool: {source: builtin, name: create_session}, action: deny}\n"
        ),
        (
            "deny-write-path",
            "version: 1\nrules:\n- {id: no-out, tool: {source: node, name: write}, args: {filePath: {equals: out.txt}}, action: deny}\n"
        ),
        (
            "ask-unrelated",
            "version: 1\nrules:\n- {id: confirm-exec, tool: {source: node, name: exec}, action: ask}\n"
        ),
        (
            "ask-unrelated-deny-read",
            "version: 1\nrules:\n- {id: confirm-exec, tool: {source: node, name: exec}, action: ask}\n- {id: no-read, tool: {source: node, name: read}, action: deny}\n"
        ),
        (
            "ask-unrelated-deny-view",
            "version: 1\nrules:\n- {id: confirm-exec, tool: {source: node, name: exec}, action: ask}\n- {id: no-view, tool: {source: builtin, name: view_session}, action: deny}\n"
        ),
        (
            "ask-unrelated-deny-create-session",
            "version: 1\nrules:\n- {id: confirm-exec, tool: {source: node, name: exec}, action: ask}\n- {id: no-sessions, tool: {source: builtin, name: create_session}, action: deny}\n"
        ),
        (
            "ask-unrelated-deny-default",
            "version: 1\ndefaultAction: deny\nrules:\n- {id: confirm-exec, tool: {source: node, name: exec}, action: ask}\n- {id: files, tool: {source: node, name: [read, write]}, action: allow}\n- {id: explain, tool: {source: builtin, name: [explain_tool_authorization, run_script]}, action: allow}\n"
        ),
    ];

    private static readonly (string Name, string Tool, string Args)[] StagingCalls =
    [
        ("write", "write", """{"filePath":"out.txt","content":"x"}"""),
        ("write-other", "write", """{"filePath":"kept.txt","content":"x"}"""),
        ("read", "read", """{"filePath":"seed.txt"}"""),
        ("edit", "edit", """{"filePath":"seed.txt","oldText":"seed","newText":"seed2"}"""),
        (
            "explain-self",
            "explain_tool_authorization",
            """{"probes":[{"sessionId":"outside","toolId":"builtin:task","args":{"action":"list"}}]}"""
        ),
        (
            "explain-other",
            "explain_tool_authorization",
            """{"probes":[{"sessionId":"opaque","toolId":"builtin:task","args":{"action":"list"}}]}"""
        ),
        (
            "explain-candidate",
            "explain_tool_authorization",
            """{"policyFilePath":"seed.txt","probes":[{"sessionId":"outside","toolId":"builtin:task","args":{"action":"list"}}]}"""
        ),
        ("script-file", "run_script", """{"filePath":"job.py"}"""),
        ("timer", "create_timer", """{"afterSeconds":3600,"message":"later"}"""),
        (
            "timer-new-session",
            "create_timer",
            """{"afterSeconds":3600,"message":"later","newSession":true,"agentName":"beta"}"""
        ),
        ("view", "view_session", """{"sessionId":"opaque"}"""),
        ("task-list", "task", """{"action":"list"}"""),
        (
            "copy",
            "copy_between_nodes",
            """{"sourceNode":"master","sourcePath":"seed.txt","targetNode":"master","targetPath":"copied.txt"}"""
        ),
    ];

    private static string StagingOutcome(JsonObject response, string root)
    {
        if (response["error"] is not JsonObject error)
            return "ok";
        var text =
            SessionWait.Text(error["type"])
            + ": "
            + (SessionWait.Text(error["message"]) ?? "").Replace(root, "<root>", StringComparison.Ordinal);
        return Regex.Replace(text, "(ap|tmr|tsr)[-_][A-Za-z0-9]+", "$1-<id>");
    }

    [Fact]
    public async Task Calls_without_asks_decide_as_at_the_base_revision()
    {
        var outcomes = new JsonObject();
        foreach (var (policyName, yaml) in StagingPolicies)
        {
            using var temp = new TempDirectory();
            await Seed(temp.Path);
            await using var manager = Manager(temp.Path);
            await manager.LoadAsync();
            var caller = await manager.RequiredAsync("foreign");
            var execution = TimerExecutor(manager, caller, temp.Path);
            await using var mcp = execution.Mcp;
            var workspace = Path.Combine(temp.Path, "workspace", "agents", caller.Agent);
            await File.WriteAllTextAsync(Path.Combine(workspace, "seed.txt"), "seed");
            await File.WriteAllTextAsync(Path.Combine(workspace, "job.py"), "return 'ran'");
            await Policy(manager, yaml);
            var row = new JsonObject();
            foreach (var (callName, tool, args) in StagingCalls)
            {
                var call = Call(execution.Tools, tool, Obj(args));
                string outcome;
                try
                {
                    outcome = StagingOutcome(await call.WaitAsync(TimeSpan.FromSeconds(20)), temp.Path);
                }
                catch (TimeoutException)
                {
                    // A call that waits for approval did not decide as without an ask.
                    outcome = "waiting";
                    foreach (
                        var pending in caller.Entry.WithState(state =>
                            SessionApprovals
                                .Pending(state.Meta)
                                .Select(record => SessionWait.Text(record["id"])!)
                                .ToArray()
                        )
                    )
                        await manager.DecideToolApprovalAsync(
                            caller,
                            pending,
                            false,
                            null,
                            new JsonObject { ["kind"] = "administrator" }
                        );
                    await call;
                }
                row[callName] = outcome;
            }
            row["approvals"] = ApprovalCount(caller);
            outcomes[policyName] = row;
        }
        var output = Environment.GetEnvironmentVariable("FOXWARM_STAGING_CORPUS_OUT");
        if (!string.IsNullOrEmpty(output))
        {
            await File.WriteAllTextAsync(
                output,
                outcomes.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n"
            );
            return;
        }
        var fixture = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "approval-staging-equality.json")
                )
            )!
            .AsObject();
        foreach (var (policyName, _) in StagingPolicies)
        foreach (var (callName, _, _) in StagingCalls)
            Assert.True(
                SessionWait.Text(fixture["outcomes"]![policyName]![callName])
                    == SessionWait.Text(outcomes[policyName]![callName]),
                $"{policyName} / {callName}: base {fixture["outcomes"]![policyName]![callName]}, now {outcomes[policyName]![callName]}"
            );
        foreach (var (policyName, _) in StagingPolicies)
            Assert.Equal(0, outcomes[policyName]!["approvals"]!.GetValue<int>());
    }
}
