using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests;

/// <summary>
/// The Session authority contract every representation implements: the complete JSON document
/// of file mode and the head plus immutable segments of the hosted design. Each case observes
/// only the authority interfaces, so a later Postgres backend runs the same cases.
/// </summary>
public abstract class SessionAuthorityContractTests : IDisposable
{
    private protected readonly TempDirectory Temp = new();

    private protected abstract ISessionAuthorityBackend Backend { get; }

    /// <summary>The next commit fails after its Archive rows exist and before it commits.</summary>
    private protected abstract void FailNextCommit();

    public void Dispose() => Temp.Dispose();

    private ISessionAuthority Open(string id = "s") =>
        Backend.Open(id, "main", new SessionAuthorityCallbacks());

    [Fact]
    public async Task A_missing_authority_reads_as_absent()
    {
        Assert.False(Backend.Exists("s"));
        Assert.Null(Backend.ReadEnvelope("s", "main"));
        Assert.Null(await Backend.ReadRawAsync("s"));
        Assert.Null(await Open().LoadAsync("s"));
    }

    [Fact]
    public async Task A_strict_commit_round_trips_the_authority_value()
    {
        var store = Open();
        var queued = SessionQueueJson.FromJson(
            new JsonObject
            {
                ["type"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "queued" }),
                ["futureQueue"] = "kept",
            }
        );
        var snapshot = Snapshot("s", History(Message(1, "one"), Message(2, "two")), 3) with
        {
            Queue = [queued],
            AuthorityEnvelope = new JsonObject { ["futureTop"] = new JsonArray("kept") },
        };
        await store.CommitAsync(snapshot, SaveKind.Strict);

