using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// Staged approvals (phase 2): one approval covers the call and its other asking requests, with
// the shortest deadline and the approvers every asking rule admits.
public sealed partial class ToolApprovalGateTests
{
    private const string AskScriptSource = """
        version: 1
        rules:
          - id: confirm-script
            action: ask
            tool: {source: builtin, name: run_script}
            approval: {timeoutSeconds: 600, approvers: [ops, dev]}
          - id: confirm-read
            action: ask
            reason: Reads need a decision.
            tool: {source: node, name: read}
            approval: {timeoutSeconds: 300, approvers: [ops, reader]}
        """;

    private static async Task<JsonObject> ScriptFile(ScriptFixture f)
    {
        await File.WriteAllTextAsync(Path.Combine(f.Work, "job.py"), "return 'ran'");
        return new JsonObject { ["filePath"] = "job.py" };
    }

    private static string[] CheckIds(JsonObject record) =>
        (record["checks"] as JsonArray ?? []).Select(item => item!["id"]!.GetValue<string>()).ToArray();

    [Fact]
    public async Task Script_and_its_source_read_are_approved_together_with_combined_options()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskScriptSource);
        var call = Start(f, "call-script", "run_script", await ScriptFile(f));
        var pending = Assert.Single(await PendingAsync(f.Owner));
        Assert.Equal("run_script", pending["tool"]!["name"]!.GetValue<string>());
        Assert.Equal(["source-read"], CheckIds(pending));
        var check = pending["checks"]![0]!;
        Assert.Equal("read", check["tool"]!["name"]!.GetValue<string>());
        Assert.Null(check["tool"]!["invocationName"]);
        Assert.EndsWith("job.py", check["facts"]!["paths"]![0]!["resolved"]!.GetValue<string>());
        // Both rules, once each; the shortest deadline; the approvers both admit.
        Assert.Equal(
            ["confirm-script", "confirm-read"],
            pending["rules"]!.AsArray().Select(rule => rule!["id"]!.GetValue<string>())
        );
        Assert.Equal(300, pending["timeoutSeconds"]!.GetValue<long>());
        Assert.Equal(["ops"], pending["approvers"]!.AsArray().Select(item => item!.GetValue<string>()));
        await f.Manager.DecideToolApprovalAsync(f.Owner, pending["id"]!.GetValue<string>(), true, null, Administrator);
        var response = (await call.WaitAsync(TimeSpan.FromSeconds(30))).Response!.AsObject();
        Assert.Null(response["error"]);
        Assert.Contains("ran", response.ToJsonText());
        Assert.Single(Approvals(f.Owner));
    }

    [Fact]
    public async Task Source_read_ask_of_an_allowed_script_is_answerable()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(
            f.Manager,
            AskScriptSource.Replace("    action: ask\n    tool: {source: builtin, name: run_script}", "    action: allow\n    tool: {source: builtin, name: run_script}", StringComparison.Ordinal)
                .Replace("    approval: {timeoutSeconds: 600, approvers: [ops, dev]}\n", "", StringComparison.Ordinal)
        );
        var call = Start(f, "call-source", "run_script", await ScriptFile(f));
        var pending = Assert.Single(await PendingAsync(f.Owner));
        Assert.Equal("run_script", pending["tool"]!["name"]!.GetValue<string>());
        Assert.Equal(["source-read"], CheckIds(pending));
        Assert.Equal(["ops", "reader"], pending["approvers"]!.AsArray().Select(item => item!.GetValue<string>()));
        await f.Manager.DecideToolApprovalAsync(f.Owner, pending["id"]!.GetValue<string>(), true, "fine", Administrator);
        var response = (await call.WaitAsync(TimeSpan.FromSeconds(30))).Response!.AsObject();
        Assert.Null(response["error"]);
        Assert.Equal("fine", response["approvalNote"]!.GetValue<string>());
    }

    [Fact]
    public async Task Deny_installed_on_a_listed_check_while_the_call_waited_stops_it()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskScriptSource);
        var call = Start(f, "call-denied", "run_script", await ScriptFile(f));
        var pending = Assert.Single(await PendingAsync(f.Owner));
        await Policy(
            f.Manager,
            AskScriptSource.Replace(
                "  - id: confirm-read\n    action: ask",
                "  - id: confirm-read\n    action: deny",
                StringComparison.Ordinal
            ).Replace("\n    approval: {timeoutSeconds: 300, approvers: [ops, reader]}", "", StringComparison.Ordinal)
        );
        await f.Manager.DecideToolApprovalAsync(f.Owner, pending["id"]!.GetValue<string>(), true, null, Administrator);
        var execution = await call.WaitAsync(TimeSpan.FromSeconds(30));
        var response = execution.Response!.AsObject();
        Assert.Equal("tool_authorization_denied", response["error"]!["type"]!.GetValue<string>());
        Assert.Contains("`confirm-read`", response["error"]!["message"]!.GetValue<string>());
        // The approved call never ran.
        var record = Assert.Single(Approvals(f.Owner));
        Assert.Equal("cancelled", record["status"]!.GetValue<string>());
        Assert.Equal("notStarted", record["decidedBy"]!["reason"]!.GetValue<string>());
    }

    [Fact]
    public async Task Unattended_approval_of_several_checks_keeps_the_finite_default_and_the_shortest_rule_deadline()
    {
        await using var f = await ScriptFixture.Create();
        var withoutDeadlines = AskScriptSource
            .Replace("timeoutSeconds: 600, ", "", StringComparison.Ordinal)
            .Replace("timeoutSeconds: 300, ", "", StringComparison.Ordinal);
        await Policy(f.Manager, withoutDeadlines);
        var resolved = new ResolvedTool("run_script", "builtin", "run_script", await ScriptFile(f));
        var files = new WorkspaceTools(f.Work);
        var required = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.AuthorizeCallAsync(f.Owner, resolved, files, "master", CancellationToken.None)
        );
        Assert.Equal(["primary", "source-read"], required.Checks.Select(check => check.Id));
        var unattended = await f.Manager.BeginToolApprovalAsync(f.Owner, required, new("timer", null, "tsr_fixture"), unattended: true);
        Assert.Equal(SessionApprovals.UnattendedTimeoutSeconds, unattended.TimeoutSeconds);
        await f.Manager.DecideToolApprovalAsync(f.Owner, unattended.Id, false, null, Administrator);

        await Policy(f.Manager, AskScriptSource);
        var bounded = await f.Manager.BeginToolApprovalAsync(
            f.Owner,
            await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
                f.Manager.AuthorizeCallAsync(f.Owner, resolved, files, "master", CancellationToken.None)
            ),
            new("webhook", null, "tsr_hook"),
            unattended: true
        );
        Assert.Equal(300, bounded.TimeoutSeconds);
        await f.Manager.DecideToolApprovalAsync(f.Owner, bounded.Id, false, null, Administrator);
    }

    [Fact]
    public async Task Stop_cancels_a_staged_wait_as_not_started()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskScriptSource);
        using var stop = new CancellationTokenSource();
        var call = Start(f, "call-stopped", "run_script", await ScriptFile(f), stop.Token);
        var pending = Assert.Single(await PendingAsync(f.Owner));
        stop.Cancel();
        var response = (await call.WaitAsync(TimeSpan.FromSeconds(30))).Response!.AsObject();
        Assert.Equal("tool_call_cancelled", response["error"]!["type"]!.GetValue<string>());
        var record = Assert.Single(Approvals(f.Owner));
        Assert.Equal(pending["id"]!.GetValue<string>(), record["id"]!.GetValue<string>());
        Assert.Equal("cancelled", record["status"]!.GetValue<string>());
        Assert.Equal("stop", record["decidedBy"]!["reason"]!.GetValue<string>());
    }

    [Fact]
    public void Detached_work_carries_only_the_admitted_plan()
    {
        var owner = (SessionOwner)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SessionOwner));
        var other = (SessionOwner)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SessionOwner));
        var primary = new ResolvedTool("copy_between_nodes", "builtin", "copy_between_nodes", new JsonObject());
        var scope = new ToolApprovalScope(owner) { Primary = primary };
        scope.Add(new("ap-call", new HashSet<string>(["approved"], StringComparer.Ordinal), "note"));
        using (ToolApprovalScope.Enter(scope))
        {
            Assert.Null(ToolApprovalScope.Detach(other));
            var detached = ToolApprovalScope.Detach(owner)!;
            Assert.Same(primary, detached.Primary);
            Assert.True(detached.Covers(owner, "approved"));
            Assert.False(detached.Covers(owner, "another"));
            Assert.False(detached.Covers(other, "approved"));
            Assert.Empty(detached.Inputs);
        }
        // Without a grant the detached scope still names the call but covers nothing.
        using (ToolApprovalScope.Enter(new ToolApprovalScope(owner) { Primary = primary }))
            Assert.False(ToolApprovalScope.Detach(owner)!.Covers(owner, "approved"));
    }

    [Fact]
    public async Task Nested_calls_of_an_approved_script_ask_in_their_own_invocation()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(
            f.Manager,
            AskScriptSource.Replace("name: read}", "name: write}", StringComparison.Ordinal)
        );
        var call = Start(
            f,
            "call-nested",
            "run_script",
            new JsonObject
            {
                ["code"] = "call_tool('write', {'filePath': 'nested.txt', 'content': 'x'})\nreturn 'done'",
            }
        );
        var outer = Assert.Single(await PendingAsync(f.Owner));
        Assert.Equal("run_script", outer["tool"]!["name"]!.GetValue<string>());
        // The script's own write is not part of its plan; the outer approval does not list it.
        Assert.Null(outer["checks"]);
        await f.Manager.DecideToolApprovalAsync(f.Owner, outer["id"]!.GetValue<string>(), true, null, Administrator);
        var nested = (await PendingAsync(f.Owner)).Single(record =>
            record["id"]!.GetValue<string>() != outer["id"]!.GetValue<string>()
        );
        Assert.Equal("write", nested["tool"]!["name"]!.GetValue<string>());
        await f.Manager.DecideToolApprovalAsync(f.Owner, nested["id"]!.GetValue<string>(), true, null, Administrator);
        var response = (await call.WaitAsync(TimeSpan.FromSeconds(30))).Response!.AsObject();
        Assert.Null(response["error"]);
        Assert.True(File.Exists(Path.Combine(f.Work, "nested.txt")));
        Assert.Equal(2, Approvals(f.Owner).Length);
    }
}
