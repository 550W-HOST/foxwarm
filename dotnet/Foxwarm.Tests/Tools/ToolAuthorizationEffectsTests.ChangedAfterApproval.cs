using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using static Foxwarm.Tests.ApprovalStagingSupport;

namespace Foxwarm.Tests;

// A call is approved once per stage. An ask the re-check after its approval finds that the
// approval did not list is a changed request: the call fails closed instead of asking again.
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task An_ask_added_to_the_plan_while_it_waited_fails_closed_after_one_approval()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var caller = await manager.RequiredAsync("foreign");
        var execution = TimerExecutor(manager, caller, temp.Path);
        await using var mcp = execution.Mcp;
        var path = Path.Combine(temp.Path, "workspace", "agents", "beta", "job.py");
        await File.WriteAllTextAsync(path, "return 17");
        const string initial = "version: 1\nrules:\n- {id: script, tool: run_script, action: ask}\n";
        await Policy(manager, initial);
        var call = Call(execution.Tools, "run_script", Obj("""{"filePath":"job.py"}"""));
        var first = await PendingAsync(caller);
        Assert.Empty(CheckIds(first));
        // The script's source read starts asking before the script is approved.
        await Policy(manager, initial + "- {id: source, tool: {source: node, name: read}, action: ask}\n");
        await Approve(manager, caller, Id(first));
        var response = await call.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal("tool_approval_unavailable", Error(response));
        Assert.Equal(
            "This call changed while it waited for approval: node `read` now needs approval under rule source, which the approval did not cover. It was not executed.",
            SessionWait.Text(response["error"]!["message"])
        );
        var record = Assert.Single(Records(caller));
        Assert.Equal("cancelled", SessionWait.Text(record["status"]));
        Assert.Equal("notStarted", SessionWait.Text(record["decidedBy"]!["reason"]));
    }
}
