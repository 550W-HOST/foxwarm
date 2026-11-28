using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class ChannelCursorTests
{
    [Fact]
    public async Task GuestCreationFailureRetriesBeforeAcknowledgement()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var channel = ExternalChannelFixture.Channel();
        channel["guestAgent"] = new JsonObject { ["agentId"] = "guest", ["isolated"] = false };
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["chat"] = channel }, dependencies: peer.Dependencies
        );
        await f.Manager.CreateAgentAsync("guest", createMainSession: false);
        int attempts = 0;
        f.Manager.BeforeCreationPublication = _ =>
        {
            if (Interlocked.Increment(ref attempts) == 1) throw new IOException("temporary failure");
            return Task.CompletedTask;
        };
        var message = TelegramPeer.Text("42", "999", "first guest message");
        message["message_id"] = 10;
        peer.Respond = call => Task.FromResult<IResult?>(
            call.Method == "getUpdates" && call.Body["offset"]?.ToString() == "0"
                ? Results.Json(new { ok = true, result = new[] { new { update_id = 1, message } } })
                : null
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Calls.Any(c =>
            c.Method == "getUpdates" && c.Body["offset"]?.ToString() == "2"));
        Assert.True(attempts >= 2);
        Assert.NotNull(f.Manager.ChannelBinding("chat:42"));
    }

    [Fact]
    public async Task ConfirmedRecommitSchedulesRunnableInputOnce()
    {
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, new ControlledChat());
        var owner = registry.Add("s");
        int triggers = 0;
        registry.TriggerOverride = _ => { triggers++; return Task.CompletedTask; };
        var item = QueueItem.UserText("first input");
        Task Receive() => registry.Ingress.EnqueuePolledInputAsync("s", item, "receipt", () => { });
        store.Fail("s", new AuthorityCommittedException("projection failed", new IOException()), SaveKind.Strict);
        await Assert.ThrowsAsync<AuthorityCommittedException>(Receive);
        store.ClearFailure("s", SaveKind.Strict);
        await Receive();
        Assert.Single((await store.LoadAsync("s"))!.Queue);
        Assert.True(registry.HasRunnableWork(owner));
        await Receive();
        Assert.Equal(1, triggers);
    }
}
