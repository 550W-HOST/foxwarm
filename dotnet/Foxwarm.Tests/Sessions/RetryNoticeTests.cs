using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class RetryNoticeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Retry_notice_owns_only_its_row_and_preserves_precommit_or_postrename_identity_and_immutable_Archive(bool afterRename)
    {
        var root = Path.Combine(Path.GetTempPath(), "foxwarm-retry-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var armed = false;
            var store = new PersistentSessionAuthorityStore(root, "s", authorityStageHook: stage =>
            {
                if (armed && stage == (afterRename ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename))
                { armed = false; throw new IOException("injected notice commit failure"); }
            });
            var registry = new SessionRegistry(store, new NoChat()) { TriggerOverride = _ => Task.CompletedTask };
            var entry = registry.Add("s"); await entry.SaveLane.SaveStrictAsync();
            await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("acknowledged", clientMessageId: "ack"));
            var notice = new RetryNoticeState(); var retry = JsonNode.Parse("{\"attempt\":1,\"maxRetries\":6}")!.AsObject();
            armed = true;
            if (afterRename) await Assert.ThrowsAsync<AuthorityCommittedException>(() => entry.SaveLane.CommitRetryNoticeAsync(notice, "first", retry));
            else await Assert.ThrowsAsync<IOException>(() => entry.SaveLane.CommitRetryNoticeAsync(notice, "first", retry));
            Assert.Equal(afterRename, notice.Committed is not null); Assert.Equal(afterRename ? 1 : 0, entry.Snapshot().History.Count);
            Assert.Single(entry.Snapshot().Queue); Assert.Single((await store.LoadAsync("s"))!.Queue);
            retry["attempt"] = 2; await entry.SaveLane.CommitRetryNoticeAsync(notice, "second", retry);
            var seq = notice.Committed!["__meta"]!["seq"]!.GetValue<long>(); var originalArchive = store.Archive.ReadMessageBySeq(seq)!.MessageJson;
            retry["attempt"] = 3; await entry.SaveLane.CommitRetryNoticeAsync(notice, "third", retry);
            var active = Assert.Single(entry.Snapshot().History);
            Assert.Equal(seq, active["__meta"]!["seq"]!.GetValue<long>()); Assert.False(active["modelVisible"]!.GetValue<bool>());
            Assert.True(active["__meta"]!["updateExisting"]!.GetValue<bool>()); Assert.Equal(3, active["__meta"]!["retry"]!["attempt"]!.GetValue<int>());
            Assert.Equal(afterRename ? "first\nsecond\nthird" : "second\nthird", active["parts"]![0]!["text"]!.GetValue<string>());
            Assert.Equal(originalArchive, store.Archive.ReadMessageBySeq(seq)!.MessageJson); Assert.Single(entry.Snapshot().Queue);
            Assert.Equal(active.ToJsonString(), (await store.LoadAsync("s"))!.History.Single().ToJsonString());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
    [Fact]
    public async Task Completed_terminal_notice_requires_actual_publication_after_commit_callback_failure()
    {
        var store = new InMemorySessionAuthorityStore(); var models = HostModels.ForTest(new ResponsesClientOptions(new Uri("http://localhost"), "m", "a/m", "", "", 50));
        var hosted = new SessionOwner("s", "main", models) { Registry = new SessionRegistry(store, new NoChat()) };
        var entry = hosted.Registry.Add("s"); var notification = new ModelRetryNotice(hosted);
        entry.Committed = _ => throw new IOException("publication failed");
        Assert.False(await notification.NotifyAsync(new ModelRetryEvent(1, 6, "http-error", "unavailable", "a/m", null, "400", Final: true)));
        Assert.Equal(1, entry.BestEffortFailureCount); Assert.Single(entry.Snapshot().History);
        var delivered = 0; hosted.Changed += value => { if (value.Kind == SessionEventKind.MessageCommitted) delivered++; };
        entry.Committed = null;
        Assert.True(await notification.NotifyAsync(new ModelRetryEvent(2, 6, "http-error", "unavailable", "a/m", null, "400", Final: true)));
        Assert.Equal(1, delivered); Assert.Single(entry.Snapshot().History); Assert.Equal(2, entry.Snapshot().NextMessageSeq);
    }

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken) => throw new InvalidOperationException("unused");
    }
}
