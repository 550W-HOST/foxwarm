using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Reply_registration_retains_only_real_accepted_effects_when_strict_admission_fails(
        bool committed
    )
    {
        var context = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await using var peer = await InboundMcpFixture.CreateAsync(configure: app =>
            app.Use(
                async (http, next) =>
                {
                    await next(http);
                    if (
                        http.Request.Method == "POST"
                        && !http.Request.Headers.ContainsKey("Mcp-Session-Id")
                        && http.Response.Headers["Mcp-Session-Id"].ToString() is { Length: > 0 } id
                    )
                        context.TrySetResult(id);
                }
            )
        );
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        await Notifications(f, "start");
        var id = await context.Task.WaitAsync(TimeSpan.FromSeconds(10));
        peer.WriteStage = (id, stage) =>
        {
            if (
                id != peer.Target.Id
                || stage
                    != (
                        committed
                            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            : AtomicJsonWriteStage.BeforeRename
                    )
            )
                return;
            peer.WriteStage = null;
            throw new IOException("Owned strict admission write failure.");
        };
        var failed = await f.CallAsync(
            f.First,
            "foxwarm_session",
            Send(peer.Target.Id, "strict reply input")
        );
        Assert.True(failed!["isError"]!.GetValue<bool>());
        Assert.Null(failed["accepted"]);
        Assert.Equal(committed ? 1 : 0, Queue(peer.Target).Length);
        var reply = await Reply(peer, "mcp-" + id + ":reply", "reply after uncertain admission");
        if (committed)
        {
            Assert.Null(reply!["error"]);
            await Until(() => Queue(f.First).Length == 1);
        }
        else
        {
            Assert.NotNull(reply!["error"]);
            Assert.Empty(Queue(f.First));
        }
    }

    [Fact]
    public async Task Stop_fences_received_input_while_the_normal_User_admission_lane_is_held()
    {
        await using var peer = await InboundMcpFixture.CreateAsync();
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        await Notifications(f, "start");
        var target = Target(
            await f.CallAsync(f.First, "foxwarm_session", Send(peer.Target.Id, "one"))
        );
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lane = f.First.Entry.SaveLane.MutateIdentityAsync(async () =>
        {
            held.TrySetResult();
            await release.Task;
        });
        await held.Task;
        Assert.Null((await Reply(peer, target, "late received input"))!["error"]);
        var stop = Notifications(f, "stop");
        // Stop removes/fences the entry synchronously before awaiting the SDK's handler drain.
        Assert.Equal("stopped", State(await Notifications(f, "status")));
        release.TrySetResult();
        await lane;
        Assert.Equal("stopped", State(await stop.WaitAsync(TimeSpan.FromSeconds(10))));
        Assert.Empty(Queue(f.First));
    }

    [Fact]
    public async Task Failed_physical_GET_reports_unavailable_without_waiting_for_POST_initialization_or_replaying_a_call()
    {
        await using var peer = await InboundMcpFixture.CreateAsync(configure: app =>
            app.Use(
                async (http, next) =>
                {
                    if (http.Request.Method == "GET")
                        http.Response.StatusCode = 405;
                    else
                        await next(http);
                }
            )
        );
        await using var f = await OutboundMcpFixture.CreateAsync();
        await Connect(f, peer);
        var start = await Notifications(f, "start").WaitAsync(TimeSpan.FromSeconds(10));
        Assert.NotNull(start!["error"]);
        var ordinary = await f.CallAsync(
            f.First,
            "foxwarm_session",
            Send(peer.Target.Id, "ordinary still usable", false)
        );
        Assert.True(ordinary!["accepted"]!.GetValue<bool>());
        Assert.Single(Queue(peer.Target));
    }
}
