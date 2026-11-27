using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using static Foxwarm.Tests.SessionAuthorityContractTests;

namespace Foxwarm.Tests;

/// <summary>
/// What a head-plus-segments authority rewrites per commit: the storage design's reason to
/// prefer it over whole-document saves in the hosted mode. Callers still pass complete
/// snapshots; the store derives the delta from record identity.
/// </summary>
public sealed class SegmentedSessionAuthorityTests : IDisposable
{
    private readonly TempDirectory temp = new();
    private readonly SegmentedAuthorityBackend backend;

    public SegmentedSessionAuthorityTests() => backend = new(temp.Path);

    public void Dispose() => temp.Dispose();

    private ISessionAuthority Open(string id = "s") =>
        backend.Open(id, "main", new SessionAuthorityCallbacks());

    [Fact]
    public async Task The_stored_value_equals_the_file_document_after_the_same_commits()
    {
        using var fileRoot = new TempDirectory();
        var file = new Foxwarm.Storage.FileStorageContext(fileRoot.Path).Authority;
        foreach (var target in new ISessionAuthorityBackend[] { file, backend })
        {
            var store = target.Open("s", "main", new SessionAuthorityCallbacks());
            var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
            history = await Append(store, history, Message(2, "two"));
            history = history.Replace(1, HistoryMessage.FromJson(Message(2, "two, updated")));
            await store.CommitAsync(
                Snapshot("s", history, 3) with
                {
                    AuthorityEnvelope = new JsonObject { ["futureTop"] = "kept" },
                },
                SaveKind.Strict
            );
        }
        var expected = (await file.ReadRawAsync("s"))!.Document;
        var actual = (await backend.ReadRawAsync("s"))!.Document;
        Assert.True(JsonNode.DeepEquals(expected, actual), expected + "\n" + actual);
    }

    [Fact]
    public async Task Saves_without_history_changes_write_only_the_head()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        backend.ResetCounters();

        var queued = SessionQueueJson.FromJson(
            new JsonObject
            {
                ["type"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "queued" }),
            }
        );
        await store.CommitAsync(
            Snapshot("s", history, 3) with { Queue = [queued], Busy = true, BusyStartedAt = 5 },
            SaveKind.Strict
        );
        Assert.Equal(1, backend.HeadWrites);
        Assert.Equal(0, backend.RecordsWritten);
    }

    [Fact]
    public async Task Appends_write_only_the_appended_records()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        backend.ResetCounters();
        await Append(store, history, Message(3, "three"));
        Assert.Equal(1, backend.RecordsWritten);
        Assert.Equal(3, backend.SegmentCount);
    }

    [Fact]
    public async Task Changes_rewrite_from_the_segment_holding_the_first_changed_record()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        history = await Append(store, history, Message(3, "three"));

        backend.ResetCounters();
        history = history.Replace(2, HistoryMessage.FromJson(Message(3, "retry notice")));
        await store.CommitAsync(Snapshot("s", history, 4), SaveKind.Strict);
        Assert.Equal(1, backend.RecordsWritten);

        backend.ResetCounters();
        history = history.Replace(0, HistoryMessage.FromJson(Message(1, "redacted")));
        await store.CommitAsync(Snapshot("s", history, 4), SaveKind.Strict);
        Assert.Equal(3, backend.RecordsWritten);
        Assert.Equal(1, backend.SegmentCount);
    }

    [Fact]
    public async Task Clear_deletes_segments_and_identity_moves_rewrite_none()
    {
        var store = Open("old");
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"), id: "old");
        history = await Append(store, history, Message(2, "two"), id: "old");

        backend.ResetCounters();
        backend.MoveIdentity("old", "new");
        store.RebindIdentity("new", "main");
        await store.PersistIdentitySnapshotAsync(Snapshot("new", history, 3));
        Assert.Equal(0, backend.RecordsWritten);

        await store.CommitAsync(Snapshot("new", SessionHistory.Empty, 3, 1), SaveKind.Strict);
        Assert.Equal(0, backend.SegmentCount);
    }

    [Fact]
    public async Task A_loaded_owner_recognizes_its_records_and_a_new_lifetime_writes_all()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        await Append(store, history, Message(2, "two"));

        var cold = Open();
        var loaded = (await cold.LoadAsync("s"))!;
        backend.ResetCounters();
        await cold.CommitAsync(loaded with { Busy = true, BusyStartedAt = 5 }, SaveKind.Strict);
        Assert.Equal(0, backend.RecordsWritten);

        backend.ResetCounters();
        var child = Open("child");
        var suffix = Message(3, "child");
        await child.CommitCanonicalAppendAsync(
            Snapshot("child", loaded.History.AppendJson([suffix]), 4),
            [suffix]
        );
        Assert.Equal(3, backend.RecordsWritten);
    }
}
