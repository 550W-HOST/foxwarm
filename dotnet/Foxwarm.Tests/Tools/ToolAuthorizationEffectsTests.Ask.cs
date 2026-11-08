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
