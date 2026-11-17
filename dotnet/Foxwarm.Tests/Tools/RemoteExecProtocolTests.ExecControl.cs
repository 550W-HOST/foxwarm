using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Main's side of stopping a CLI Node's Session command (features.execControl).
public sealed partial class RemoteExecProtocolTests
{
    [Fact]
    public async Task Older_Node_without_exec_control_is_unsupported_and_receives_no_request()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var request = await fixture.StartBackground();
        var id = request["backgroundExecId"]!.GetValue<string>();
        var row = Assert.Single(fixture.Manager.RunningExecs(fixture.Owner));
        Assert.Equal(id, row.Id);
        Assert.Equal("remote", row.NodeId);
        Assert.Equal("owned-effect", row.Command);

        var (result, node, resident) = await fixture.Manager.StopExecAsync(fixture.Owner, id, default);
        Assert.Equal(SessionManager.ExecStopResult.Unsupported, result);
        Assert.Equal("remote", node);
        Assert.True(resident);
        Assert.False(Assert.Single(fixture.Manager.RunningExecs(fixture.Owner)).StopRequested);
        // Nothing was sent: the next frame Main sends is the ping answered below, not a request.
        await fixture.Send(new JsonObject { ["type"] = "ping" });
        Assert.NotEqual("exec_control_request", (await fixture.Read())["type"]!.GetValue<string>());
    }

    [Fact]
    public async Task Stop_request_carries_the_exact_grant_and_maps_the_Node_outcome_once()
    {
        await using var fixture = new Fixture();
        await fixture.Start(execControl: true);
        var request = await fixture.StartBackground();
        var id = request["backgroundExecId"]!.GetValue<string>();

        var stopping = fixture.Manager.StopExecAsync(fixture.Owner, id, default);
        var control = await fixture.Read();
        Assert.Equal("exec_control_request", control["type"]!.GetValue<string>());
        Assert.Equal("stop", control["action"]!.GetValue<string>());
        Assert.Equal(id, control["execId"]!.GetValue<string>());
        Assert.Equal(fixture.Owner.Id, control["sessionId"]!.GetValue<string>());
        Assert.Equal(
            request["completionCapability"]!.GetValue<string>(),
            control["completionCapability"]!.GetValue<string>()
        );
        // A second stop while the first is pending is not sent again.
        Assert.Equal(
            SessionManager.ExecStopResult.AlreadyRequested,
            (await fixture.Manager.StopExecAsync(fixture.Owner, id, default)).Result
        );
        await fixture.Send(
            new JsonObject
            {
                ["type"] = "exec_control_response",
                ["requestId"] = control["requestId"]!.DeepClone(),
                ["result"] = new JsonObject { ["outcome"] = "stopped" },
            }
        );
        Assert.Equal(SessionManager.ExecStopResult.Stopped, (await stopping).Result);
        Assert.True(Assert.Single(fixture.Manager.RunningExecs(fixture.Owner)).StopRequested);

        // The completion still arrives through the ordinary acknowledged event, once.
        var completion = fixture.Completion(request);
        completion["message"] = $"[{id}] Stopped on request: exit code 143, 1s\ncommand: `owned-effect`\n(No output)\n---\nLog file: /log";
        await fixture.Send(completion);
        Assert.Equal("session_event_accepted", (await fixture.Read())["type"]!.GetValue<string>());
        Assert.Empty(fixture.Manager.RunningExecs(fixture.Owner));
        Assert.Equal(
            SessionManager.ExecStopResult.Finished,
            (await fixture.Manager.StopExecAsync(fixture.Owner, id, default)).Result
        );
    }

    [Fact]
    public async Task Another_Session_cannot_list_or_stop_a_remote_command_and_lost_replies_are_unknown()
    {
        await using var fixture = new Fixture();
        await fixture.Start(execControl: true);
        var request = await fixture.StartBackground();
        var id = request["backgroundExecId"]!.GetValue<string>();
        var other = await fixture.Manager.CreateNamedAsync("main", "intruder", null, null);
        Assert.Empty(fixture.Manager.RunningExecs(other));
        Assert.Equal(
            SessionManager.ExecStopResult.NotOwned,
            (await fixture.Manager.StopExecAsync(other, id, default)).Result
        );

        using var cancel = new CancellationTokenSource();
        var stopping = fixture.Manager.StopExecAsync(fixture.Owner, id, cancel.Token);
        Assert.Equal("exec_control_request", (await fixture.Read())["type"]!.GetValue<string>());
        cancel.Cancel();
        Assert.Equal(SessionManager.ExecStopResult.Unknown, (await stopping).Result);
        // Not retried: the stop stays requested and no second request is sent.
        Assert.Equal(
            SessionManager.ExecStopResult.AlreadyRequested,
            (await fixture.Manager.StopExecAsync(fixture.Owner, id, default)).Result
        );
    }
}
