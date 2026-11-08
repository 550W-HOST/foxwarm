using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// The in-call approval gate: a call that matches an ask rule waits inside its own invocation
// for a decision, its deadline or cancellation, and starts only after an approved decision.
public sealed class ToolApprovalGateTests
{
    private const string AskWrite = """
        version: 1
        rules:
          - id: confirm-write
            action: ask
            reason: Writes need a decision.
            tool: {source: node, name: write}
            approval: {approvers: [ops]}
        """;

    private static JsonObject Administrator => new() { ["kind"] = "administrator" };

    private static Task Policy(SessionManager manager, string yaml) =>
        manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), CancellationToken.None);

    private static JsonObject[] Approvals(SessionOwner owner) =>
        owner.Entry.WithState(state =>
            SessionApprovals
                .Records(state.Meta)
                .Select(record => (JsonObject)record.DeepClone())
                .ToArray()
        );

    private static async Task<JsonObject[]> PendingAsync(SessionOwner owner, int count = 1)
    {
        for (var attempt = 0; attempt < 400; attempt++)
        {
            var pending = Approvals(owner)
                .Where(record => SessionApprovals.Status(record) == "pending")
                .ToArray();
            if (pending.Length >= count)
                return pending;
            await Task.Delay(25);
        }
        throw new TimeoutException("No pending approval appeared.");
    }

    private static Task<TurnToolExecution> Start(
        ScriptFixture f,
        string id,
        string name,
        JsonObject args,
        CancellationToken token = default
    ) =>
        f.Tools.ExecuteAttributedAsync(
            new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["args"] = args,
            },
            token
        );

    private static JsonObject Write(string file) =>
        new() { ["filePath"] = file, ["content"] = "payload" };

    [Fact]
    public async Task Approved_call_waits_then_runs_once_with_the_note_and_a_recorded_decision()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var call = Start(f, "call-approved", "write", Write("approved.txt"));
        var pending = Assert.Single(await PendingAsync(f.Owner));
        var id = pending["id"]!.GetValue<string>();
        Assert.StartsWith("ap-", id);
        Assert.Equal("turn", pending["origin"]!.GetValue<string>());
        Assert.Equal("call-approved", pending["toolCallId"]!.GetValue<string>());
        Assert.Equal("node", pending["tool"]!["source"]!.GetValue<string>());
        Assert.Equal("write", pending["tool"]!["name"]!.GetValue<string>());
        Assert.Equal("approved.txt", pending["args"]!["filePath"]!.GetValue<string>());
        Assert.Null(pending["argsTruncated"]);
        Assert.Null(pending["expiresAt"]);
        Assert.NotEmpty(pending["facts"]!["paths"]!.AsArray());
        var rule = Assert.Single(pending["rules"]!.AsArray())!;
        Assert.Equal("global", rule["layer"]!.GetValue<string>());
        Assert.Equal("confirm-write", rule["id"]!.GetValue<string>());
        Assert.Equal("Writes need a decision.", rule["reason"]!.GetValue<string>());
        Assert.Equal("ops", pending["approvers"]![0]!.GetValue<string>());
        Assert.False(call.IsCompleted);
        Assert.False(File.Exists(Path.Combine(f.Work, "approved.txt")));

        var decided = await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            id,
            approve: true,
            note: "  Keep it short.  ",
            Administrator
        );
        Assert.Equal("approved", decided["status"]!.GetValue<string>());
        var execution = await call.WaitAsync(TimeSpan.FromSeconds(30));
        var response = execution.Response!.AsObject();
        Assert.Null(response["error"]);
        Assert.Equal("Keep it short.", response["approvalNote"]!.GetValue<string>());
        Assert.Equal("payload", await File.ReadAllTextAsync(Path.Combine(f.Work, "approved.txt")));
        Assert.Equal(id, execution.Approval!["id"]!.GetValue<string>());
        Assert.Equal("approved", execution.Approval["status"]!.GetValue<string>());
        Assert.Equal("administrator", execution.Approval["decidedBy"]!["kind"]!.GetValue<string>());
        Assert.Equal("Keep it short.", execution.Approval["note"]!.GetValue<string>());

        await Assert.ThrowsAsync<ToolApprovalNotPendingException>(() =>
            f.Manager.DecideToolApprovalAsync(f.Owner, id, false, null, Administrator)
        );
        await Assert.ThrowsAsync<KeyNotFoundException>(() =>
            f.Manager.DecideToolApprovalAsync(f.Owner, "ap-missing", true, null, Administrator)
        );
        // A later identical call is a new invocation and asks again.
        var again = Start(f, "call-again", "write", Write("approved.txt"));
        Assert.Single(await PendingAsync(f.Owner));
        Assert.Equal(2, Approvals(f.Owner).Length);
        var second = Approvals(f.Owner)
            .Single(record => SessionApprovals.Status(record) == "pending");
        await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            second["id"]!.GetValue<string>(),
            false,
            null,
            Administrator
        );
        await again.WaitAsync(TimeSpan.FromSeconds(30));
    }

    [Fact]
    public async Task Rejected_call_never_starts_and_returns_the_note_and_approval_id()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var call = Start(f, "call-rejected", "write", Write("rejected.txt"));
        var id = Assert.Single(await PendingAsync(f.Owner))["id"]!.GetValue<string>();
        await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            id,
            approve: false,
            note: "Use the staging copy instead.",
            new JsonObject { ["kind"] = "identity", ["id"] = "ops" }
        );
        var execution = await call.WaitAsync(TimeSpan.FromSeconds(30));
        var response = execution.Response!.AsObject();
        Assert.Equal("tool_approval_rejected", response["error"]!["type"]!.GetValue<string>());
        Assert.Equal(
            "An approver rejected this tool call. It was not executed. Don't repeat it unchanged; follow the approver's note if there is one.",
            response["error"]!["message"]!.GetValue<string>()
        );
        Assert.Equal(
            "Use the staging copy instead.",
            response["error"]!["note"]!.GetValue<string>()
        );
        Assert.Equal(id, response["approvalId"]!.GetValue<string>());
        Assert.Null(response["approvalNote"]);
        Assert.Equal("rejected", execution.Approval!["status"]!.GetValue<string>());
        Assert.Equal("ops", execution.Approval["decidedBy"]!["id"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(f.Work, "rejected.txt")));
    }

    [Fact]
    public async Task Deadline_expires_through_the_first_wins_transition_and_unattended_waits_are_finite()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var resolved = new ResolvedTool("write", "node", "write", Write("late.txt"));
        var required = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.AuthorizeToolAsync(
                f.Owner,
                resolved,
                new WorkspaceTools(f.Work),
                CancellationToken.None
            )
        );
        var pending = await f.Manager.BeginToolApprovalAsync(
            f.Owner,
            required,
            new("timer", null, "tsr_fixture"),
            unattended: true
        );
        Assert.Equal(SessionApprovals.UnattendedTimeoutSeconds, pending.TimeoutSeconds);
        var stored = Assert.Single(Approvals(f.Owner));
        Assert.Equal("timer", stored["origin"]!.GetValue<string>());
        Assert.Equal("tsr_fixture", stored["runId"]!.GetValue<string>());
        Assert.Equal(3600, stored["timeoutSeconds"]!.GetValue<long>());
        Assert.Equal(
            stored["createdAt"]!.GetValue<long>() + 3_600_000,
            stored["expiresAt"]!.GetValue<long>()
        );

        var record = await f.Manager.AwaitToolApprovalAsync(
            f.Owner,
            pending with
            {
                TimeoutSeconds = 0,
            },
            CancellationToken.None
        );
        Assert.Equal("expired", record["status"]!.GetValue<string>());
        Assert.Equal("timeout", record["decidedBy"]!["reason"]!.GetValue<string>());
        var expired = Assert.Throws<ToolApprovalOutcomeException>(() =>
            SessionManager.ApprovalOutcome(pending, record)
        );
        Assert.Equal("tool_approval_expired", expired.ErrorType);
        Assert.Equal(
            "No one approved this tool call within 3600 seconds. It was not executed.",
            expired.Message
        );
        Assert.Equal(pending.Id, expired.ToolError()["approvalId"]!.GetValue<string>());
        await Assert.ThrowsAsync<ToolApprovalNotPendingException>(() =>
            f.Manager.DecideToolApprovalAsync(f.Owner, pending.Id, true, null, Administrator)
        );

        // A rule deadline applies to foreground calls; there is no default otherwise.
        await Policy(
            f.Manager,
            AskWrite.Replace("approval: {approvers: [ops]}", "approval: {timeoutSeconds: 45}")
        );
        var foreground = await f.Manager.BeginToolApprovalAsync(
            f.Owner,
            await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
                f.Manager.AuthorizeToolAsync(
                    f.Owner,
                    resolved,
                    new WorkspaceTools(f.Work),
                    CancellationToken.None
                )
            ),
            new("turn", "call", null),
            unattended: false
        );
        Assert.Equal(45, foreground.TimeoutSeconds);
        await f.Manager.DecideToolApprovalAsync(f.Owner, foreground.Id, false, null, Administrator);
        Assert.Equal(
            "rejected",
            (await f.Manager.AwaitToolApprovalAsync(f.Owner, foreground, CancellationToken.None))[
                "status"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Stop_cancels_the_wait_as_not_started_and_records_the_cancellation()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        using var stop = new CancellationTokenSource();
        var call = Start(f, "call-stopped", "write", Write("stopped.txt"), stop.Token);
        var id = Assert.Single(await PendingAsync(f.Owner))["id"]!.GetValue<string>();
        stop.Cancel();
        var response = (await call.WaitAsync(TimeSpan.FromSeconds(30))).Response!.AsObject();
        Assert.Equal("tool_call_cancelled", response["error"]!["type"]!.GetValue<string>());
        Assert.Contains("was not started", response["error"]!["message"]!.GetValue<string>());
        var record = Assert.Single(Approvals(f.Owner));
        Assert.Equal(id, record["id"]!.GetValue<string>());
        Assert.Equal("cancelled", record["status"]!.GetValue<string>());
        Assert.Equal("stop", record["decidedBy"]!["reason"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(f.Work, "stopped.txt")));
    }

    [Fact]
    public async Task Approval_does_not_override_a_deny_installed_while_the_call_waited()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var call = Start(f, "call-policy", "write", Write("policy.txt"));
        var id = Assert.Single(await PendingAsync(f.Owner))["id"]!.GetValue<string>();
        await Policy(
            f.Manager,
            "version: 1\nrules: [{action: deny, tool: {source: node, name: write}}]"
        );
        await f.Manager.DecideToolApprovalAsync(f.Owner, id, true, null, Administrator);
        var response = (await call.WaitAsync(TimeSpan.FromSeconds(30))).Response!.AsObject();
        Assert.Equal("tool_authorization_denied", response["error"]!["type"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(f.Work, "policy.txt")));
    }

    [Fact]
    public async Task Pending_limit_refuses_further_requests_without_waiting()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        await f.Owner.Entry.SaveLane.MutateQuestionsAsync(meta =>
        {
            for (var index = 0; index < SessionApprovals.MaxPending; index++)
                SessionApprovals.Add(
                    meta,
                    new JsonObject
                    {
                        ["id"] = $"ap-fixture{index:00}",
                        ["status"] = "pending",
                        ["tool"] = new JsonObject { ["source"] = "node", ["name"] = "write" },
                    }
                );
            return "filled";
        });
        var response = (
            await Start(f, "call-full", "write", Write("full.txt"))
                .WaitAsync(TimeSpan.FromSeconds(30))
        ).Response!.AsObject();
        Assert.Equal("tool_approval_unavailable", response["error"]!["type"]!.GetValue<string>());
        Assert.Equal(
            "This Session already has 32 tool calls waiting for approval. This call was not executed.",
            response["error"]!["message"]!.GetValue<string>()
        );
        Assert.Equal(SessionApprovals.MaxPending, Approvals(f.Owner).Length);
    }

    [Fact]
    public async Task Parallel_exec_segment_requests_every_approval_before_any_member_starts()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(
            f.Manager,
            "version: 1\nrules: [{id: confirm-exec, action: ask, tool: {source: node, name: exec}}]"
        );
        JsonObject Exec(string id, string file) =>
            new()
            {
                ["id"] = id,
                ["name"] = "exec",
                ["args"] = new JsonObject { ["command"] = $"printf ok > {file}", ["timeout"] = 15 },
            };
        var calls = new[] { Exec("exec-a", "a.txt"), Exec("exec-b", "b.txt") };
        var preparations = new TurnToolPreparation?[calls.Length];
        for (var index = 0; index < calls.Length; index++)
            preparations[index] = await f.Tools.PrepareDirectExecAsync(calls[index], default);
        var pending = await PendingAsync(f.Owner, 2);
        Assert.Equal(
            ["exec-a", "exec-b"],
            pending.Select(record => record["toolCallId"]!.GetValue<string>())
        );
        var settle = f.Tools.SettleApprovalsAsync(preparations, default);
        await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            pending[1]["id"]!.GetValue<string>(),
            false,
            "Only one.",
            Administrator
        );
        Assert.False(settle.IsCompleted);
        await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            pending[0]["id"]!.GetValue<string>(),
            true,
            null,
            Administrator
        );
        await settle.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.NotNull(preparations[0]!.Grant);
        Assert.Null(preparations[0]!.Response);
        Assert.Equal(
            "tool_approval_rejected",
            preparations[1]!.Response!["error"]!["type"]!.GetValue<string>()
        );
        var rejected = f.Tools.PreparedFailure(preparations[1]!);
        Assert.Equal("rejected", rejected.Approval!["status"]!.GetValue<string>());

        // The approved member runs with its carried grant and is not asked again.
        var approved = await f
            .Tools.ExecuteAttributedAsync(calls[0], default, approved: preparations[0])
            .WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Null(approved.Response!["error"]);
        Assert.Equal("approved", approved.Approval!["status"]!.GetValue<string>());
        Assert.Equal(2, Approvals(f.Owner).Length);
        Assert.Equal("ok", await File.ReadAllTextAsync(Path.Combine(f.Work, "a.txt")));
        Assert.False(File.Exists(Path.Combine(f.Work, "b.txt")));
    }

    [Fact]
    public async Task Nested_ToolScript_call_waits_without_spending_the_slice_budget()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var run = f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "call_tool('write', {'filePath': 'script.txt', 'content': 'from script'})\nreturn 'done'",
                ["timeoutSecs"] = 1,
            }
        );
        var pending = Assert.Single(await PendingAsync(f.Owner));
        Assert.Equal("script", pending["origin"]!.GetValue<string>());
        Assert.StartsWith("tsr_", pending["runId"]!.GetValue<string>());
        await Task.Delay(TimeSpan.FromSeconds(2));
        await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            pending["id"]!.GetValue<string>(),
            true,
            "fine",
            Administrator
        );
        var result = await run.WaitAsync(TimeSpan.FromSeconds(60));
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Equal("done", result["result"]!.GetValue<string>());
        Assert.Equal(
            "from script",
            await File.ReadAllTextAsync(Path.Combine(f.Work, "script.txt"))
        );
    }

    [Fact]
    public async Task Rejection_inside_ToolScript_is_a_catchable_host_error()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var run = f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "try:\n    call_tool('write', {'filePath': 'no.txt', 'content': 'x'})\nexcept Exception as error:\n    return str(error)\nreturn 'ran'",
            }
        );
        var pending = Assert.Single(await PendingAsync(f.Owner));
        await f.Manager.DecideToolApprovalAsync(
            f.Owner,
            pending["id"]!.GetValue<string>(),
            false,
            null,
            Administrator
        );
        var result = await run.WaitAsync(TimeSpan.FromSeconds(60));
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Contains(
            "An approver rejected this tool call",
            result["result"]!.GetValue<string>()
        );
        Assert.False(File.Exists(Path.Combine(f.Work, "no.txt")));
    }

    [Fact]
    public async Task Covered_scope_compares_the_primary_call_facts_but_not_internal_steps()
    {
        await using var f = await ScriptFixture.Create();
        await Policy(f.Manager, AskWrite);
        var files = new WorkspaceTools(f.Work);
        var primary = new ResolvedTool("write", "node", "write", Write("one.txt"));
        var required = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.AuthorizeToolAsync(f.Owner, primary, files, CancellationToken.None)
        );
        var fingerprint = ToolApprovalScope.Fingerprint(primary, required.Assessment.Request);
        var scope = new ToolApprovalScope(f.Owner)
        {
            Grant = new("ap-fixture", fingerprint, null),
            Primary = primary,
        };
        using var entered = ToolApprovalScope.Enter(scope);
        await f.Manager.AuthorizeToolAsync(f.Owner, primary, files, CancellationToken.None);
        // The approved call with other facts is not covered; an internal step is.
        scope.Primary = new ResolvedTool("write", "node", "write", Write("two.txt"));
        await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            f.Manager.AuthorizeToolAsync(f.Owner, scope.Primary, files, CancellationToken.None)
        );
        await f.Manager.AuthorizeToolAsync(
            f.Owner,
            new ResolvedTool("write", "node", "write", Write("three.txt")),
            files,
            CancellationToken.None
        );
    }
}
