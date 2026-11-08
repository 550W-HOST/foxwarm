using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private const string AskExecPolicy = """
        version: 1
        defaultAction: allow
        rules:
          - id: no-rm
            action: deny
            tool: {source: node, name: exec}
            args: {command: {equals: rm}}
          - id: confirm-exec
            action: ask
            tool: {source: node, name: exec}
            reason: Commands need a decision.
            approval: {timeoutSeconds: 600, approvers: [ops]}
        """;

    private static ResolvedTool Exec(string command) =>
        new("exec", "node", "exec", new JsonObject { ["command"] = command });

    [Fact]
    public async Task Ask_outcome_passes_only_inside_an_approved_scope_of_the_same_owner_after_deny_and_isolation()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true}"""));
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var beta = await manager.RequiredAsync("foreign");
        var alpha = await manager.RequiredAsync("opaque");
        var execution = Executor(manager, beta, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, AskExecPolicy);

        var required = await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
            manager.AuthorizeToolAsync(beta, Exec("ls"), execution.Files, CancellationToken.None)
        );
        Assert.Equal("tool_approval_unavailable", required.ErrorType);
        Assert.Equal(
            "confirm-exec",
            required.Assessment.Asking.Single().Decision.Rule!["id"]!.GetValue<string>()
        );
        Assert.Equal(
            "This call needs approval for an internal step (node `exec`, rule confirm-exec), but approval can't be requested for internal steps. It was not executed.",
            required.Message
        );

        // An empty scope, or a grant recorded for another owner, does not cover the call.
        foreach (
            var scope in new[]
            {
                new ToolApprovalScope(beta),
                new ToolApprovalScope(alpha) { Grant = new("ap-other", "fingerprint", null) },
            }
        )
            using (ToolApprovalScope.Enter(scope))
                await Assert.ThrowsAsync<ToolApprovalRequiredException>(() =>
                    manager.AuthorizeToolAsync(
                        beta,
                        Exec("ls"),
                        execution.Files,
                        CancellationToken.None
                    )
                );

        var approved = new ToolApprovalScope(beta) { Grant = new("ap-test", "fingerprint", null) };
        using (ToolApprovalScope.Enter(approved))
        {
            await manager.AuthorizeToolAsync(
                beta,
                Exec("ls"),
                execution.Files,
                CancellationToken.None
            );
            // Deny stays final inside an approved invocation.
            var denied = await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(
                    beta,
                    Exec("rm"),
                    execution.Files,
                    CancellationToken.None
                )
            );
            Assert.Equal("tool_authorization_denied", denied.ErrorType);
            // Legacy isolation is decided before approval and is not overridden by it.
            var alphaApproved = new ToolApprovalScope(alpha)
            {
                Grant = new("ap-alpha", "fingerprint", null),
            };
            using var alphaScope = ToolApprovalScope.Enter(alphaApproved);
            var alphaExecution = Executor(manager, alpha, temp.Path);
            await using var alphaMcp = alphaExecution.Mcp;
            var isolated = await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(
                    alpha,
                    Exec("ls"),
                    alphaExecution.Files,
                    CancellationToken.None
                )
            );
            Assert.IsNotType<ToolApprovalRequiredException>(isolated);
        }
    }

    [Fact]
    public async Task Explain_reports_ask_decision_combined_approval_options_and_compare_changes()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(manager, AskExecPolicy);
        var candidate = Path.Combine(temp.Path, "workspace", "agents", "beta", "candidate.yaml");
        await File.WriteAllTextAsync(candidate, "version: 1\ndefaultAction: allow\n");

        var args = Obj(
            """
            {"probes":[
              {"sessionId":"foreign","toolId":"node:master/exec","args":{"command":"ls"}},
              {"sessionId":"foreign","toolId":"node:master/exec","args":{"command":"rm"}}
            ],"compare":true}
            """
        );
        args["policyFilePath"] = candidate;
        var result = await Explain(execution.Tools, args);
        var ask = result["probes"]![0]!;
        var active = ask["active"]!;
        Assert.Equal("ask", active["decision"]!.GetValue<string>());
        Assert.False(active["allowed"]!.GetValue<bool>());
        Assert.Null(active["deniedBy"]);
        Assert.Equal("policy", active["askedBy"]!.GetValue<string>());
        Assert.Equal(600, active["approval"]!["timeoutSeconds"]!.GetValue<long>());
        Assert.Equal("ops", active["approval"]!["approvers"]![0]!.GetValue<string>());
        var layer = active["layers"]![0]!;
        Assert.Equal("ask", layer["decision"]!.GetValue<string>());
        Assert.Equal("ask", layer["rule"]!["action"]!.GetValue<string>());
        Assert.Equal(600, layer["rule"]!["approval"]!["timeoutSeconds"]!.GetValue<long>());
        Assert.Equal("allow", ask["candidate"]!["decision"]!.GetValue<string>());
        Assert.True(ask["changed"]!.GetValue<bool>());

        var deny = result["probes"]![1]!["active"]!;
        Assert.Equal("deny", deny["decision"]!.GetValue<string>());
        Assert.Null(deny["askedBy"]);
    }

    private static async Task<JsonObject> PendingApprovalAsync(SessionOwner owner)
    {
        for (var attempt = 0; attempt < 400; attempt++)
        {
            var pending = owner.Entry.WithState(state =>
                SessionApprovals.Pending(state.Meta).FirstOrDefault()?.DeepClone() as JsonObject
            );
            if (pending is not null)
                return pending;
            await Task.Delay(25);
        }
        throw new TimeoutException("No pending approval appeared.");
    }

    private static int ApprovalCount(SessionOwner owner) =>
        owner.Entry.WithState(state => SessionApprovals.Records(state.Meta).Length);

    private static Task Approve(SessionManager manager, SessionOwner owner, string id) =>
        manager.DecideToolApprovalAsync(
            owner,
            id,
            true,
            null,
            new JsonObject { ["kind"] = "administrator" }
        );

    private static JsonObject ExplainTaskProbe() =>
        Obj(
            """{"probes":[{"sessionId":"foreign","toolId":"builtin:task","args":{"action":"list"}}]}"""
        );

    [Fact]
    public async Task Ask_on_an_internal_step_of_an_allowed_call_fails_closed_without_a_request()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            rules:
              - id: confirm-read
                action: ask
                tool: {source: node, name: read}
            """
        );
        var response = await Call(
            execution.Tools,
            "explain_tool_authorization",
            ExplainTaskProbe()
        );
        Assert.Equal("tool_approval_unavailable", Error(response));
        Assert.Equal(
            "This call needs approval for an internal step (node `read`, rule confirm-read), but approval can't be requested for internal steps. It was not executed.",
            response["error"]!["message"]!.GetValue<string>()
        );
        Assert.Equal(0, ApprovalCount(caller));
    }

    [Fact]
    public async Task Approved_outer_call_covers_its_internal_steps_with_one_request()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            rules:
              - action: ask
                tool: {source: builtin, name: explain_tool_authorization}
              - action: ask
                tool: {source: node, name: read}
            """
        );
        var call = Call(execution.Tools, "explain_tool_authorization", ExplainTaskProbe());
        var pending = await PendingApprovalAsync(caller);
        Assert.Equal("explain_tool_authorization", pending["tool"]!["name"]!.GetValue<string>());
        await Approve(manager, caller, pending["id"]!.GetValue<string>());
        var response = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Null(Error(response));
        Assert.Equal(1, ApprovalCount(caller));
    }

    [Fact]
    public async Task Effect_owner_recheck_of_an_approved_call_is_covered()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            "version: 1\nrules: [{action: ask, tool: {source: builtin, name: create_timer}}]"
        );
        var call = Call(
            execution.Tools,
            "create_timer",
            Obj("""{"afterSeconds":3600,"message":"later"}""")
        );
        var pending = await PendingApprovalAsync(owner);
        Assert.Empty(manager.Timers.List(owner.Id));
        await Approve(manager, owner, pending["id"]!.GetValue<string>());
        Assert.Null(Error(await call.WaitAsync(TimeSpan.FromSeconds(30))));
        Assert.Single(manager.Timers.List(owner.Id));
        Assert.Equal(1, ApprovalCount(owner));
    }

    [Fact]
    public async Task Approved_copy_carries_its_grant_into_the_detached_transfer()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("foreign");
        var execution = Executor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var workspace = Path.Combine(temp.Path, "workspace", "agents", owner.Agent);
        await File.WriteAllTextAsync(Path.Combine(workspace, "source.txt"), "copied");
        await Policy(
            manager,
            """
            version: 1
            rules:
              - id: confirm-copy
                action: ask
                tool: {source: builtin, name: copy_between_nodes}
              - id: confirm-read
                action: ask
                tool: {source: node, name: read}
            """
        );
        var call = Call(
            execution.Tools,
            "copy_between_nodes",
            Obj(
                """{"sourceNode":"master","sourcePath":"source.txt","targetNode":"master","targetPath":"target.txt"}"""
            )
        );
        var pending = await PendingApprovalAsync(owner);
        Assert.Equal("copy_between_nodes", pending["tool"]!["name"]!.GetValue<string>());
        await Approve(manager, owner, pending["id"]!.GetValue<string>());
        var response = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Null(Error(response));
        Assert.Equal("copied", await File.ReadAllTextAsync(Path.Combine(workspace, "target.txt")));
        // The transfer's recheck and its Node read are internal steps of the approved call.
        Assert.Equal(1, ApprovalCount(owner));
    }

    [Fact]
    public async Task Startup_settles_pending_approvals_of_Sessions_that_were_not_busy()
    {
        using var temp = new TempDirectory();
        using var copy = new TempDirectory();
        await Seed(temp.Path);
        await using (var manager = Manager(temp.Path))
        {
            await manager.LoadAsync();
            var owner = await manager.RequiredAsync("foreign");
            var execution = Executor(manager, owner, temp.Path);
            await using var mcp = execution.Mcp;
            await Policy(
                manager,
                "version: 1\nrules: [{action: ask, tool: {source: node, name: write}}]"
            );
            _ = Call(execution.Tools, "write", Obj("""{"filePath":"later.txt","content":"no"}"""));
            await PendingApprovalAsync(owner);
            Assert.False(owner.Entry.WithState(state => state.Busy));
            for (
                var attempt = 0;
                !manager.Catalog.PendingApprovalIds().Contains("foreign");
                attempt++
            )
            {
                Assert.True(attempt < 400, "The catalog never announced the pending approval.");
                await Task.Delay(25);
            }
            // The process ends without settling the request, as in a crash.
            CopyTree(temp.Path, copy.Path);
        }

        await using var restarted = Manager(copy.Path);
        await restarted.LoadAsync();
        Assert.Empty(restarted.Catalog.PendingApprovalIds());
        Assert.DoesNotContain(
            restarted.Catalog.QuestionRows(50),
            row => SessionCatalog.Text(row["id"]) == "foreign"
        );
        var saved = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(copy.Path, "data", "state", "sessions", "foreign.json")
            )
        )!;
        var record = saved["meta"]!["questions"]!["approvals"]![0]!;
        Assert.Equal("expired", record["status"]!.GetValue<string>());
        Assert.Equal("restart", record["decidedBy"]!["reason"]!.GetValue<string>());
        Assert.False(
            File.Exists(Path.Combine(copy.Path, "workspace", "agents", "beta", "later.txt"))
        );
    }

    private static void CopyTree(string from, string to)
    {
        foreach (
            var directory in Directory.EnumerateDirectories(from, "*", SearchOption.AllDirectories)
        )
            Directory.CreateDirectory(Path.Combine(to, Path.GetRelativePath(from, directory)));
        foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
            using (
                var source = new FileStream(
                    file,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete
                )
            )
            using (var target = File.Create(Path.Combine(to, Path.GetRelativePath(from, file))))
                source.CopyTo(target);
    }

    [Fact]
    public async Task Restart_expires_pending_approvals_and_tells_the_resumed_turn_without_replay()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        var file = Path.Combine(temp.Path, "data", "state", "sessions", "opaque.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["busy"] = true;
        raw["busyStartedAt"] = 1;
        var meta = raw["meta"] as JsonObject ?? new JsonObject();
        meta["questions"] = new JsonObject
        {
            ["revision"] = 4,
            ["items"] = new JsonArray(),
            ["approvals"] = new JsonArray(
                new JsonObject
                {
                    ["id"] = "ap-lost",
                    ["status"] = "pending",
                    ["toolCallId"] = "call-lost",
                    ["tool"] = new JsonObject { ["source"] = "node", ["name"] = "exec" },
                },
                new JsonObject
                {
                    ["id"] = "ap-done",
                    ["status"] = "approved",
                    ["tool"] = new JsonObject { ["source"] = "node", ["name"] = "write" },
                }
            ),
        };
        raw["meta"] = meta;
        await File.WriteAllTextAsync(file, raw.ToJsonString());

        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var records = owner.Entry.WithState(state =>
            SessionApprovals.Records(state.Meta).Select(record => record.DeepClone()).ToArray()
        );
        Assert.Equal("expired", records[0]!["status"]!.GetValue<string>());
        Assert.Equal("restart", records[0]!["decidedBy"]!["reason"]!.GetValue<string>());
        Assert.Equal("approved", records[1]!["status"]!.GetValue<string>());
        var resumed = SessionWait.Text(owner.Entry.Snapshot().Queue[^1].Parts![0]["system"])!;
        Assert.Contains("type=\"session-resumed\"", resumed);
        Assert.Contains(
            "Tool call exec (call-lost) was awaiting approval when the process restarted. It was not executed.",
            resumed
        );
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        Assert.Equal(
            "expired",
            saved["meta"]!["questions"]!["approvals"]![0]!["status"]!.GetValue<string>()
        );
        Assert.Equal(5, saved["meta"]!["questions"]!["revision"]!.GetValue<long>());
    }

    [Fact]
    public async Task Timer_registration_rejects_future_session_creation_that_requires_approval()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        await Policy(
            manager,
            """
            version: 1
            rules:
              - action: ask
                tool: {source: builtin, name: create_session}
            """
        );
        var response = await Call(execution.Tools, "create_timer", FreshTimer("alpha"));
        Assert.Equal("tool_authorization_denied", Error(response));
        Assert.Equal(
            "Tool authorization rules require approval to create Sessions in Agent 'alpha'. A scheduled creation can't be approved in advance, so this timer was not registered.",
            response["error"]!["message"]!.GetValue<string>()
        );
        Assert.Empty(manager.Timers.List(owner.Id));
    }
}
