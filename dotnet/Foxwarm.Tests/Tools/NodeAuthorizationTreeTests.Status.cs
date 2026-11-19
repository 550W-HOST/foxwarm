using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    [Fact]
    public async Task Node_status_shows_the_Session_current_Node_and_is_authorized_as_viewing_it()
    {
        await using var f = await Fixture.Create();
        var status = Assert.IsType<JsonObject>(
            await f.Call("ctl", Obj("""{"command":"node status"}"""))
        );
        Assert.Null(status["error"]);
        Assert.Equal("master", SessionWait.Text(status["currentNode"]));
        Assert.Equal(true, status["connected"]?.GetValue<bool>());
        Assert.Equal(
            f.Manager.AgentDirectory(f.Owner.Agent),
            SessionWait.Text(status["defaultCwd"])
        );
        // No Session cwd is set, so commands start in the default directory.
        Assert.False(status.ContainsKey("cwd"));

        // The operation is node.view of the caller's current Node.
        await f.Policy(
            "version: 1\ndefaultAction: allow\nrules:\n- {id: no-status, op: node.view, node: {exact: master}, action: deny}\n"
        );
        var denied = Assert.IsType<JsonObject>(
            await f.Call("ctl", Obj("""{"command":"node status"}"""))
        );
        Assert.NotNull(denied["error"]);
        Assert.False(denied.ContainsKey("currentNode"));
    }
}
