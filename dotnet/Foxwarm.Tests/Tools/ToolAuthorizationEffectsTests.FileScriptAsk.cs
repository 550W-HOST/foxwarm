using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Ask-once for a file-backed script under a mixed policy (operation authorization phase 3).
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task A_mixed_policy_asks_once_for_a_file_backed_script()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var workspace = Path.Combine(temp.Path, "workspace", "agents", owner.Agent);
        Directory.CreateDirectory(workspace);
        const string Twice =
            "out = []\nfor model in ['missing', 'missing']:\n    try:\n        request_model_without_context('hi', model)\n    except RuntimeError as e:\n        out.append(str(e))\nreturn out";
        await File.WriteAllTextAsync(Path.Combine(workspace, "model.py"), Twice);
        await Policy(
            manager,
            "version: 1\nrules:\n- {op: node.select, action: deny}\n- {id: confirm-script, tool: {source: builtin, name: run_script}, action: ask}\n"
        );
        foreach (var (input, expected) in new[]
        {
            (Obj("""{"filePath":"model.py"}"""), 1),
            (new JsonObject { ["code"] = Twice }, 2),
        })
        {
            var call = Call(execution.Tools, "run_script", input);
            var pending = await PendingApprovalAsync(owner);
            await Approve(manager, owner, SessionWait.Text(pending["id"])!);
            var result = await call.WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(2, System.Text.RegularExpressions.Regex.Matches(result.ToJsonString(), "Unknown model: missing").Count);
            Assert.Equal(expected, ApprovalCount(owner));
        }
    }
}