        var loaded = (await Open().LoadAsync("s"))!;
        AssertSameValue(snapshot, loaded);
        Assert.True(Backend.Exists("s"));
        var envelope = Backend.ReadEnvelope("s", "main")!;
        Assert.Null(envelope["history"]);
        Assert.Equal(3, envelope["nextMessageSeq"]!.GetValue<long>());
        var raw = (await Backend.ReadRawAsync("s"))!;
        Assert.Equal(2, raw.Document!["history"]!.AsArray().Count);
        Assert.NotEmpty(raw.Locator);
    }

    [Fact]
    public async Task Canonical_appends_extend_history_and_record_Archive_rows()
    {
        var store = Open();
        var first = await Append(store, SessionHistory.Empty, Message(1, "one"));
        var second = await Append(store, first, Message(2, "two"));

        var loaded = (await Open().LoadAsync("s"))!;
        Assert.Equal(["one", "two"], Texts(loaded.History));
        Assert.Equal(second.Count, loaded.History.Count);
        Assert.Equal([1L, 2L], store.Archive.ReadMessages().Select(row => row.Seq));
    }

    [Fact]
    public async Task A_precommit_failure_keeps_the_previous_value_and_removes_its_Archive_rows()
    {
        var store = Open();
        var first = await Append(store, SessionHistory.Empty, Message(1, "one"));
        FailNextCommit();
        await Assert.ThrowsAnyAsync<IOException>(() => Append(store, first, Message(2, "two")));

        var loaded = (await Open().LoadAsync("s"))!;
        Assert.Equal(["one"], Texts(loaded.History));
        Assert.Equal([1L], store.Archive.ReadMessages().Select(row => row.Seq));
        // The same store continues from its last committed value.
        await Append(store, first, Message(2, "two again"));
        Assert.Equal(["one", "two again"], Texts((await Open().LoadAsync("s"))!.History));
    }

    [Fact]
    public async Task In_place_updates_and_removed_records_replace_the_stored_history()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        history = await Append(store, history, Message(3, "three"));

        history = history.Replace(2, HistoryMessage.FromJson(Message(3, "three, updated")));
        await store.CommitAsync(Snapshot("s", history, 4), SaveKind.Strict);
        history = SessionHistory.FromMessages(history.Skip(1).ToArray());
        await store.CommitAsync(Snapshot("s", history, 4, version: 1), SaveKind.Strict);

        var loaded = (await Open().LoadAsync("s"))!;
        Assert.Equal(["two", "three, updated"], Texts(loaded.History));
        Assert.Equal(1, loaded.HistoryVersion);
    }

    [Fact]
    public async Task Compaction_replaces_history_and_records_its_blocks()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        history = await Append(store, history, Message(3, "three"));

        var compacted = Snapshot(
            "s",
            SessionHistory.FromMessages([history[2]]),
            4,
            version: 1
        ) with
        {
            AuthorityEnvelope = new JsonObject { ["nextBlockId"] = 2 },
        };
        await store.CommitCompactionAsync(compacted, [Block("s", 1, 2)], []);

        var loaded = (await Open().LoadAsync("s"))!;
        Assert.Equal(["three"], Texts(loaded.History));
        Assert.Equal(2, loaded.AuthorityEnvelope["nextBlockId"]!.GetValue<long>());
        Assert.Equal("summary", Assert.Single(store.Archive.ReadBlocks()).Summary);
        Assert.Equal(3, store.Archive.ReadMessages().Count);
    }

    [Fact]
    public async Task A_cleared_history_keeps_the_sequence_and_accepts_later_appends()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        await store.CommitAsync(Snapshot("s", SessionHistory.Empty, 3, version: 1), SaveKind.Strict);
        Assert.Empty((await Open().LoadAsync("s"))!.History);

        await Append(store, SessionHistory.Empty, Message(3, "after clear"), version: 1);
        var loaded = (await Open().LoadAsync("s"))!;
        Assert.Equal(["after clear"], Texts(loaded.History));
        Assert.Equal(4, loaded.NextMessageSeq);
        Assert.Equal(3, store.Archive.ReadMessages().Count);
    }

    [Fact]
    public async Task A_fork_child_owns_its_authority_while_sharing_the_parent_records()
    {
        var parent = Open("parent");
        var history = await Append(
            parent,
            SessionHistory.Empty,
            Message(1, "one"),
            id: "parent"
        );
        history = await Append(parent, history, Message(2, "two"), id: "parent");

        var child = Open("child");
        var suffix = Message(3, "child only");
        await child.CommitCanonicalAppendAsync(
            Snapshot("child", history.AppendJson([suffix]), 4),
            [suffix]
        );
        Assert.Equal(
            ["one", "two", "child only"],
            Texts((await Open("child").LoadAsync("child"))!.History)
        );

        Backend.DeleteAuthority("child");
        Assert.False(Backend.Exists("child"));
        Assert.Equal(["one", "two"], Texts((await Open("parent").LoadAsync("parent"))!.History));
    }

    [Fact]
    public async Task An_identity_move_keeps_the_value_under_the_new_identity()
    {
        var store = Open("old");
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"), id: "old");
        Backend.MoveIdentity("old", "new");
        // Recovery may replay a move whose source is gone.
        Backend.MoveIdentity("old", "new");
        store.RebindIdentity("new", "main");
        await store.PersistIdentitySnapshotAsync(Snapshot("new", history, 2));

        Assert.False(Backend.Exists("old"));
        Assert.Equal("new", store.SessionId);
        var loaded = (await Open("new").LoadAsync("new"))!;
        Assert.Equal(["one"], Texts(loaded.History));
        await Append(store, history, Message(2, "after move"), id: "new");
        Assert.Equal(["one", "after move"], Texts((await Open("new").LoadAsync("new"))!.History));
    }

    [Fact]
    public async Task A_raw_replacement_stores_the_edited_document_as_given()
    {
        var store = Open();
        await Append(store, SessionHistory.Empty, Message(1, "one"));
        var raw = (JsonObject)(await Backend.ReadRawAsync("s"))!.Document!;
        raw["aliases"] = new JsonArray("previous");
        raw["futureField"] = "kept";
        Backend.ReplaceRaw("s", raw);

        Assert.True(JsonNode.DeepEquals(raw, (await Backend.ReadRawAsync("s"))!.Document));
        Assert.Equal(["one"], Texts((await Open().LoadAsync("s"))!.History));
    }

    [Fact]
    public async Task Deletion_removes_the_authority_and_reports_each_stage()
    {
        var store = Open();
        await store.CommitAsync(Snapshot("s", SessionHistory.Empty, 1), SaveKind.Strict);
        var stages = new List<string>();
        Backend.DeleteAuthority("s", () => stages.Add("authority"));
        Backend.DeleteLegacyArtifacts("s", () => stages.Add("legacy"));
        Assert.Equal(["authority", "legacy"], stages);
        Assert.False(Backend.Exists("s"));
        Assert.Null(await Open().LoadAsync("s"));
        Backend.DeleteAuthority("s");
        Backend.DeleteLegacyArtifacts("s");
    }

    [Fact]
    public async Task A_missing_authority_with_Archive_rows_is_unavailable_not_empty()
    {
        await Append(Open(), SessionHistory.Empty, Message(1, "one"));
        Backend.DeleteAuthority("s");
        await Assert.ThrowsAsync<SessionAuthorityUnavailableException>(() =>
            Open().LoadAsync("s")
        );
    }

    [Fact]
    public async Task A_retired_store_rejects_writes()
    {
        var store = Open();
        store.Retire();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.CommitAsync(Snapshot("s", SessionHistory.Empty, 1), SaveKind.Strict)
        );
        Assert.False(Backend.Exists("s"));
    }

    internal static async Task<SessionHistory> Append(
        ISessionAuthority store,
        SessionHistory history,
        JsonObject message,
        long version = 0,
        string id = "s"
    )
    {
        var next = history.AppendJson([message]);
        var seq = message["__meta"]!["seq"]!.GetValue<long>();
        await store.CommitCanonicalAppendAsync(Snapshot(id, next, seq + 1, version), [message]);
        return next;
    }

    internal static SessionSnapshot Snapshot(
        string id,
        SessionHistory history,
        long nextSeq,
        long version = 0
    ) =>
        new(
            id,
            history,
            [],
            false,
            null,
            false,
            new JsonObject { ["lastMessageTime"] = 1000, ["messageCount"] = history.Count },
            nextSeq,
            version,
            new JsonObject()
        );

    internal static SessionHistory History(params JsonObject[] messages) =>
        SessionHistory.FromJson(messages);

    internal static JsonObject Message(long seq, string text) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = 1000 + seq },
        };

    internal static IEnumerable<string> Texts(SessionHistory history) =>
        history.Select(message => message.ToJson()["parts"]![0]!["text"]!.GetValue<string>());

    private static ArchiveBlockRecord Block(string id, long first, long last) =>
        new(
            id,
            "main",
            1,
            1,
            "message",
            first,
            last,
            null,
            first,
            last,
            1000 + first,
            1000 + last,
            "summary",
            null,
            1000
        );

    // The authority value: the validated state plus the history records, as file mode stores it.
    private static void AssertSameValue(SessionSnapshot expected, SessionSnapshot actual)
    {
        static JsonObject Value(SessionSnapshot snapshot)
        {
            var state = SessionAuthorityCodec.PrepareState(snapshot, snapshot.Id, "main", null);
            state["history"] = new JsonArray(
                snapshot.History.Select(message => (JsonNode)message.ToJson()).ToArray()
            );
            return state;
        }
        // Property order is a representation detail; the value is what must survive.
        var (left, right) = (Value(expected), Value(actual));
        Assert.True(JsonNode.DeepEquals(left, right), left + "\n" + right);
    }
}

public sealed class FileSessionAuthorityContractTests : SessionAuthorityContractTests
{
    private bool failNext;

    public FileSessionAuthorityContractTests() =>
        Backend = new FileStorageContext(
            Temp.Path,
            new(
                AuthorityStageHook: (_, stage) =>
                {
                    if (failNext && stage == AtomicJsonWriteStage.BeforeRename)
                    {
                        failNext = false;
                        throw new IOException("Injected failure before the authority rename.");
                    }
                }
            )
        ).Authority;

    private protected override ISessionAuthorityBackend Backend { get; }

    private protected override void FailNextCommit() => failNext = true;
}

public sealed class SegmentedSessionAuthorityContractTests : SessionAuthorityContractTests
{
    private readonly SegmentedAuthorityBackend backend;

    public SegmentedSessionAuthorityContractTests() => backend = new(Temp.Path);

    private protected override ISessionAuthorityBackend Backend => backend;

    private protected override void FailNextCommit() => backend.FailNextCommit = true;
}
