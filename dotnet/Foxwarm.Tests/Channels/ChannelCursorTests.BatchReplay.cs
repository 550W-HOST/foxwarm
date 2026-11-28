using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class ChannelCursorTests
{
    [Fact]
    public async Task MatrixSkipsAnExhaustedEventWhenAnotherEventHoldsTheBatch()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["chat"] = peer.Matrix() }, dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("chat:!room:fixture", f.Owner);
        JsonObject Media(string id)
        {
            var item = ExternalProtocolPeer.MatrixText("$" + id, id);
            item["origin_server_ts"] = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
            item["content"] = new JsonObject { ["msgtype"] = "m.file", ["url"] = "mxc://fixture/" + id, ["body"] = id + ".txt" };
            return item;
        }
        int first = 0, second = 0;
        var timeline = new { events = new[] { Media("a"), Media("b") } };
        var join = new Dictionary<string, object> { ["!room:fixture"] = new { timeline } };
        peer.Media["a"] = [1];
        peer.Media["b"] = [2];
        peer.Respond = call =>
        {
            if (call.Path.EndsWith("/download/fixture/a") && Interlocked.Increment(ref first) <= 3
                || call.Path.EndsWith("/download/fixture/b") && Interlocked.Increment(ref second) <= 2)
                return Task.FromResult<IResult?>(Results.StatusCode(503));
            return Task.FromResult<IResult?>(call.Path.EndsWith("/sync") && call.Query.GetValueOrDefault("since") == "initial"
                ? Results.Json(new { next_batch = "done", rooms = new { join } }) : null);
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Calls.Any(c => c.Query.GetValueOrDefault("since") == "done"));
        Assert.Equal(3, first);
        Assert.Equal(3, second);
        var item = Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.Contains("b.txt", Foxwarm.Sessions.SessionQueueJson.ToJson(item).ToJsonString());
    }

    [Fact]
    public async Task WeixinInputPauseSurvivesTimeoutUntilTheCheckpointIsWritten()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var config = peer.Weixin();
        config["longPollTimeoutMs"] = 500;
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["chat"] = config }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("chat:alice", f.Owner);
        var path = Path.Combine(f.Data, "state", "channel-cursors.json");
        var message = ExternalProtocolPeer.WeixinText("alice", "first");
        message["message_id"] = 1;
        var paused = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var timedOut = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var repair = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string? Error() => f.Manager.ManagedChannels!.Statuses().OfType<JsonObject>()
            .Single(row => row["channelId"]!.ToString() == "chat")["lastError"]?.ToString();
        int polls = 0;
        peer.Respond = async call =>
        {
            if (!call.Path.EndsWith("/getupdates")) return null;
            switch (Interlocked.Increment(ref polls))
            {
                case 1:
                    Directory.CreateDirectory(path);
                    break;
                case 2:
                    paused.TrySetResult(Error());
                    return null; // The peer has no message; the client's long poll times out.
                case 3:
                    timedOut.TrySetResult(Error());
                    await repair.Task;
                    break;
                default:
                    return null;
            }
            return Results.Json(new { ret = 0, get_updates_buf = "next", msgs = new[] { message } });
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        try
        {
            const string expected = "Weixin input is paused: an incoming message couldn't be saved. Retrying.";
            Assert.Equal(expected, await paused.Task.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(expected, await timedOut.Task.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.True(Directory.Exists(path));
        }
        finally
        {
            if (Directory.Exists(path)) Directory.Delete(path);
            repair.TrySetResult();
        }
        await TelegramChannelTests.Until(() => peer.Calls.Any(c => c.Body["get_updates_buf"]?.ToString() == "next"));
        Assert.True(File.Exists(path));
        Assert.Null(Error());
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }
}
