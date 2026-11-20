using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Staged approvals (phase 2) of timers and explanation.
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Timer_whose_creation_target_registration_rejects_is_not_offered_for_approval()
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
              - id: confirm-timer
                action: ask
                tool: {source: builtin, name: create_timer}
              - id: confirm-sessions
                action: ask
                tool: {source: builtin, name: create_session}
            """
        );
        // The scheduled creation can never be approved, so neither is the timer.
        var response = await Call(execution.Tools, "create_timer", FreshTimer("alpha"));
        Assert.Equal("tool_authorization_denied", Error(response));
        Assert.Contains("can't be approved in advance", response.FailureMessage()!);
        Assert.Equal(0, ApprovalCount(owner));
        Assert.Empty(manager.Timers.List(owner.Id));

        // A timer of the caller's own Session still asks once and registers.
        var call = Call(execution.Tools, "create_timer", Obj("""{"afterSeconds":3600,"message":"later"}"""));
        var pending = await PendingApprovalAsync(owner);
        Assert.Null(pending["checks"]);
        await Approve(manager, owner, pending["id"]!.GetValue<string>());
        Assert.Null(Error(await call.WaitAsync(TimeSpan.FromSeconds(30))));
        Assert.Single(manager.Timers.List(owner.Id));
    }

    [Fact]
    public async Task Explain_probe_view_and_policy_read_asks_join_the_call_approval()
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
                approval: {approvers: [ops, reader]}
              - id: confirm-view
                action: ask
                tool: {source: builtin, name: view_session}
                approval: {approvers: [ops, viewer]}
            """
        );
        var call = Call(
            execution.Tools,
            "explain_tool_authorization",
            Obj("""{"probes":[{"sessionId":"opaque","toolId":"builtin:task","args":{"action":"list"}}]}""")
        );
        var pending = await PendingApprovalAsync(caller);
        Assert.Equal(
            ["policy-read", "probe-view:opaque"],
            pending["checks"]!.AsArray().Select(item => item!["id"]!.GetValue<string>())
        );
        Assert.Equal("opaque", pending["checks"]![1]!["facts"]!["sessionTarget"]!["id"]!.GetValue<string>());
        Assert.Equal(["ops"], pending["approvers"]!.AsArray().Select(item => item!.GetValue<string>()));
        await Approve(manager, caller, pending["id"]!.GetValue<string>());
        var response = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Null(Error(response));
        // The probed Session was viewable under the approval, so the probe has a decision.
        Assert.DoesNotContain("Session not found or unavailable", response.ToJsonText());
        Assert.Equal(1, ApprovalCount(caller));
    }

    [Fact]
    public async Task Timer_creation_target_that_starts_asking_during_the_wait_stops_the_timer()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("self");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        const string policy = """
            version: 1
            rules:
              - id: confirm-timer
                action: ask
                tool: {source: builtin, name: create_timer}
            """;
        await Policy(manager, policy);
        var call = Call(execution.Tools, "create_timer", FreshTimer("alpha"));
        var pending = await PendingApprovalAsync(owner);
        // The scheduled Session creation now needs approval, which a timer cannot get.
        await Policy(
            manager,
            policy + "\n  - {id: confirm-sessions, action: ask, tool: {source: builtin, name: create_session}}\n"
        );
        await Approve(manager, owner, pending["id"]!.GetValue<string>());
        var response = await call.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal("tool_authorization_denied", Error(response));
        Assert.Empty(manager.Timers.List(owner.Id));
        var record = owner.Entry.WithState(state => SessionApprovals.Records(state.Meta).Single().DeepClone());
        Assert.Equal("cancelled", record["status"]!.GetValue<string>());
        Assert.Equal("notStarted", record["decidedBy"]!["reason"]!.GetValue<string>());
    }
}
