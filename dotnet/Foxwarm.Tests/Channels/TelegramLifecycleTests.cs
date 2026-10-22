using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class TelegramLifecycleTests
{
    [Theory]
    [InlineData(429)]
    [InlineData(503)]
    public async Task Json_api_errors_on_a_successful_http_response_keep_their_retry_after(int code)
    {
        await using var peer = await TelegramPeer.StartAsync();
        var polls = 0;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method == "getUpdates"
                && call.Body["limit"] is null
                && Interlocked.Increment(ref polls) == 1
                    ? Results.Json(
                        new
                        {
                            ok = false,
                            error_code = code,
                            description = "controlled API error",
                            parameters = new { retry_after = 7 },
                        }
                    )
                    : null
            );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:42", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        peer.Push("a", TelegramPeer.Text("42", "11", "recovered"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        Assert.Equal(new[] { TimeSpan.FromSeconds(7) }, peer.Delays.ToArray());
    }

    [Fact]
    public async Task Reload_returns_before_final_offset_sync_settles_and_retains_the_real_offset()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var channels = new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() };
        await using var f = await ExternalChannelFixture.CreateAsync(
            channels,
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:42", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        peer.Push("a", TelegramPeer.Text("42", "11", "queued before reload"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var sync = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (call.Method == "getUpdates" && call.Body["limit"] is not null)
            {
                sync.TrySetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
            return null;
        };
        try
        {
            var save = f.Configuration.SaveAppAsync(
                new JsonObject { ["channels"] = channels.DeepClone() }.ToJsonString()
            );
            await sync.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await save.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Contains(
                peer.Calls,
                call =>
                    call.Method == "getUpdates"
                    && call.Body["limit"] is not null
                    && SessionWait.Number(call.Body["offset"]) == 2
            );
            Assert.Equal(2, peer.Calls.Count(call => call.Method == "setMyCommands"));
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Theory]
    [InlineData("text/html", "<html>upstream unavailable</html>")]
    [InlineData(
        "application/json",
        "{\"ok\":false,\"error_code\":400,\"description\":\"gateway\"}"
    )]
    public async Task Http_server_status_precedes_body_parsing_and_polling_recovers(
        string contentType,
        string body
    )
    {
        await using var peer = await TelegramPeer.StartAsync();
        var polls = 0;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method == "getUpdates"
                && call.Body["limit"] is null
                && Interlocked.Increment(ref polls) == 1
                    ? Results.Text(body, contentType, statusCode: 503)
                    : null
            );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("alpha:42", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        peer.Push("a", TelegramPeer.Text("42", "11", "recovered"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        Assert.Equal(new[] { TimeSpan.FromSeconds(5) }, peer.Delays.ToArray());
        Assert.True(polls >= 2);
        Assert.DoesNotContain(
            peer.Calls,
            call => call.Method == "getUpdates" && call.Body["limit"] is not null
        );
    }
}
