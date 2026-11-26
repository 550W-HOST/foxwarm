using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using static Foxwarm.Tests.SessionAuthorityContractTests;

namespace Foxwarm.Tests;

/// <summary>
/// What a head-plus-segments authority rewrites per commit: the storage design's reason to
/// prefer it over whole-document saves in the hosted mode. Callers still pass complete
/// snapshots; the store derives the delta from record identity with the shared
/// <see cref="SessionSegmentPlanner"/>. Every segmented representation runs these cases.
/// </summary>
public abstract class SegmentedAuthorityCountTests : IDisposable
{
    private protected readonly TempDirectory Temp = new();

    private protected abstract ISessionAuthorityBackend Segmented { get; }

    /// <summary>Head writes and records written since the last reset, and the stored segments.</summary>
    private protected abstract SegmentedAuthorityCounters Counts { get; }

    public virtual void Dispose() => Temp.Dispose();

    private ISessionAuthority Open(string id = "s") =>
        Segmented.Open(id, "main", new SessionAuthorityCallbacks());

    [Fact]
    public async Task The_stored_value_equals_the_file_document_after_the_same_commits()
    {
        using var fileRoot = new TempDirectory();
        var file = new Foxwarm.Storage.FileStorageContext(fileRoot.Path).Authority;
        foreach (var target in new ISessionAuthorityBackend[] { file, Segmented })
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
        var actual = (await Segmented.ReadRawAsync("s"))!.Document;
        Assert.True(JsonNode.DeepEquals(expected, actual), expected + "\n" + actual);
    }

    [Fact]
    public async Task Saves_without_history_changes_write_only_the_head()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        Counts.ResetCounters();

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
        Assert.Equal(1, Counts.HeadWrites);
        Assert.Equal(0, Counts.RecordsWritten);
    }

    [Fact]
    public async Task Appends_write_only_the_appended_records()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        Counts.ResetCounters();
        await Append(store, history, Message(3, "three"));
        Assert.Equal(1, Counts.RecordsWritten);
        Assert.Equal(3, Counts.SegmentCount);
    }

    [Fact]
    public async Task Changes_rewrite_from_the_segment_holding_the_first_changed_record()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        history = await Append(store, history, Message(3, "three"));

        Counts.ResetCounters();
        history = history.Replace(2, HistoryMessage.FromJson(Message(3, "retry notice")));
        await store.CommitAsync(Snapshot("s", history, 4), SaveKind.Strict);
        Assert.Equal(1, Counts.RecordsWritten);

        Counts.ResetCounters();
        history = history.Replace(0, HistoryMessage.FromJson(Message(1, "redacted")));
        await store.CommitAsync(Snapshot("s", history, 4), SaveKind.Strict);
        Assert.Equal(3, Counts.RecordsWritten);
        Assert.Equal(1, Counts.SegmentCount);
    }

    [Fact]
    public async Task Clear_deletes_segments_and_identity_moves_rewrite_none()
    {
        var store = Open("old");
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"), id: "old");
        history = await Append(store, history, Message(2, "two"), id: "old");

        Counts.ResetCounters();
        Segmented.MoveIdentity("old", "new");
        store.RebindIdentity("new", "main");
        await store.PersistIdentitySnapshotAsync(Snapshot("new", history, 3));
        Assert.Equal(0, Counts.RecordsWritten);

        await store.CommitAsync(Snapshot("new", SessionHistory.Empty, 3, 1), SaveKind.Strict);
        Assert.Equal(0, Counts.SegmentCount);
    }

    [Fact]
    public async Task A_loaded_owner_recognizes_its_records_and_a_new_lifetime_writes_all()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        await Append(store, history, Message(2, "two"));

        var cold = Open();
        var loaded = (await cold.LoadAsync("s"))!;
        Counts.ResetCounters();
        await cold.CommitAsync(loaded with { Busy = true, BusyStartedAt = 5 }, SaveKind.Strict);
        Assert.Equal(0, Counts.RecordsWritten);

        Counts.ResetCounters();
        var child = Open("child");
        var suffix = Message(3, "child");
        await child.CommitCanonicalAppendAsync(
            Snapshot("child", loaded.History.AppendJson([suffix]), 4),
            [suffix]
        );
        Assert.Equal(3, Counts.RecordsWritten);
    }
}

/// <summary>The counts a segmented backend under test reports.</summary>
internal abstract class SegmentedAuthorityCounters
{
    internal abstract int HeadWrites { get; }
    internal abstract int RecordsWritten { get; }
    internal abstract int SegmentCount { get; }

    internal abstract void ResetCounters();
}

public sealed class SegmentedSessionAuthorityTests : SegmentedAuthorityCountTests
{
    private readonly SegmentedAuthorityBackend memory;

    public SegmentedSessionAuthorityTests()
    {
        memory = new(Temp.Path);
        Counts = new Counters(memory);
    }

    private protected override ISessionAuthorityBackend Segmented => memory;

    private protected override SegmentedAuthorityCounters Counts { get; }

    private sealed class Counters(SegmentedAuthorityBackend memory) : SegmentedAuthorityCounters
    {
        internal override int HeadWrites => memory.HeadWrites;
        internal override int RecordsWritten => memory.RecordsWritten;
        internal override int SegmentCount => memory.SegmentCount;

        internal override void ResetCounters() => memory.ResetCounters();
    }
}
