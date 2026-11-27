using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// A pending approval is decided under the approval requirements in effect when the decision
// arrives: a policy change while it waits can narrow who may approve.
public sealed partial class ToolAuthorizationEffectsTests
{
    private static string ScriptAsk(string approvers) =>
        $"version: 1\ndefaultAction: allow\nrules:\n- id: confirm-scripts\n  action: ask\n  tool: {{source: builtin, name: run_script}}\n  approval: {{approvers: [{approvers}]}}\n";

    private static JsonObject Identity(string id) => new() { ["kind"] = "identity", ["id"] = id };

    private static async Task<(SessionManager Manager, SessionOwner Owner, SessionToolExecutor Tools, Foxwarm.McpClient Mcp)> ScriptFixture(TempDirectory temp)
    {
        await Seed(temp.Path);
        var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        RegisterNode(manager, execution);
        var workspace = Path.Combine(temp.Path, "workspace", "agents", owner.Agent);
        await File.WriteAllTextAsync(Path.Combine(workspace, "job.py"), "return 'ran'");
        return (manager, owner, execution.Tools, execution.Mcp);
    }

    [Fact]
    public async Task A_pending_approval_is_decided_under_the_approvers_of_the_current_policy()
    {
        using var temp = new TempDirectory();
        var (manager, owner, tools, mcp) = await ScriptFixture(temp);
        await using var _ = manager;
        await using var __ = mcp;
        await Policy(manager, ScriptAsk("ops, dev"));
        var script = Call(tools, "run_script", Obj("""{"filePath":"job.py"}"""));
        var pending = await PendingApprovalAsync(owner);
        var id = SessionWait.Text(pending["id"])!;
        Assert.Equal(["dev", "ops"], ApprovalStagingSupport.Approvers(pending));

        // The tenant narrows the rule's approvers while the question is pending.
        await Policy(manager, ScriptAsk("ops"));
        await Assert.ThrowsAsync<ToolApprovalNotAllowedException>(() =>
            manager.DecideToolApprovalAsync(owner, id, true, null, Identity("dev"))
        );
        await Assert.ThrowsAsync<ToolApprovalNotAllowedException>(() =>
            manager.DecideToolApprovalAsync(owner, id, false, null, Identity("dev"))
        );
        Assert.Equal("pending", SessionApprovals.Status((await PendingApprovalAsync(owner))));
        await manager.DecideToolApprovalAsync(owner, id, true, null, Identity("ops"));
        Assert.Null(Error(await script.WaitAsync(TimeSpan.FromSeconds(30))));
    }
}
