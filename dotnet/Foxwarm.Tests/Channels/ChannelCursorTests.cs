using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests;

public sealed class ChannelCursorTests
{
    [Fact]
    public async Task APolledInputAndItsReceiptCommitTogetherBeforeAcknowledgement()
    {
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, new ControlledChat());
        var owner = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        var item = QueueItem.UserText("one update");
        var receipt = ChannelCursors.Receipt("telegram", "bot", "account", "38");
        store.Fail("s", new IOException("write failed"), SaveKind.Strict);
        await Assert.ThrowsAsync<IOException>(() => registry.Ingress.EnqueuePolledInputAsync("s", item, receipt, () => { }));
        Assert.Empty(owner.Snapshot().Queue);
        store.ClearFailure("s", SaveKind.Strict);
        await registry.Ingress.EnqueuePolledInputAsync("s", item, receipt, () => { });
        var next = new SessionRegistry(store, new ControlledChat());
        next.TriggerOverride = _ => Task.CompletedTask;
        var restored = await next.LoadOrAddAsync("s");
        await next.Ingress.EnqueuePolledInputAsync("s", item, receipt, () => { });
        Assert.Single(restored.Snapshot().Queue);
    }

    [Fact]
    public async Task ReopenedFileCursorRestoresMatrixEncryptionBeforeTheFirstResumedSync()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var config = peer.Matrix();
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["chat"] = config.DeepClone() },dependencies: peer.Dependencies);
        var managed = f.Manager.ManagedChannels!;
        await managed.ReloadAsync();
        var encrypted = new JsonObject { ["type"]="m.room.encryption", ["state_key"]="", ["content"]=new JsonObject() };
        peer.MatrixEvents("matrix-a","!encrypted:fixture",encrypted);
        await TelegramChannelTests.Until(() => peer.Calls.Any(c=>c.Query.GetValueOrDefault("since")=="cursor-1"));
        await managed.ChangeAsync("stop","chat");
        await managed.DrainPollsAsync();
        // A new state-document owner, as at process startup. The next sync returns no room state.
        var cursors = new ChannelCursors(new FileStateDocuments(f.Data));
        await using var second = new MatrixChannel("chat",config,f.Manager,f.Router,peer.Dependencies,ChannelHealth.From(_=>{}),cursors:cursors);
        await second.StartAsync();
        var error = await Assert.ThrowsAsync<InvalidOperationException>(()=>second.Transport.Send("!encrypted:fixture","do not send",new(),default));
        Assert.Contains("encryption",error.Message);
        Assert.Empty(peer.Sent("matrix-a"));
        await second.StopAsync();
        await cursors.DrainedAsync();
    }

    [Fact]
    public async Task AWeixinCommandCanRestartItsOwnPollerWithoutReplayingItsCommand()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var config = peer.Weixin();
        config["longPollTimeoutMs"] = 120;
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["chat"] = config.DeepClone() }, dependencies: peer.Dependencies);
        f.Manager.AttachChannel("chat:alice", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        var command = ExternalProtocolPeer.WeixinText("alice", "/channel restart chat");
        command["message_id"] = 5;
        peer.WeixinMessages("weixin-a", command);
        using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!peer.Calls.Any(c => c.Body["get_updates_buf"]?.ToString() == "cursor-1")) await Task.Delay(15, bound.Token);
        peer.WeixinMessages("weixin-a", ExternalProtocolPeer.WeixinText("alice", "after restart"));
        while (f.Owner.Entry.Snapshot().Queue.Count == 0) await Task.Delay(15, bound.Token);
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.Single(peer.Sent("weixin-a"));
    }

    [Fact]
    public async Task WeixinRestartsAtItsDurableCursorAndRetriesADuplicateMessageIdWithoutASecondAdmission()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var config = peer.Weixin();
        config["longPollTimeoutMs"] = 120;
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["chat"] = config.DeepClone() },dependencies:peer.Dependencies);
        f.Manager.AttachChannel("chat:alice",f.Owner);
        var managed = f.Manager.ManagedChannels!;
        await managed.ReloadAsync();
        var message = ExternalProtocolPeer.WeixinText("alice","one delivery");
        message["message_id"] = 1234;
        peer.WeixinMessages("weixin-a",message);
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Body["get_updates_buf"]?.ToString()=="cursor-1"));
        await managed.ChangeAsync("stop","chat");
        var start = peer.Calls.Count;
        await managed.ChangeAsync("start","chat");
        await TelegramChannelTests.Until(()=>peer.Calls.Skip(start).Any(c=>c.Body["get_updates_buf"]?.ToString()=="cursor-1"));
        peer.WeixinMessages("weixin-a",message);
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Body["get_updates_buf"]?.ToString()=="cursor-2"));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }
}
