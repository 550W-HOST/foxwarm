using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Session list memoization over operation-rule Session IDs and patterns (operation authorization
// phase 3).
public sealed partial class ToolAuthorizationEffectsTests
{
    [Fact]
    public async Task Memoized_session_lists_agree_with_exact_projection_over_operation_rules()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        await manager.CreateNamedAsync("beta", "second", null, null);
        await manager.CreateNamedAsync("alpha", "sibling", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        string[] policies =
        [
            "defaultAction: deny\nrules:\n- {op: session.view, targetSession: {id: foreign}, action: allow}\n",
            "defaultAction: deny\nrules:\n- {op: session.send, targetSession: {id: [foreign, alpha/sibling]}, action: allow}\n",
            "defaultAction: deny\nrules:\n- {op: session.view, targetSession: {id: 'beta/*'}, action: allow}\n",
            "defaultAction: deny\nrules:\n- {op: session.view, targetSession: {id: '*eign'}, action: allow}\n",
            "rules:\n- {op: session.view, targetSession: {id: foreign}, action: deny}\n- {op: session.send, targetSession: {id: foreign}, action: deny}\n- {op: history.read, action: deny}\n- {op: session.control, action: deny}\n- {op: task.assign, action: deny}\n",
            "defaultAction: deny\nrules:\n- {op: session.manage, parent: {id: foreign}, action: allow}\n- {op: session.view, targetSession: {session: {sameAgent: true}}, action: allow}\n",
        ];
        var rows = manager.Catalog.OffsetPage(int.MaxValue, 0);
        Assert.True(rows.Length >= 5);
        foreach (var policy in policies)
        {
            await Policy(manager, "version: 1\n" + policy);
            var memoized = manager.SessionVisibilityFor(owner);
            var exact = manager.SessionVisibilityFor(owner, memoize: false);
            foreach (var row in rows)
                Assert.True(
                    memoized.Admits(row) == exact.Admits(row),
                    $"{SessionCatalog.Text(row["id"])} under {policy}"
                );
            // The listed set is reachable: a broad scan or the explicit IDs cover every admitted row.
            foreach (var row in rows.Where(exact.Admits))
                Assert.True(
                    memoized.Broad(null) || memoized.ExplicitIds().Contains(SessionCatalog.Text(row["id"])),
                    $"{SessionCatalog.Text(row["id"])} unreachable under {policy}"
                );
        }
        await Policy(manager, "version: 1\n" + policies[0]);
        Assert.True(manager.SessionVisibilityFor(owner).Admits(manager.Catalog.Get("foreign")!));
        Assert.Null(Error(await Call(execution.Tools, "view_session", Obj("""{"sessionId":"foreign"}"""))));
    }
}
