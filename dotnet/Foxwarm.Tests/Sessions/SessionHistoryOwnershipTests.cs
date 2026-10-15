using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionHistoryOwnershipTests
{
    [Fact]
    public void Ingress_and_mutable_projections_do_not_alias_published_records_or_document_lifetime()
    {
        var input = Message("first", 1);
        var history = SessionHistory.FromJson([input]);
        input["parts"]![0]!["text"] = "changed ingress";
        using (var document = JsonDocument.Parse(Message("document", 2).ToJsonString()))
            history = history.Append([HistoryMessage.FromElement(document.RootElement)]);

        var projection = history.Materialize();
        projection[0]["parts"]![0]!["text"] = "changed projection";
        var canonical = CanonicalMessage.FromNode(history[0].ToJson());
        var part = canonical.Parts[0].ToJson();
        part["text"] = "changed part";
        canonical.ToJson()["parts"]![0]!["text"] = "changed canonical output";
        Assert.Equal("first", canonical.Parts[0].GetString("text"));
        Assert.Equal("first", history[0].Data.GetProperty("parts")[0].GetProperty("text").GetString());
        Assert.Equal("document", history[1].Data.GetProperty("parts")[0].GetProperty("text").GetString());
        Assert.Same(history[0], history[0]);
        Assert.Same(history[0], history.First());
    }

    [Theory]
    [InlineData("1.0")]
    [InlineData("1e0")]
    public void Historical_integral_sequence_spellings_remain_readable(string number)
    {
        using var document = JsonDocument.Parse("{\"role\":\"user\",\"parts\":[],\"__meta\":{\"seq\":" + number + "}}");
        var message = HistoryMessage.FromElement(document.RootElement);
        Assert.Equal(1, message.Sequence);
    }

    [Fact]
    public async Task Captured_history_survives_real_append_retry_replacement_and_concurrent_metadata_changes()
    {
        var state = new SessionState("s");
        var ingress = Message("initial", 1);
        state.History.Add(ingress);
        state.NextMessageSeq = 2;
        var store = new InMemorySessionAuthorityStore();
        var entry = new SessionEntry(state, store);
        var before = entry.Snapshot();
        var host = new LocalSessionTurnHost(entry, store, new NoChat());
        var appended = Message("appended", 0);
        appended.Remove("__meta");
        var item = QueueItem.Prebuilt(appended);
        state.Queue.Add(item);
        await host.AppendQueuedInputsAsync([item]);
        appended["parts"]![0]!["text"] = "caller changed result";
        var afterAppend = entry.Snapshot();
        Assert.Single(before.History);
        Assert.Same(before.History[0], afterAppend.History[0]);
        Assert.Equal("appended", afterAppend.History[1].ToJson()["parts"]![0]!["text"]!.GetValue<string>());

        var notice = new RetryNoticeState();
        await entry.SaveLane.CommitRetryNoticeAsync(notice, "retry one", new JsonObject());
        var firstRetry = entry.Snapshot();
        await entry.SaveLane.CommitRetryNoticeAsync(notice, "retry two", new JsonObject());
        await entry.SaveLane.CommitDisplayNameAsync("new name");
        entry.SetStoppingForTest(true);
        var current = entry.Snapshot();
        Assert.Equal("retry one", firstRetry.History[2].ToJson()["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("retry one\nretry two", current.History[2].ToJson()["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Same(firstRetry.History[0], current.History[0]);
        Assert.Same(firstRetry.History[1], current.History[1]);
        Assert.NotSame(firstRetry.History[2], current.History[2]);
        Assert.False(firstRetry.Stopping);
        Assert.True(current.Stopping);
        Assert.Null(firstRetry.AuthorityEnvelope["displayName"]);
    }

    [Fact]
    public void Rewrite_clear_and_request_projection_keep_old_snapshots_and_fork_roots_stable()
    {
        var state = new SessionState("parent");
        state.History.AddRange([Message("first", 1), Message("second", 2)]);
        state.NextMessageSeq = 3;
        var old = state.Snapshot();
        var fork = new SessionState("fork");
        fork.History.Reset(old.History);
        var changed = old.History[1].ToJson();
        changed["parts"]![0]!["text"] = "rewritten";
        var rewrite = old.History.Replace(1, HistoryMessage.FromJson(changed));
        state.PublishCommittedHistoryRewrite(rewrite, 0, 3, 3);
        var request = ConcreteRequestHistory.PrepareRequest(state.History.Snapshot().Materialize(), "m");
        request[0]["parts"]![0]!["text"] = "request-only mutation";
        Assert.Same(old.History[0], state.History[0]);
        Assert.Equal("first", state.History[0].ToJson()["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("second", old.History[1].ToJson()["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Same(old.History[1], fork.History[1]);
        state.PublishCommittedHistoryRewrite(SessionHistory.Empty, 1, 3, 3);
        fork.History.Add(Message("fork only", 3));
        Assert.Empty(state.History);
        Assert.Equal(2, old.History.Count);
        Assert.Equal(3, fork.History.Count);
    }

    private static JsonObject Message(string text, long seq) => new()
    {
        ["role"] = "user",
        ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
        ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = 1 },
    };

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("unused");
    }
}
